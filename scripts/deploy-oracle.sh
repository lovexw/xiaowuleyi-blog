#!/usr/bin/env bash
# 甲骨文 ARM 自托管实例的自动部署脚本：GitHub main → 本机 Docker → 容器热替换
#
# 用法（在服务器的 /opt/xwblog-app 仓库内执行，也可由 systemd 定时器调用）：
#   ./scripts/deploy-oracle.sh            有更新就部署；已是最新则直接退出
#   ./scripts/deploy-oracle.sh --force    不管有没有更新，重建并重启
#   ./scripts/deploy-oracle.sh --dry-run  只报告是否有新提交，不动任何东西
#   ./scripts/deploy-oracle.sh --status   打印各实例的容器 / 镜像 / 状态
#
# 设计要点（改脚本前请先读完）：
# 1. 服务器上的代码目录是「只读镜像」：每次部署都 `git reset --hard origin/main`。
#    在服务器上手改的内容会被丢掉——这是刻意的，否则两台机器各改一半就再也对不上了。
#    要改代码请改 GitHub 仓库。
# 2. 数据全部在各实例的 DATA_DIR（默认 /opt/xwblog-data），与代码目录完全分离。
#    reset / build / 重建容器都不会碰 blog.db 与 uploads。
# 3. 镜像按 commit 打 tag（xwblog:sha-xxxxxxx），健康检查失败自动回滚到上一个镜像。
# 4. 部署失败的 commit 记进 last-failed，定时器不会反复重试同一个坏 commit（避免
#    每 2 分钟重启一次容器），修好推新提交即可；要强行重试加 --force。
# 5. 健康检查必须带 Host 头：应用按域名路由，不带 Host 访问会 404。
# 6. 多实例：一台机器可以跑多个站点（例如 blog.xiaowuleyi.com + blog.btchao.com）。
#    INSTANCES 用「容器|绑定地址|健康检查域名|数据目录」描述，分号分隔多个；
#    一次 git reset + 一次 docker build，再逐个替换容器——镜像共用，省时省磁盘。
#    某个实例健康检查失败只回滚它自己，不影响其它实例。
# 7. 改「这个脚本自己」时注意：一次部署里脚本先 `git reset` 再继续往下跑，而 bash 读的是
#    打开时那个 inode（git reset 换的是新文件）——所以**本次部署执行的仍是旧版脚本**，
#    脚本改动要等下一次部署才生效。2026-11-05 实测：给 start_container 加
#    `-e TRUST_PROXY=cf` 的那次提交上线后，容器里根本没这个变量，手动
#    `./scripts/deploy-oracle.sh --force` 重跑一次才补上。改完 env / 启动参数，
#    推完要么 `--force` 跑一轮，要么等下一个提交顺带把它带上去。

set -euo pipefail

APP_DIR=${APP_DIR:-/opt/xwblog-app}
DATA_DIR=${DATA_DIR:-/opt/xwblog-data}
CONTAINER=${CONTAINER:-xwblog-next}
BRANCH=${BRANCH:-main}
BIND_ADDR=${BIND_ADDR:-127.0.0.1:8788}
HEALTH_HOST=${HEALTH_HOST:-blog.xiaowuleyi.com}
KEEP_IMAGES=${KEEP_IMAGES:-3}
STATE_DIR=${STATE_DIR:-/opt/xwblog-deploy/state}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-40}

# 实例清单：容器名|绑定地址|健康检查域名|数据目录，分号分隔；留空则用上面单实例三件套。
# 手动执行时没有 systemd 注入的环境变量，这里回退去读同一个单元里的 INSTANCES，
# 免得手动 --status / --force 时只看到一个实例、和定时器行为不一致。
INSTANCES=${INSTANCES:-}
if [ -z "$INSTANCES" ]; then
  INSTANCES=$(systemctl show -p Environment --value xwblog-deploy.service 2>/dev/null |
    tr ' ' '\n' | sed -n 's/^INSTANCES=//p' | head -1 || true)
fi
INSTANCES=${INSTANCES:-"${CONTAINER}|${BIND_ADDR}|${HEALTH_HOST}|${DATA_DIR}"}
IFS=';' read -ra INSTANCE_LIST <<<"$INSTANCES"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "错误：$*"; exit 1; }
warn() { log "警告：$*"; }

# ---------- 可选的 Cloudflare 边缘缓存清理（部署成功后调用） ----------
# 前台 JS 已按内容哈希版本化（src/assets.ts），改前端不再需要强刷；但 HTML 本身在 CF
# 边缘还缓存 300 秒，旧副本里的 ?v= 仍指向上一版。配上这个文件后每次部署顺手清一次，
# 新页面立刻生效；没配就等边缘副本自然过期（最多 5 分钟），完全不影响部署。
# 配置文件放在服务器本地 state 目录、不进 git：
#   CF_API_TOKEN=<具备 Zone / Cache Purge / Purge 权限的令牌>
#   CF_ZONE_IDS=<zone_id1>,<zone_id2>
# 注意：本函数任何失败都只记警告，绝不把已经成功的部署翻成失败（脚本 set -euo pipefail）。
purge_edge_cache() {
  local conf="$STATE_DIR/cf-purge.env"
  [ -f "$conf" ] || return 0
  # shellcheck disable=SC1091
  . "$conf" || { warn "CF 清缓存配置读取失败，跳过"; return 0; }
  local token=${CF_API_TOKEN:-} zones=${CF_ZONE_IDS:-}
  if [ -z "$token" ] || [ -z "$zones" ]; then
    warn "CF 清缓存配置不完整（需 CF_API_TOKEN / CF_ZONE_IDS），跳过"
    return 0
  fi
  local zone ok=0 total=0 body
  for zone in ${zones//,/ }; do
    total=$((total + 1))
    body=$(curl -sS --max-time 15 -X POST \
      -H "Authorization: Bearer $token" \
      -H 'Content-Type: application/json' \
      --data '{"purge_everything":true}' \
      "https://api.cloudflare.com/client/v4/zones/$zone/purge_cache" 2>/dev/null) || body=''
    case "$body" in
      *'"success":true'*|*'"success": true'*) ok=$((ok + 1)) ;;
      *) warn "zone $zone 清缓存未成功（多半是令牌缺 Cache Purge 权限），不影响本次部署" ;;
    esac
  done
  log "Cloudflare 边缘缓存清理：$ok/$total 个 zone 成功"
  return 0
}

# ---------- 参数 ----------
mode=deploy
case ${1:-} in
  '') ;;
  --force) mode=force ;;
  --dry-run) mode=dry ;;
  --status) mode=status ;;
  -h | --help)
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *) die "未知参数 ${1}（可用：--force / --dry-run / --status）" ;;
esac

# ---------- 前置检查 ----------
[ -d "$APP_DIR/.git" ] || die "$APP_DIR 不是 git 仓库，无法自动部署"
command -v git >/dev/null || die "未找到 git"
command -v curl >/dev/null || die "未找到 curl"

# docker 可能需要 sudo（当前用户不在 docker 组时）
if docker ps -q >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo -n docker ps -q >/dev/null 2>&1; then
  DOCKER=(sudo -n docker)
else
  die "无法执行 docker（既不在 docker 组，也没有免密 sudo）"
fi

# 状态目录可能在 /opt 下（root 属主）：先试着直接建，不行就用免密 sudo 建好再改名归属，
# 这样脚本在「刚 clone 完还没跑过 install」的机器上也能一次跑通
if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  sudo -n mkdir -p "$STATE_DIR" 2>/dev/null &&
    sudo -n chown "$(id -u):$(id -g)" "$STATE_DIR" 2>/dev/null ||
    die "无法创建状态目录 $STATE_DIR（需要 sudo 权限）"
fi

# 同一时间只允许一个部署任务，避免定时器与手工部署打架
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "另一个部署任务正在运行，本次跳过"; exit 0; }

git_in() { git -C "$APP_DIR" "$@"; }
last_failed() { cat "$STATE_DIR/last-failed" 2>/dev/null || true; }
last_good() { cat "$STATE_DIR/last-good" 2>/dev/null || true; }

# ---------- 实例解析 ----------
# 解析一条实例描述，结果放进 C_NAME / C_ADDR / C_HOST / C_DATA / C_PORT，
# 之后所有容器操作都针对「当前实例」，循环里逐条切换即可。
parse_instance() {
  local spec=$1
  IFS='|' read -r C_NAME C_ADDR C_HOST C_DATA <<<"$spec"
  [ -n "${C_NAME:-}" ] && [ -n "${C_ADDR:-}" ] && [ -n "${C_HOST:-}" ] && [ -n "${C_DATA:-}" ] ||
    die "实例描述格式不对：$spec（应为 容器|绑定地址|健康域名|数据目录）"
  C_PORT=${C_ADDR##*:}
}

# 前置校验：每个实例的数据目录都要有 tenants.json（应用启动即需要）
for _spec in "${INSTANCE_LIST[@]}"; do
  [ -n "$_spec" ] || continue
  parse_instance "$_spec"
  [ -f "$C_DATA/tenants.json" ] || die "实例 $C_NAME 缺少租户配置 $C_DATA/tenants.json"
done
unset _spec

container_field() { # $1=inspect 格式，作用于当前实例
  ${DOCKER[@]} inspect -f "$1" "$C_NAME" 2>/dev/null || true
}

health() { # 检查当前实例
  local i code
  for ((i = 1; i <= HEALTH_TIMEOUT; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Host: $C_HOST" \
      "http://127.0.0.1:${C_PORT}/" 2>/dev/null || true)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  log "健康检查超时（${HEALTH_TIMEOUT}s，$C_NAME 最后一次 HTTP $code）"
  return 1
}

start_container() { # $1=镜像 $2=commit，作用于当前实例
  local img=$1 sha=$2
  ${DOCKER[@]} rm -f "$C_NAME" >/dev/null 2>&1 || true
  # TRUST_PROXY=cf：链路是 CF 橙云 → 本机 openresty(80) → 容器，openresty 用
  # `$proxy_add_x_forwarded_for` 把「CF 边缘 IP」追加到 XFF 末尾，而默认档 proxy 取末跳
  # → 访客 IP 变成 172.7x 的 CF 边缘地址（全站共用一个限流桶、TG 登录告警里的 IP 也是它）。
  # CF 会强制写入 CF-Connecting-IP，且 80 端口已用 iptables `CF_ONLY` 只放行 CF 回源段
  # （直连伪造那个头进不来），所以取 cf 档：只认 CF 写的头，其余转发头一律丢弃。
  ${DOCKER[@]} run -d --name "$C_NAME" --restart unless-stopped \
    -p "${C_ADDR}:8787" \
    -v "${C_DATA}:/data/tenants" \
    -v "${C_DATA}/tenants.json:/app/docker-poc/tenants.json:ro" \
    -e NODE_ENV=production \
    -e PORT=8787 \
    -e TENANTS_DIR=/data/tenants \
    -e TENANTS_CONFIG=/app/docker-poc/tenants.json \
    -e PUBLIC_ROOT=/app/public \
    -e OPS_LOG_PATH=/data/tenants/ops.log \
    -e TRUST_PROXY=cf \
    --label "xwblog.sha=${sha}" \
    "$img" >/dev/null
}

prune_images() {
  ${DOCKER[@]} image prune -f >/dev/null 2>&1 || true
  local old
  old=$(${DOCKER[@]} images --filter 'reference=xwblog:sha-*' \
    --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}' |
    sort -r | tail -n +$((KEEP_IMAGES + 1)) | cut -d'|' -f2)
  if [ -n "$old" ]; then
    while IFS= read -r img; do
      [ -n "$img" ] || continue
      ${DOCKER[@]} rmi "$img" >/dev/null 2>&1 || true
      log "清理旧镜像 $img"
    done <<<"$old"
  fi
}

# ---------- --status ----------
if [ "$mode" = status ]; then
  echo "代码目录   : $APP_DIR"
  echo "当前提交   : $(git_in rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "提交说明   : $(git_in log -1 --format=%s 2>/dev/null || echo '?')"
  echo "上次成功   : $(last_good)"
  echo "上次失败   : $(last_failed)"
  for _spec in "${INSTANCE_LIST[@]}"; do
    [ -n "$_spec" ] || continue
    parse_instance "$_spec"
    echo
    echo "── 实例 $C_NAME ──"
    echo "  监听     : $C_ADDR（健康检查 Host: $C_HOST）"
    echo "  数据目录 : $C_DATA"
    echo "  容器镜像 : $(container_field '{{.Config.Image}}')"
    echo "  容器提交 : $(container_field '{{index .Config.Labels "xwblog.sha"}}')"
    echo "  容器状态 : $(container_field '{{.State.Status}}')  启动于 $(container_field '{{.State.StartedAt}}')"
    echo "  健康检查 : $(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Host: $C_HOST" "http://127.0.0.1:${C_PORT}/" 2>/dev/null || echo '-')"
  done
  echo
  echo "可用镜像   :"
  ${DOCKER[@]} images --filter 'reference=xwblog:sha-*' --format '  {{.Tag}}  {{.CreatedAt}}  {{.Size}}' | head -6
  exit 0
fi

# ---------- 比对远端 ----------
log "检查 origin/$BRANCH …"
git_in fetch --quiet --prune origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" ||
  die "拉取失败（检查网络或仓库地址）"

target=$(git_in rev-parse "origin/${BRANCH}")
short=${target:0:7}

# 只有所有实例都跑在 target 上才算「已是最新」
pending=()
for _spec in "${INSTANCE_LIST[@]}"; do
  [ -n "$_spec" ] || continue
  parse_instance "$_spec"
  _sha=$(container_field '{{index .Config.Labels "xwblog.sha"}}')
  _state=$(container_field '{{.State.Status}}')
  if [ "$mode" = force ] || [ "$_sha" != "$target" ] || [ "$_state" != running ]; then
    pending+=("$C_NAME")
  fi
done
unset _spec

if [ ${#pending[@]} -eq 0 ]; then
  log "所有实例已是最新提交 $short，无需部署"
  exit 0
fi
if [ "$mode" = deploy ] && [ "$(last_failed)" = "$target" ]; then
  log "提交 $short 上次部署失败，跳过本次（修好后推新提交，或加 --force 重试）"
  exit 0
fi
if [ "$mode" = dry ]; then
  log "有新提交：本地 $(git_in rev-parse --short HEAD) → 远端 $short"
  log "待更新实例：${pending[*]}（--dry-run 不做任何改动）"
  exit 0
fi

# ---------- 构建（所有实例共用同一个镜像） ----------
log "更新代码到 $short（服务器上的手改内容会被丢弃）"
git_in reset --hard --quiet "$target"

img="xwblog:sha-${short}"
if ${DOCKER[@]} image inspect "$img" >/dev/null 2>&1; then
  log "镜像 $img 已存在，跳过构建"
else
  log "构建镜像 $img（ARM 原生构建，通常 1–3 分钟）"
  if ! ${DOCKER[@]} build -f "$APP_DIR/docker-poc/Dockerfile" -t "$img" "$APP_DIR" \
    >"$STATE_DIR/build.log" 2>&1; then
    tail -n 25 "$STATE_DIR/build.log" || true
    echo "$target" >"$STATE_DIR/last-failed"
    die "构建失败，容器保持原状（完整日志 $STATE_DIR/build.log）"
  fi
  log "构建完成 $(${DOCKER[@]} image inspect -f '{{.Size}}' "$img" | awk '{printf "%.0f MB", $1/1024/1024}')"
fi

# ---------- 逐实例替换容器 ----------
failed=()
for _spec in "${INSTANCE_LIST[@]}"; do
  [ -n "$_spec" ] || continue
  parse_instance "$_spec"

  cur_sha=$(container_field '{{index .Config.Labels "xwblog.sha"}}')
  cur_state=$(container_field '{{.State.Status}}')
  if [ "$mode" != force ] && [ "$cur_sha" = "$target" ] && [ "$cur_state" = running ]; then
    log "实例 $C_NAME 已在 $short，跳过"
    continue
  fi

  prev_img=$(container_field '{{.Config.Image}}')
  prev_sha=$cur_sha
  log "替换实例 $C_NAME（预计中断 2–5 秒）"
  start_container "$img" "$target"

  if health; then
    log "实例 $C_NAME 部署成功：$img 已接管 $C_ADDR"
    continue
  fi

  # 只回滚当前实例，其它实例不受影响
  log "实例 $C_NAME 新版本不健康，开始回滚"
  ${DOCKER[@]} logs --tail 40 "$C_NAME" 2>&1 || true
  if [ -n "$prev_img" ] && ${DOCKER[@]} image inspect "$prev_img" >/dev/null 2>&1; then
    start_container "$prev_img" "${prev_sha:-unknown}"
    if health; then
      log "实例 $C_NAME 已回滚到 $prev_img（${prev_sha:-unknown}），站点已恢复"
    else
      log "实例 $C_NAME 回滚后仍不健康，请人工介入：${DOCKER[@]} logs $C_NAME"
    fi
  else
    warn "实例 $C_NAME 没有可回滚的旧镜像，当前可能不可用"
  fi
  failed+=("$C_NAME")
done
unset _spec

if [ ${#failed[@]} -eq 0 ]; then
  echo "$target" >"$STATE_DIR/last-good"
  rm -f "$STATE_DIR/last-failed"
  log "部署成功：$img 已覆盖全部实例（$(git_in log -1 --format=%s)）"
  purge_edge_cache
  prune_images
  exit 0
fi

echo "$target" >"$STATE_DIR/last-failed"
log "以下实例部署失败：${failed[*]}（其余实例正常）"
exit 1

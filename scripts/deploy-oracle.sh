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
# 8. 蓝绿切换（2026-11-10）：实例描述的第 5 段填 `上游名:备用端口` 后，替换容器不再
#    「先停后起」——新容器起在备用端口，健康检查过了才把 nginx 上游指过去并 reload，
#    等排空窗口过后才停旧容器。中间层任何时刻都有一个活着的上游，用户看不到 502/超时。
#    前置条件（一次性配置，脚本不会自动改 nginx）：
#      a. conf.d 里有上游文件，一行一条，形如
#         upstream xwblog_main { server 127.0.0.1:8788; }
#         脚本用 sed 改其中的端口，写成多行会失配。
#      b. 站点 conf 的 proxy_pass 指向 http://xwblog_main 而不是写死端口。
#    第 5 段留空则完全退回旧的「停旧起新」，老机器不改也能跑。
# 9. 蓝绿期间新旧容器会并存约 DRAIN_SECONDS 秒，共用同一个 DATA_DIR/blog.db。能这么干
#    的前提是 docker-poc/shims/d1.ts 已设 PRAGMA journal_mode=WAL + busy_timeout=5000：
#    写写之间是排队等锁，而不是立刻抛 SQLITE_BUSY。这两条不在就别开蓝绿。

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
# 蓝绿：切到新上游后等多久再停旧容器（秒）。在途请求是毫秒级，3 秒足够排空；
# 有大文件上传正在进行时想更稳就调大。
DRAIN_SECONDS=${DRAIN_SECONDS:-3}
# nginx 上游配置文件（见设计要点 8）。容器名留空则按名字自动探测 openresty。
UPSTREAM_FILE=${UPSTREAM_FILE:-/opt/1panel/apps/openresty/openresty/conf/conf.d/00-xwblog-upstreams.conf}
NGINX_CONTAINER=${NGINX_CONTAINER:-}

# 实例清单：容器名|绑定地址|健康检查域名|数据目录[|上游名:备用端口]，分号分隔；留空则用上面单实例三件套。
# 第 5 段是可选开关，填了就走蓝绿切换（见设计要点 8），不填照旧停旧起新。
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
# 第 5 段 `上游名[:备用端口]` 落进 C_UP / C_ALT_PORT；留空表示不走蓝绿。
parse_instance() {
  local spec=$1
  C_UP='' C_ALT_PORT=''
  IFS='|' read -r C_NAME C_ADDR C_HOST C_DATA C_BG <<<"$spec"
  [ -n "${C_NAME:-}" ] && [ -n "${C_ADDR:-}" ] && [ -n "${C_HOST:-}" ] && [ -n "${C_DATA:-}" ] ||
    die "实例描述格式不对：$spec（应为 容器|绑定地址|健康域名|数据目录[|上游名:备用端口]）"
  C_PORT=${C_ADDR##*:}
  if [ -n "${C_BG:-}" ]; then
    C_UP=${C_BG%%:*}
    C_ALT_PORT=${C_BG##*:}
    # 只写了上游名没写端口：备用端口默认取 port+1（8788→8789、8790→8791）
    if [ "$C_ALT_PORT" = "$C_UP" ]; then C_ALT_PORT=$((C_PORT + 1)); fi
    # 注意别写成 `[ ... ] && die`：条件为假时这是函数最后一条命令，函数会返回 1，
    # 调用处的 set -e 直接把整个部署退掉（2026-11-10 踩过，--status 连一行都没打印）。
    if [ "$C_ALT_PORT" = "$C_PORT" ]; then
      die "实例 $C_NAME 的备用端口不能等于主端口 $C_PORT（$C_BG）"
    fi
  fi
}

# 前置校验：每个实例的数据目录都要有 tenants.json（应用启动即需要）
for _spec in "${INSTANCE_LIST[@]}"; do
  [ -n "$_spec" ] || continue
  parse_instance "$_spec"
  [ -f "$C_DATA/tenants.json" ] || die "实例 $C_NAME 缺少租户配置 $C_DATA/tenants.json"
done
unset _spec

container_field() { # $1=inspect 格式 [$2=容器名，默认当前实例]
  ${DOCKER[@]} inspect -f "$1" "${2:-$C_NAME}" 2>/dev/null || true
}

container_exists() { # $1=容器名
  ${DOCKER[@]} inspect -f '{{.Id}}' "$1" >/dev/null 2>&1
}

port_in_use() { # $1=端口；备用口被别的服务占着时提前失败，别等容器起不来才发现
  ss -tlnH 2>/dev/null |
    awk -v p=":$1" '{ for (i = 1; i <= NF; i++) if ($i ~ (p "$")) { found = 1; exit } } END { exit found ? 0 : 1 }'
}

health() { # [$1=端口，默认当前实例端口]
  local port=${1:-$C_PORT} i code='-'
  for ((i = 1; i <= HEALTH_TIMEOUT; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Host: $C_HOST" \
      "http://127.0.0.1:${port}/" 2>/dev/null || true)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  log "健康检查超时（${HEALTH_TIMEOUT}s，$C_NAME@$port 最后一次 HTTP $code）"
  return 1
}

# ---------- 蓝绿切换用的小工具 ----------
nginx_container() {
  if [ -n "$NGINX_CONTAINER" ]; then
    printf '%s' "$NGINX_CONTAINER"
    return 0
  fi
  local names
  names=$(${DOCKER[@]} ps --format '{{.Names}}' 2>/dev/null || true)
  printf '%s\n' "$names" | awk 'tolower($0) ~ /openresty/ { print; exit }'
}

upstream_port() { # 打印当前实例在上游配置里指向的端口；查不到输出空
  [ -f "$UPSTREAM_FILE" ] || return 0
  sudo -n awk -v u="$C_UP" '
    $1 == "upstream" && $2 == u { inside = 1 }
    inside && /server/ {
      for (i = 1; i <= NF; i++)
        if ($i ~ /^127\.0\.0\.1:[0-9]+;?$/) {
          sub(/^127\.0\.0\.1:/, "", $i); sub(/;$/, "", $i); print $i; exit
        }
    }
    inside && /\}/ { exit }
  ' "$UPSTREAM_FILE" 2>/dev/null
}

set_upstream_port() { # $1=端口；只改当前实例那一行里的端口号，改完回读校验
  local port=$1
  sudo -n sed -i -E \
    "s|^(upstream[[:space:]]+${C_UP}[[:space:]]*\{[[:space:]]*server[[:space:]]+127\.0\.0\.1:)[0-9]+|\1${port}|" \
    "$UPSTREAM_FILE" 2>/dev/null || return 1
  [ "$(upstream_port)" = "$port" ]
}

reload_nginx() { # 先 -t 再 reload；-t 失败就把错误打出来，别静默
  local c out
  c=$(nginx_container)
  if [ -z "$c" ]; then
    warn "没找到 openresty 容器，无法重载 nginx（可用 NGINX_CONTAINER 指定容器名）"
    return 1
  fi
  if ! out=$(sudo -n docker exec "$c" openresty -t 2>&1); then
    log "nginx 配置校验失败："
    printf '%s\n' "$out" | tail -5
    return 1
  fi
  sudo -n docker exec "$c" openresty -s reload >/dev/null 2>&1 || return 1
  log "nginx 已重载（$c）"
}

start_container() { # $1=镜像 $2=commit [$3=容器名] [$4=绑定地址]
  local img=$1 sha=$2 name=${3:-$C_NAME} addr=${4:-$C_ADDR}
  ${DOCKER[@]} rm -f "$name" >/dev/null 2>&1 || true
  # TRUST_PROXY=cf：链路是 CF 橙云 → 本机 openresty(80) → 容器，openresty 用
  # `$proxy_add_x_forwarded_for` 把「CF 边缘 IP」追加到 XFF 末尾，而默认档 proxy 取末跳
  # → 访客 IP 变成 172.7x 的 CF 边缘地址（全站共用一个限流桶、TG 登录告警里的 IP 也是它）。
  # CF 会强制写入 CF-Connecting-IP，且 80 端口已用 iptables `CF_ONLY` 只放行 CF 回源段
  # （直连伪造那个头进不来），所以取 cf 档：只认 CF 写的头，其余转发头一律丢弃。
  ${DOCKER[@]} run -d --name "$name" --restart unless-stopped \
    -p "${addr}:8787" \
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
    --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
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
    _live=$C_PORT
    if [ -n "$C_UP" ]; then
      _up=$(upstream_port)
      if [ -n "$_up" ]; then _live=$_up; fi
    fi
    echo
    echo "── 实例 $C_NAME ──"
    echo "  监听     : $C_ADDR（健康检查 Host: $C_HOST）"
    echo "  数据目录 : $C_DATA"
    if [ -n "$C_UP" ]; then
      echo "  流量入口 : 上游 $C_UP → 127.0.0.1:${_live}（蓝绿备用 ${C_ALT_PORT}）"
    else
      echo "  流量入口 : 直连 $C_ADDR（未配蓝绿，替换容器会中断 2–5 秒）"
    fi
    echo "  容器镜像 : $(container_field '{{.Config.Image}}')"
    echo "  容器提交 : $(container_field '{{index .Config.Labels "xwblog.sha"}}')"
    echo "  容器状态 : $(container_field '{{.State.Status}}')  启动于 $(container_field '{{.State.StartedAt}}')"
    echo "  健康检查 : $(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Host: $C_HOST" "http://127.0.0.1:${_live}/" 2>/dev/null || echo '-')"
  done
  unset _spec _live _up
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
# 老路子：原端口上「停旧起新」，中间断 2–5 秒。没配蓝绿的实例仍走这条。
replace_in_place() { # $1=镜像 $2=commit；0=成功 1=需人工/已回滚
  local img=$1 sha=$2 prev_img prev_sha
  prev_img=$(container_field '{{.Config.Image}}')
  prev_sha=$(container_field '{{index .Config.Labels "xwblog.sha"}}')
  log "替换实例 $C_NAME（预计中断 2–5 秒）"
  start_container "$img" "$sha"

  if health; then
    log "实例 $C_NAME 部署成功：$img 已接管 $C_ADDR"
    return 0
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
  return 1
}

# 蓝绿：新容器起在备用端口 → 健康检查 → 改上游 → reload → 排空 → 停旧容器并改名。
# 关键性质：任何一步失败都只是「新容器被删掉」，旧容器从头到尾没停过，用户无感。
replace_blue_green() { # $1=镜像 $2=commit；0=成功 1=已放弃（旧版仍在服务）
  local img=$1 sha=$2 active target incoming="${C_NAME}-incoming" bak

  active=$(upstream_port)
  if [ -z "$active" ]; then
    warn "上游 $C_UP 不在 $UPSTREAM_FILE 里，本实例退回「停旧起新」"
    replace_in_place "$img" "$sha"
    return $?
  fi
  if [ "$active" = "$C_PORT" ]; then target=$C_ALT_PORT; else target=$C_PORT; fi

  # 上次如果死在 rename 之前，${C_NAME}-incoming 就是线上服务者：直接认领，别当垃圾删了
  if container_exists "$incoming"; then
    if [ "$(container_field '{{.State.Status}}' "$incoming")" = running ] && ! container_exists "$C_NAME"; then
      log "发现上次遗留的 $incoming 仍在服务，先认领为 $C_NAME"
      ${DOCKER[@]} rename "$incoming" "$C_NAME" || true
    else
      ${DOCKER[@]} rm -f "$incoming" >/dev/null 2>&1 || true
    fi
  fi

  if port_in_use "$target"; then
    warn "备用端口 $target 被占用，本实例退回「停旧起新」"
    replace_in_place "$img" "$sha"
    return $?
  fi

  log "蓝绿切换实例 $C_NAME：上游 $C_UP $(printf '%s' "$active") → $target"
  start_container "$img" "$sha" "$incoming" "127.0.0.1:${target}"

  if ! health "$target"; then
    log "实例 $C_NAME 新版本在 $target 上不健康，已丢弃；旧容器原样继续服务（用户无感）"
    ${DOCKER[@]} logs --tail 40 "$incoming" 2>&1 || true
    ${DOCKER[@]} rm -f "$incoming" >/dev/null 2>&1 || true
    return 1
  fi

  bak="$STATE_DIR/upstream-${C_UP}.bak"
  if ! sudo -n cp "$UPSTREAM_FILE" "$bak" 2>/dev/null; then
    warn "备份上游配置失败，放弃切换（旧容器继续服务）"
    ${DOCKER[@]} rm -f "$incoming" >/dev/null 2>&1 || true
    return 1
  fi
  if ! set_upstream_port "$target"; then
    warn "改写上游配置失败，放弃切换（旧容器继续服务）"
    sudo -n cp "$bak" "$UPSTREAM_FILE" >/dev/null 2>&1 || true
    ${DOCKER[@]} rm -f "$incoming" >/dev/null 2>&1 || true
    return 1
  fi
  if ! reload_nginx; then
    warn "nginx 未接受新上游，回滚配置（旧容器继续服务）"
    sudo -n cp "$bak" "$UPSTREAM_FILE" >/dev/null 2>&1 || true
    reload_nginx >/dev/null 2>&1 || warn "回滚后 nginx 重载仍失败，请人工 ./scripts/deploy-oracle.sh --status"
    ${DOCKER[@]} rm -f "$incoming" >/dev/null 2>&1 || true
    return 1
  fi

  log "上游已切到 $target，等 ${DRAIN_SECONDS}s 排空在途请求"
  sleep "$DRAIN_SECONDS"
  if container_exists "$C_NAME"; then
    ${DOCKER[@]} stop -t 20 "$C_NAME" >/dev/null 2>&1 || true
    ${DOCKER[@]} rm "$C_NAME" >/dev/null 2>&1 || true
  fi
  if ! ${DOCKER[@]} rename "$incoming" "$C_NAME" >/dev/null 2>&1; then
    warn "重命名 $incoming → $C_NAME 失败：容器仍在运行并监听 $target，下次部署会自动认领"
  fi
  log "实例 $C_NAME 部署成功：$img 已接管 127.0.0.1:$target（切换期间无中断）"
  return 0
}

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

  if [ -n "$C_UP" ]; then
    replace_blue_green "$img" "$target" || failed+=("$C_NAME")
  else
    replace_in_place "$img" "$target" || failed+=("$C_NAME")
  fi
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

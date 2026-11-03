#!/usr/bin/env bash
# 甲骨文 ARM 自托管实例的自动部署脚本：GitHub main → 本机 Docker → 容器热替换
#
# 用法（在服务器的 /opt/xwblog-app 仓库内执行，也可由 systemd 定时器调用）：
#   ./scripts/deploy-oracle.sh            有更新就部署；已是最新则直接退出
#   ./scripts/deploy-oracle.sh --force    不管有没有更新，重建并重启
#   ./scripts/deploy-oracle.sh --dry-run  只报告是否有新提交，不动任何东西
#   ./scripts/deploy-oracle.sh --status   打印当前容器 / 镜像 / 状态文件
#
# 设计要点（改脚本前请先读完）：
# 1. 服务器上的代码目录是「只读镜像」：每次部署都 `git reset --hard origin/main`。
#    在服务器上手改的内容会被丢掉——这是刻意的，否则两台机器各改一半就再也对不上了。
#    要改代码请改 GitHub 仓库。
# 2. 数据全部在 DATA_DIR（默认 /opt/xwblog-data），与代码目录完全分离。
#    reset / build / 重建容器都不会碰 blog.db 与 uploads。
# 3. 镜像按 commit 打 tag（xwblog:sha-xxxxxxx），健康检查失败自动回滚到上一个镜像。
# 4. 部署失败的 commit 记进 last-failed，定时器不会反复重试同一个坏 commit（避免
#    每 2 分钟重启一次容器），修好推新提交即可；要强行重试加 --force。
# 5. 健康检查必须带 Host 头：应用按域名路由，不带 Host 访问会 404。

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

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
die() { log "错误：$*"; exit 1; }
warn() { log "警告：$*"; }

# ---------- 参数 ----------
mode=deploy
case ${1:-} in
  '') ;;
  --force) mode=force ;;
  --dry-run) mode=dry ;;
  --status) mode=status ;;
  -h | --help)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *) die "未知参数 ${1}（可用：--force / --dry-run / --status）" ;;
esac

# ---------- 前置检查 ----------
[ -d "$APP_DIR/.git" ] || die "$APP_DIR 不是 git 仓库，无法自动部署"
[ -f "$DATA_DIR/tenants.json" ] || die "缺少租户配置 $DATA_DIR/tenants.json"
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

mkdir -p "$STATE_DIR" 2>/dev/null || die "无法创建状态目录 $STATE_DIR"

# 同一时间只允许一个部署任务，避免定时器与手工部署打架
exec 9>"$STATE_DIR/lock"
flock -n 9 || { log "另一个部署任务正在运行，本次跳过"; exit 0; }

git_in() { git -C "$APP_DIR" "$@"; }
port=${BIND_ADDR##*:}
last_failed() { cat "$STATE_DIR/last-failed" 2>/dev/null || true; }
last_good() { cat "$STATE_DIR/last-good" 2>/dev/null || true; }

container_field() {
  ${DOCKER[@]} inspect -f "$1" "$CONTAINER" 2>/dev/null || true
}

health() {
  local i code
  for ((i = 1; i <= HEALTH_TIMEOUT; i++)); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Host: $HEALTH_HOST" \
      "http://127.0.0.1:${port}/" 2>/dev/null || true)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  log "健康检查超时（${HEALTH_TIMEOUT}s，最后一次 HTTP $code）"
  return 1
}

start_container() { # $1=镜像 $2=commit
  local img=$1 sha=$2
  ${DOCKER[@]} rm -f "$CONTAINER" >/dev/null 2>&1 || true
  ${DOCKER[@]} run -d --name "$CONTAINER" --restart unless-stopped \
    -p "${BIND_ADDR}:8787" \
    -v "${DATA_DIR}:/data/tenants" \
    -v "${DATA_DIR}/tenants.json:/app/docker-poc/tenants.json:ro" \
    -e NODE_ENV=production \
    -e PORT=8787 \
    -e TENANTS_DIR=/data/tenants \
    -e TENANTS_CONFIG=/app/docker-poc/tenants.json \
    -e PUBLIC_ROOT=/app/public \
    -e OPS_LOG_PATH=/data/tenants/ops.log \
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
  echo "容器镜像   : $(container_field '{{.Config.Image}}')"
  echo "容器提交   : $(container_field '{{index .Config.Labels "xwblog.sha"}}')"
  echo "容器状态   : $(container_field '{{.State.Status}}')  启动于 $(container_field '{{.State.StartedAt}}')"
  echo "监听       : $BIND_ADDR"
  echo "健康检查   : $(curl -s -o /dev/null -w '%{http_code}' -m 5 -H "Host: $HEALTH_HOST" "http://127.0.0.1:${port}/" 2>/dev/null || echo '-')"
  echo "上次成功   : $(last_good)"
  echo "上次失败   : $(last_failed)"
  echo "可用镜像   :"
  ${DOCKER[@]} images --filter 'reference=xwblog:sha-*' --format '  {{.Tag}}  {{.CreatedAt}}  {{.Size}}' | head -6
  exit 0
fi

# ---------- 比对远端 ----------
log "检查 origin/$BRANCH …"
git_in fetch --quiet --prune origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" ||
  die "拉取失败（检查网络或仓库地址）"

target=$(git_in rev-parse "origin/${BRANCH}")
running_sha=$(container_field '{{index .Config.Labels "xwblog.sha"}}')
running_state=$(container_field '{{.State.Status}}')
short=${target:0:7}

if [ "$mode" != force ] && [ "$running_sha" = "$target" ] && [ "$running_state" = running ]; then
  log "已是最新提交 $short，无需部署"
  exit 0
fi
if [ "$mode" = deploy ] && [ "$(last_failed)" = "$target" ]; then
  log "提交 $short 上次部署失败，跳过本次（修好后推新提交，或加 --force 重试）"
  exit 0
fi
if [ "$mode" = dry ]; then
  log "有新提交：本地 $(git_in rev-parse --short HEAD) → 远端 $short"
  log "（--dry-run 不做任何改动）"
  exit 0
fi

# ---------- 构建 ----------
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

# ---------- 替换容器 ----------
prev_img=$(container_field '{{.Config.Image}}')
prev_sha=$(container_field '{{index .Config.Labels "xwblog.sha"}}')
log "停止并用新镜像启动容器（预计中断 2–5 秒）"
start_container "$img" "$target"

if health; then
  echo "$target" >"$STATE_DIR/last-good"
  rm -f "$STATE_DIR/last-failed"
  log "部署成功：$img 已接管 $BIND_ADDR（$(git_in log -1 --format=%s)）"
  prune_images
  exit 0
fi

# ---------- 回滚 ----------
log "新版本不健康，开始回滚"
${DOCKER[@]} logs --tail 40 "$CONTAINER" 2>&1 || true
if [ -n "$prev_img" ] && ${DOCKER[@]} image inspect "$prev_img" >/dev/null 2>&1; then
  start_container "$prev_img" "${prev_sha:-unknown}"
  if health; then
    log "已回滚到 $prev_img（${prev_sha:-unknown}），站点已恢复"
  else
    log "回滚后仍不健康，请人工介入：${DOCKER[@]} logs $CONTAINER"
  fi
else
  warn "没有可回滚的旧镜像，容器当前可能不可用"
fi
echo "$target" >"$STATE_DIR/last-failed"
exit 1

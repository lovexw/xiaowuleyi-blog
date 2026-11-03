#!/usr/bin/env bash
# 从树莓派备份还原 xwblog 全站
#
#   sudo ./restore.sh --list                 列出可用快照
#   sudo ./restore.sh --verify [快照]        只校验完整性，不写任何文件
#   sudo ./restore.sh --to-server [快照]     还原到本机（当作一台全新的甲骨文/云服务器）
#   sudo ./restore.sh --local   [快照]       在树莓派本机跑起来（灾备模式，绑定 18788/18790）
#
# 附加参数：--dry-run 只打印不执行
#           --force   目标已存在时覆盖
#           --keep-running  --local 验证后不停止容器
#
# 默认快照为 latest 指向的那份。
set -Eeuo pipefail

ROOT=/data/backup/xwblog
SNAP_DIR="$ROOT/snapshots"
IMG_DIR="$ROOT/images"

MODE=""
TARGET=""
DRY=0
FORCE=0
KEEP=0

die()  { printf '\033[31m错误：\033[0m%s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$*"; }
run()  { if [ "$DRY" -eq 1 ]; then printf '  [dry] %s\n' "$*"; else "$@"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --list)         MODE=list ;;
    --verify)       MODE=verify ;;
    --to-server)    MODE=server ;;
    --local)        MODE=local ;;
    --dry-run)      DRY=1 ;;
    --force)        FORCE=1 ;;
    --keep-running) KEEP=1 ;;
    -h|--help)      sed -n '2,15p' "$0"; exit 0 ;;
    -*)             die "未知参数 $1" ;;
    *)              TARGET="$1" ;;
  esac
  shift
done

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo $0"
[ -n "$MODE" ] || die "请指定模式：--list / --verify / --to-server / --local"

resolve_snapshot() {
  local s="${1:-}"
  if [ -z "$s" ]; then
    [ -e "$ROOT/latest" ] || die "没有 latest 指针，请指定快照名（--list 查看）"
    s=$(readlink -f "$ROOT/latest")
  elif [ -d "$SNAP_DIR/$s" ]; then
    s="$SNAP_DIR/$s"
  fi
  [ -d "$s" ] || die "快照不存在：$s"
  [ -f "$s/.complete" ] || die "快照不完整（缺 .complete）：$s"
  readlink -f "$s"
}

# ---------------- 列快照 ----------------
if [ "$MODE" = list ]; then
  printf '%-22s %-12s %-10s %s\n' 快照 commit 占用 完成时间
  printf '%-22s %-12s %-10s %s\n' ---- ------ ---- --------
  while IFS= read -r d; do
    [ -f "$d/.complete" ] || continue
    n=$(basename "$d")
    c=$(sed -n 's/^git_commit=//p' "$d/.complete")
    t=$(sed -n 's/^finished_at=//p' "$d/.complete")
    sz=$(du -sh "$d" 2>/dev/null | cut -f1)
    printf '%-22s %-12s %-10s %s\n' "$n" "${c:-?}" "$sz" "$t"
  done < <(find "$SNAP_DIR" -maxdepth 1 -mindepth 1 -type d -name '20*' | sort -r)
  echo
  echo "镜像：" ; ls -lh "$IMG_DIR"/*.tar.gz 2>/dev/null | awk '{print "  "$9" ("$5")"}' || echo "  （无）"
  echo "仓库合计：$(du -sh "$SNAP_DIR" 2>/dev/null | cut -f1)"
  exit 0
fi

S=$(resolve_snapshot "$TARGET")
SNAME=$(basename "$S")
info "使用快照 $SNAME"
sed 's/^/  /' "$S/.complete"

# ---------------- 校验 ----------------
info "校验数据完整性"
fail=0
for pair in "blog.xiaowuleyi.com.db:blog_db_sha256" "blog.btchao.com.db:btchao_db_sha256"; do
  f=${pair%%:*}; k=${pair##*:}
  want=$(sed -n "s/^${k}=//p" "$S/server/meta/state.env" 2>/dev/null || true)
  got=$(sha256sum "$S/server/db/$f" 2>/dev/null | cut -d' ' -f1 || true)
  if [ -z "$got" ]; then warn "缺少 $f"; fail=1
  elif [ -n "$want" ] && [ "$want" != "$got" ]; then warn "$f 哈希不匹配（备份可能损坏）"; fail=1
  else ok "$f ${got:0:12}"; fi
  if [ -n "$got" ]; then
    ck=$(sqlite3 "$S/server/db/$f" 'pragma integrity_check;' 2>&1 | head -1)
    [ "$ck" = ok ] && ok "$f integrity=ok" || { warn "$f integrity=$ck"; fail=1; }
  fi
done

nup=$(find "$S/data/blog/uploads" -type f 2>/dev/null | wc -l)
nbt=$(find "$S/data/btchao" -type f 2>/dev/null | wc -l)
[ "$nup" -gt 0 ] && ok "博客附件 $nup 个" || { warn "博客附件为空"; fail=1; }
[ "$nbt" -gt 0 ] && ok "btchao 附件 $nbt 个" || warn "btchao 附件为空"
[ -d "$S/code/xwblog-app/.git" ] && ok "代码仓库含 .git" || warn "代码仓库缺 .git（不影响运行，但没法接着部署）"

[ "$fail" -eq 0 ] && info "校验通过" || die "校验未通过，拒绝还原"
[ "$MODE" = verify ] && exit 0

# ---------------- 目标路径 ----------------
if [ "$MODE" = server ]; then
  DATA_ROOT=/opt
  BLOG_DATA=/opt/xwblog-data
  BTCHAO_DATA=/opt/btchao-blog
  APP_DIR=/opt/xwblog-app
  PORT_BLOG=8788
  PORT_BTCHAO=8790
else
  DATA_ROOT=/data/xwblog-runtime
  BLOG_DATA=$DATA_ROOT/xwblog-data
  BTCHAO_DATA=$DATA_ROOT/btchao-blog
  APP_DIR=$DATA_ROOT/xwblog-app
  PORT_BLOG=18788
  PORT_BTCHAO=18790
fi

command -v docker >/dev/null || die "本机没有 docker"
ARCH=$(uname -m)
info "架构 $ARCH，目标目录 $DATA_ROOT"

# ---------------- 恢复数据 ----------------
restore_data() {
  info "恢复数据到 $BLOG_DATA"
  run mkdir -p "$BLOG_DATA/blog.xiaowuleyi.com/uploads" \
                "$BTCHAO_DATA/data/blog.btchao.com/uploads"

  # 附件
  if [ "$FORCE" -eq 1 ] || [ ! "$(ls -A "$BLOG_DATA/blog.xiaowuleyi.com/uploads" 2>/dev/null)" ]; then
    run rsync -a --info=stats2 "$S/data/blog/uploads/" "$BLOG_DATA/blog.xiaowuleyi.com/uploads/"
    ok "博客附件就位"
  else
    warn "目标已有附件，跳过（--force 可覆盖）"
  fi

  if [ "$FORCE" -eq 1 ] || [ ! "$(ls -A "$BTCHAO_DATA/data/blog.btchao.com/uploads" 2>/dev/null)" ]; then
    run rsync -a --info=stats2 "$S/data/btchao/" "$BTCHAO_DATA/data/"
    ok "btchao 数据就位"
  else
    warn "目标已有 btchao 数据，跳过（--force 可覆盖）"
  fi

  # 数据库：用快照覆盖，清掉可能残留的 WAL
  run install -m 644 "$S/server/db/blog.xiaowuleyi.com.db" "$BLOG_DATA/blog.xiaowuleyi.com/blog.db"
  run rm -f "$BLOG_DATA/blog.xiaowuleyi.com/blog.db-wal" "$BLOG_DATA/blog.xiaowuleyi.com/blog.db-shm"
  run install -m 644 "$S/server/db/blog.btchao.com.db" "$BTCHAO_DATA/data/blog.btchao.com/blog.db"
  run rm -f "$BTCHAO_DATA/data/blog.btchao.com/blog.db-wal" "$BTCHAO_DATA/data/blog.btchao.com/blog.db-shm"

  # tenants.json —— 缺了容器直接起不来
  if [ -f "$S/server/config/tenants/xwblog.json" ]; then
    run install -m 644 "$S/server/config/tenants/xwblog.json" "$BLOG_DATA/tenants.json"
  else
    warn "备份里没有 xwblog 的 tenants.json"
  fi
  if [ -f "$S/server/config/tenants/btchao.json" ]; then
    run install -m 644 "$S/server/config/tenants/btchao.json" "$BTCHAO_DATA/data/tenants.json"
  fi

  # 属主：容器内 node 以 root 跑，这里统一给 1000 以免宿主机权限错乱
  run chown -R 1000:1000 "$BLOG_DATA" "$BTCHAO_DATA" 2>/dev/null || true
}
restore_data

# ---------------- 恢复代码 ----------------
if [ -d "$S/code/xwblog-app" ]; then
  info "恢复代码仓库到 $APP_DIR"
  run mkdir -p "$APP_DIR"
  run rsync -a --delete "$S/code/xwblog-app/" "$APP_DIR/"
  run git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  ok "代码就位（$(git -c safe.directory='*' -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')）"
fi

# ---------------- 镜像 ----------------
info "准备应用镜像"
IMG_TAG=$(sed -n 's/^image=//p' "$S/.complete")
[ -n "$IMG_TAG" ] || IMG_TAG="xwblog:restored"
SAFE=$(echo "$IMG_TAG" | tr '/:' '__')
if docker image inspect "$IMG_TAG" >/dev/null 2>&1; then
  ok "本机已有镜像 $IMG_TAG"
elif [ -f "$IMG_DIR/${SAFE}.tar.gz" ]; then
  info "载入镜像 $(basename "$IMG_DIR/${SAFE}.tar.gz")"
  run bash -c "gzip -dc '$IMG_DIR/${SAFE}.tar.gz' | docker load"
  ok "镜像已载入"
elif [ -f "$APP_DIR/docker-poc/Dockerfile" ]; then
  warn "没有镜像包，从 Dockerfile 现场构建（较慢）"
  run docker build -t "$IMG_TAG" "$APP_DIR/docker-poc"
else
  die "既没有镜像包也没有 Dockerfile，无法启动"
fi

# ---------------- 启动容器 ----------------
start_one() {  # start_one <名称> <宿主端口> <数据目录> <tenants路径>
  local name=$1 port=$2 datadir=$3 tjson=$4
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    if [ "$FORCE" -eq 1 ]; then
      warn "移除已存在的容器 $name"
      run docker rm -f "$name" >/dev/null
    else
      warn "容器 $name 已存在，跳过（--force 可重建）"
      return 0
    fi
  fi
  info "启动 $name → 127.0.0.1:$port"
  run docker run -d --name "$name" --restart unless-stopped \
    -p "127.0.0.1:$port:8787" \
    -v "$datadir:/data/tenants" \
    -v "$tjson:/app/docker-poc/tenants.json" \
    -e PORT=8787 \
    -e TENANTS_DIR=/data/tenants \
    -e TENANTS_CONFIG=/app/docker-poc/tenants.json \
    -e PUBLIC_ROOT=/app/public \
    -e OPS_LOG_PATH=/data/tenants/ops.log \
    -e NODE_ENV=production \
    "$IMG_TAG" >/dev/null
}

# 从 tenants.json 取租户域名：只认带点的域名形态，避免匹配到 "demo" 这类单词
tenant_host() {
  grep -oE '"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}"' "$1" 2>/dev/null | head -1 | tr -d '"'
}
HB=$(tenant_host "$BLOG_DATA/tenants.json")
HB=${HB:-blog.xiaowuleyi.com}
HBT=$(tenant_host "$BTCHAO_DATA/data/tenants.json")
HBT=${HBT:-blog.btchao.com}
info "租户域名：$HB / $HBT"

start_one xwblog-restored    "$PORT_BLOG"   "$BLOG_DATA"   "$BLOG_DATA/tenants.json"
start_one btchao-restored    "$PORT_BTCHAO" "$BTCHAO_DATA/data" "$BTCHAO_DATA/data/tenants.json"

# ---------------- 健康检查 ----------------
if [ "$DRY" -eq 1 ]; then
  info "预览结束，未实际启动"
  exit 0
fi

info "健康检查（最多等 40 秒）"
check() {
  local port=$1 host=$2 path=$3 tries=0
  while [ $tries -lt 20 ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H "Host: $host" "http://127.0.0.1:$port$path" 2>/dev/null || echo 000)
    [ "$code" = 200 ] && { ok "$path → 200 ($host)"; return 0; }
    tries=$((tries+1)); sleep 2
  done
  warn "$path → $code（$host），容器可能还在初始化"
  docker logs --tail 15 "$4" 2>&1 | sed 's/^/      /' || true
  return 1
}

rc=0
check "$PORT_BLOG" "$HB" / xwblog-restored || rc=1
check "$PORT_BLOG" "$HB" /admin/ xwblog-restored || rc=1
check "$PORT_BTCHAO" "$HBT" / btchao-restored || rc=1

if [ "$rc" -eq 0 ]; then
  info "还原成功，两个站都返回 200"
  # 数据库内容抽查
  n=$(docker exec xwblog-restored sh -c 'ls /data/tenants' 2>/dev/null | head -3 | tr '\n' ' ')
  ok "容器内数据目录：$n"
else
  warn "有站点未通过检查，见上方日志"
fi

if [ "$MODE" = local ] && [ "$KEEP" -eq 0 ]; then
  info "灾备演练结束，停止临时容器（加 --keep-running 可保留）"
  docker rm -f xwblog-restored btchao-restored >/dev/null 2>&1 || true
  ok "已清理"
elif [ "$MODE" = local ]; then
  info "容器保留运行：http://127.0.0.1:$PORT_BLOG  和  :$PORT_BTCHAO"
  echo "  配 Cloudflare Tunnel 指向这两个端口即可对外"
fi

[ "$rc" -eq 0 ] || exit 1

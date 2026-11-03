#!/usr/bin/env bash
# 甲骨文服务器端：生成可备份视图
# 目的：把「运行中的状态」整理成「静态可直接 rsync 的目录」
# 关键：sqlite 用 .backup 出一致性快照，避免 rsync 抓到半写的 db + 未合并的 WAL
set -euo pipefail

BASE=/opt/xwblog-backup
DATA=/opt/xwblog-data
BTCHAO=/opt/btchao-blog
APP=/opt/xwblog-app
LOG="$BASE/snapshot.log"

mkdir -p "$BASE"/{db,config,meta}
touch "$LOG"
chmod 640 "$LOG"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

# ---------- 1. 数据库一致性快照 ----------
snap_db() {
  local src="$1" dst="$2" label="$3"
  if [ ! -f "$src" ]; then
    log "跳过 $label：源库不存在 ($src)"
    return 0
  fi
  # .backup 会自己处理 WAL，产出单文件干净副本
  if ! sqlite3 "$src" ".backup '$dst.tmp'" 2>>"$LOG"; then
    log "失败 $label：.backup 出错，保留上一次快照"
    rm -f "$dst.tmp"
    return 1
  fi
  local chk
  chk=$(sqlite3 "$dst.tmp" "pragma integrity_check;" 2>&1 | head -1)
  if [ "$chk" != "ok" ]; then
    log "失败 $label：integrity_check=$chk"
    rm -f "$dst.tmp"
    return 1
  fi
  mv -f "$dst.tmp" "$dst"
  chmod 644 "$dst"
  log "完成 $label：$(du -h "$dst" | cut -f1)，integrity=ok"
}

snap_db "$DATA/blog.xiaowuleyi.com/blog.db"        "$BASE/db/blog.xiaowuleyi.com.db" "blog"
snap_db "$BTCHAO/data/blog.btchao.com/blog.db"     "$BASE/db/blog.btchao.com.db"     "btchao"

# ---------- 2. 配置收集 ----------
rm -rf "$BASE/config"
mkdir -p "$BASE/config"/{openresty,systemd,x-ui,hysteria,scripts,app,tenants}

# 反代站点配置
cp -a /opt/1panel/apps/openresty/openresty/conf/conf.d/*.conf "$BASE/config/openresty/" 2>/dev/null || true

# 自定义 systemd 单元（自动部署 / 限速）
for u in xwblog-deploy.service xwblog-deploy.timer xw-net-guard.service; do
  [ -f "/etc/systemd/system/$u" ] && cp -a "/etc/systemd/system/$u" "$BASE/config/systemd/"
done

# 3x-ui（含 REALITY 私钥，属敏感文件）
cp -a /etc/x-ui/x-ui.db "$BASE/config/x-ui/" 2>/dev/null || true

# hysteria（含证书私钥，属敏感文件）
cp -a /etc/hysteria/. "$BASE/config/hysteria/" 2>/dev/null || true

# 自制脚本
cp -a /usr/local/sbin/xw-net-guard.sh "$BASE/config/scripts/" 2>/dev/null || true

# 应用构建与部署脚本
cp -a "$APP/docker-poc/Dockerfile" "$BASE/config/app/" 2>/dev/null || true
cp -a "$APP/scripts/deploy-oracle.sh" "$BASE/config/app/" 2>/dev/null || true
mkdir -p "$BASE/config/app/systemd"
cp -a "$APP/deploy/systemd/." "$BASE/config/app/systemd/" 2>/dev/null || true

# 多租户配置（还原时必须放回容器挂载的位置，少了它容器起不来）
cp -a "$DATA/tenants.json"            "$BASE/config/tenants/xwblog.json" 2>/dev/null || true
cp -a "$BTCHAO/data/tenants.json"     "$BASE/config/tenants/btchao.json" 2>/dev/null || true

chmod -R go-rwx "$BASE/config" 2>/dev/null || true
log "配置已收集：$(find "$BASE/config" -type f | wc -l) 个文件"

# ---------- 3. 元信息 ----------
# 注意：本脚本以 root 运行，仓库属主是 ubuntu。git 会因 dubious ownership 拒绝，
# 所以以仓库属主身份调用；取不到就退化成 unknown，不阻断快照。
git_as_owner() { sudo -u "$(stat -c %U "$APP")" git -C "$APP" "$@" 2>/dev/null || echo unknown; }

COMMIT=$(git_as_owner rev-parse HEAD)
COMMIT_SHORT=$(git_as_owner rev-parse --short HEAD)
COMMIT_SUBJ=$(git_as_owner log -1 --format='%s')
IMAGE=$(docker ps --filter name=xwblog-next --format '{{.Image}}' 2>/dev/null | head -1)

{
  echo "snapshot_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "snapshot_at_local=$(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "host=$(hostname)"
  echo "os=$(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "arch=$(uname -m)"
  echo "git_commit=$COMMIT"
  echo "git_commit_short=$COMMIT_SHORT"
  echo "git_subject=$COMMIT_SUBJ"
  echo "image=$IMAGE"
  echo "mount_xwblog=$DATA"
  echo "mount_btchao=$BTCHAO"
  echo "blog_db_sha256=$(sha256sum "$BASE/db/blog.xiaowuleyi.com.db" 2>/dev/null | cut -d' ' -f1)"
  echo "btchao_db_sha256=$(sha256sum "$BASE/db/blog.btchao.com.db" 2>/dev/null | cut -d' ' -f1)"
} > "$BASE/meta/state.env.tmp"
mv -f "$BASE/meta/state.env.tmp" "$BASE/meta/state.env"

# 人类可读清单
{
  echo "=== xwblog 备份快照 ==="
  cat "$BASE/meta/state.env" | sed 's/^/  /'
  echo
  echo "=== 数据体积 ==="
  printf "  %-28s %s\n" "blog.db"        "$(du -h "$BASE/db/blog.xiaowuleyi.com.db" 2>/dev/null | cut -f1)"
  printf "  %-28s %s\n" "btchao blog.db" "$(du -h "$BASE/db/blog.btchao.com.db" 2>/dev/null | cut -f1)"
  printf "  %-28s %s\n" "blog uploads"   "$(du -sh "$DATA/blog.xiaowuleyi.com/uploads" 2>/dev/null | cut -f1)"
  printf "  %-28s %s\n" "btchao data"    "$(du -sh "$BTCHAO/data" 2>/dev/null | cut -f1)"
  echo
  echo "=== 附件统计 ==="
  printf "  %-28s %s\n" "blog 附件文件数" "$(find "$DATA/blog.xiaowuleyi.com/uploads" -type f 2>/dev/null | wc -l)"
  printf "  %-28s %s\n" "btchao 文件数"   "$(find "$BTCHAO/data" -type f 2>/dev/null | wc -l)"
} > "$BASE/meta/MANIFEST.txt"

# 供树莓派判断「有没有新东西」的指纹
cat "$BASE/meta/state.env" > "$BASE/meta/ready"

log "快照就绪：commit=$COMMIT_SHORT image=$IMAGE"

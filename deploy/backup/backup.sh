#!/usr/bin/env bash
# 在树莓派上执行（需 root）：从甲骨文拉取全站备份
#
# 设计要点
#   1. 只在树莓派跑，甲骨文不需要知道树莓派地址（家宽没有公网 IP）
#   2. rsync --link-dest 硬链接增量：每份快照目录看起来都是完整副本，实际只占新增文件
#   3. 数据库不直接拷运行中的文件，改用甲骨文侧 sqlite .backup 的一致性快照
#   4. 只有带 .complete 标记的快照才算有效，保留策略不会误删进行中的快照
#   5. 源端配 --rsync-path="sudo rsync"，因为配置目录里有 600 的私钥文件
#
# 用法：sudo /data/backup/xwblog/bin/backup.sh [--dry-run] [--full]
set -Eeuo pipefail

ROOT=/data/backup/xwblog
SNAP="$ROOT/snapshots"
REMOTE_HOST=ubuntu@167.234.216.40
SSH_KEY=/home/xiaowu/.ssh/oracle_backup
STAMP=$(date +%Y-%m-%dT%H%M)
DEST="$SNAP/$STAMP"
LOGDIR="$ROOT/logs"
LOG="$LOGDIR/backup-$(date +%Y%m).log"

DRY=0
FORCE_FULL=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --full)    FORCE_FULL=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行：sudo $0"; exit 1; }

mkdir -p "$SNAP" "$LOGDIR" "$ROOT/images"
touch "$LOG"
chmod 644 "$LOG"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }
die() { log "失败：$*"; exit 1; }

exec 9>"$ROOT/.lock"
flock -n 9 || die "已有备份进程在运行"

SSH_CMD=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15
         -o StrictHostKeyChecking=accept-new)

log "===== 备份开始 $STAMP ====="
"${SSH_CMD[@]}" "$REMOTE_HOST" 'echo ok' >/dev/null 2>&1 \
  || die "甲骨文不可达（检查网络或 $SSH_KEY）"

REMOTE_STATE=$("${SSH_CMD[@]}" "$REMOTE_HOST" 'sudo cat /opt/xwblog-backup/meta/state.env 2>/dev/null' || true)
[ -n "$REMOTE_STATE" ] || die "甲骨文上没有快照元信息，确认 xwblog-backup-snapshot.timer 在跑"
REMOTE_COMMIT=$(printf '%s\n' "$REMOTE_STATE" | sed -n 's/^git_commit_short=//p')
log "源站 commit=$REMOTE_COMMIT"

PREV_SNAP=""
if [ "$FORCE_FULL" -eq 0 ]; then
  PREV_SNAP=$(find "$SNAP" -maxdepth 1 -mindepth 1 -type d -name '20*' | sort | tail -1)
fi
log "基线：${PREV_SNAP:-无（本次全量）}"

RSYNC=(rsync -a --numeric-ids --partial --human-readable --stats --delete
       --rsync-path="sudo rsync"
       -e "ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
[ "$DRY" -eq 1 ] && RSYNC+=(-n)

mkdir -p "$DEST"

# 每个目录单独算 link-dest：rsync 是在「快照根 + 目标相对路径」下找同名文件，
# 所以必须指到上一份快照里结构相同的那个子目录，指到快照根永远匹配不上。
pull() {  # pull <标签> <远端路径> <相对路径> [额外参数...]
  local label="$1" src="$2" rel="$3"; shift 3
  local dst="$DEST/$rel"
  log "$label"
  [ "$DRY" -eq 1 ] || mkdir -p "$dst"

  local link=()
  if [ -n "$PREV_SNAP" ] && [ -d "$PREV_SNAP/$rel" ]; then
    link=("--link-dest=$PREV_SNAP/$rel")
  fi

  local out rc
  out=$(mktemp)
  set +e
  "${RSYNC[@]}" "${link[@]}" "$@" "$REMOTE_HOST:$src" "$dst" >"$out" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    sed 's/^/      /' "$out" | tee -a "$LOG" >&2
    rm -f "$out"
    die "$label 中止（rsync 退出码 $rc）"
  fi
  cat "$out" >> "$LOG"
  grep -E 'Number of (files|created files)|Total transferred file size' "$out" | sed 's/^/      /' | tee -a "$LOG" || true
  rm -f "$out"
}

# ---------- 1. 服务器整理的快照：db + 配置 + 元信息 ----------
pull "[1/5] 数据库快照与配置" /opt/xwblog-backup/ server

verify_db() {
  local file="$1" key="$2" want got
  if [ "$DRY" -eq 1 ]; then
    log "      预览模式，跳过校验 $file"
    return 0
  fi
  want=$(printf '%s\n' "$REMOTE_STATE" | sed -n "s/^${key}=//p")
  got=$(sha256sum "$DEST/server/db/$file" 2>/dev/null | cut -d' ' -f1 || true)
  [ -n "$got" ] || die "缺少数据库快照 $file"
  if [ -n "$want" ] && [ "$want" != "$got" ]; then
    die "库校验失败 $file（期望 ${want:0:12} 实际 ${got:0:12}）"
  fi
  log "      校验通过 $file ${got:0:12}"
}
verify_db blog.xiaowuleyi.com.db blog_db_sha256
verify_db blog.btchao.com.db    btchao_db_sha256

# ---------- 2~5. 数据与代码 ----------
pull "[2/5] 博客附件" /opt/xwblog-data/blog.xiaowuleyi.com/uploads/ data/blog/uploads

pull "[3/5] btchao 附件" /opt/btchao-blog/data/ data/btchao \
  --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm'

pull "[4/5] 代码仓库" /opt/xwblog-app/ code/xwblog-app

pull "[5/5] 历史清理备份" /opt/backup/ legacy/opt-backup

# ---------- Docker 镜像（按版本去重，只在换版本时存一份） ----------
IMAGES="$ROOT/images"
IMG_NAME=$(printf '%s\n' "$REMOTE_STATE" | sed -n 's/^image=//p')
if [ -z "$IMG_NAME" ]; then
  log "镜像：元信息里没有 image 字段，跳过（还原时可从 Dockerfile 重建）"
else
  SAFE=$(echo "$IMG_NAME" | tr '/:' '__')
  IMG_FILE="$IMAGES/${SAFE}.tar.gz"
  if [ -f "$IMG_FILE" ]; then
    log "镜像已存在，跳过：$(basename "$IMG_FILE")"
  elif [ "$DRY" -eq 1 ]; then
    log "镜像预览：将导出 $IMG_NAME"
  else
    log "导出镜像 $IMG_NAME（只在换版本时执行）"
    "${SSH_CMD[@]}" "$REMOTE_HOST" "sudo docker save '$IMG_NAME' | gzip -1" > "$IMG_FILE.tmp" \
      || { rm -f "$IMG_FILE.tmp"; die "镜像导出失败"; }
    [ -s "$IMG_FILE.tmp" ] || { rm -f "$IMG_FILE.tmp"; die "镜像导出为空"; }
    mv -f "$IMG_FILE.tmp" "$IMG_FILE"
    chmod 644 "$IMG_FILE"
    log "镜像已保存：$(du -h "$IMG_FILE" | cut -f1)"
    ls -1t "$IMAGES"/*.tar.gz 2>/dev/null | tail -n +4 | while read -r old; do
      log "清理旧镜像 $(basename "$old")"
      rm -f "$old"
    done
  fi
fi

# ---------- 完成标记 ----------
if [ "$DRY" -eq 0 ]; then
  {
    echo "snapshot=$STAMP"
    echo "git_commit=$REMOTE_COMMIT"
    echo "image=$IMG_NAME"
    echo "finished_at=$(date '+%F %T %Z')"
    echo "source_host=$REMOTE_HOST"
  } > "$DEST/.complete"
  cp -f "$DEST/server/meta/MANIFEST.txt" "$DEST/MANIFEST.txt" 2>/dev/null || true
  ln -sfn "$DEST" "$ROOT/latest"

  REAL=$(du -sh "$DEST" | cut -f1)
  APPARENT=$(du -sh --apparent-size "$DEST" | cut -f1)
  FILES=$(find "$DEST" -type f | wc -l)
  log "快照完成：$STAMP  实际占用 $REAL / 逻辑 $APPARENT / $FILES 个文件"
fi

# ---------- 保留策略：日备 30 天 + 每月 1 号长期保留 ----------
prune() {
  local cutoff day name removed=0 d
  cutoff=$(date -d '30 days ago' +%Y-%m-%d)
  while IFS= read -r d; do
    name=$(basename "$d")
    day=${name%%T*}
    [ -f "$d/.complete" ] || continue
    [ "$d" = "$DEST" ] && continue
    [ "$day" \< "$cutoff" ] || continue
    [ "${day:8:2}" = "01" ] && continue     # 每月 1 号长期保留
    log "轮转删除旧快照 $name"
    rm -rf "$d"
    removed=$((removed + 1))
  done < <(find "$SNAP" -maxdepth 1 -mindepth 1 -type d -name '20*' | sort)
  [ "$removed" -gt 0 ] && log "本轮删除 $removed 份旧快照"
  return 0
}
[ "$DRY" -eq 0 ] && prune

TOTAL=$(du -sh "$SNAP" 2>/dev/null | cut -f1)
COUNT=$(find "$SNAP" -maxdepth 1 -mindepth 1 -type d -name '20*' -exec test -f '{}/.complete' \; -print | wc -l)
DISK=$(df -h /data | tail -1 | awk '{print $4" 可用, "$5" 已用"}')
log "仓库合计 $TOTAL / $COUNT 份有效快照 / /data $DISK"
log "===== 备份结束 ====="

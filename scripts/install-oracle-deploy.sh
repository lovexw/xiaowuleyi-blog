#!/usr/bin/env bash
# 在甲骨文服务器上一键安装「GitHub main 自动部署」：装 systemd 单元、启用定时器。
# 需要 sudo（脚本会自己提权）。可重复执行，用于更新单元文件。
#
#   ./scripts/install-oracle-deploy.sh            安装/更新并启用
#   ./scripts/install-oracle-deploy.sh --uninstall 停用并移除定时器
#
# 安装后：
#   systemctl list-timers xwblog-deploy.timer     看下次检查时间
#   journalctl -u xwblog-deploy -f                看部署日志
#   ./scripts/deploy-oracle.sh --status           看当前版本与健康状态

set -euo pipefail

[ "$(id -u)" -eq 0 ] || exec sudo -n bash "$0" "$@"

APP_DIR=${APP_DIR:-/opt/xwblog-app}
STATE_DIR=${STATE_DIR:-/opt/xwblog-deploy/state}
DEPLOY_USER=${DEPLOY_USER:-ubuntu}
UNIT_DIR=/etc/systemd/system

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now xwblog-deploy.timer 2>/dev/null || true
  rm -f "$UNIT_DIR/xwblog-deploy.timer" "$UNIT_DIR/xwblog-deploy.service"
  systemctl daemon-reload
  echo "已移除自动部署定时器（容器与镜像保持原样，可用 scripts/deploy-oracle.sh 手动部署）"
  exit 0
fi

[ -f "$APP_DIR/deploy/systemd/xwblog-deploy.service" ] ||
  { echo "找不到 $APP_DIR/deploy/systemd/，请先在该目录 git pull 到最新"; exit 1; }
[ -x "$APP_DIR/scripts/deploy-oracle.sh" ] ||
  { echo "$APP_DIR/scripts/deploy-oracle.sh 不存在或不可执行"; exit 1; }

install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$(dirname "$STATE_DIR")"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 755 "$STATE_DIR"

install -m 644 "$APP_DIR/deploy/systemd/xwblog-deploy.service" "$UNIT_DIR/"
install -m 644 "$APP_DIR/deploy/systemd/xwblog-deploy.timer" "$UNIT_DIR/"

systemctl daemon-reload
systemctl enable --now xwblog-deploy.timer

echo "已启用 xwblog-deploy.timer："
systemctl list-timers xwblog-deploy.timer --no-pager | head -3
echo
echo "查看日志：journalctl -u xwblog-deploy -f"

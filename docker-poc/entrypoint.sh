#!/bin/sh
# xwblog POC 容器入口：以 root 起步修好数据卷属主，随即降权到 node(uid 1000) 跑应用。
#
# 为什么要这一步：Linux 服务器上 compose 首次 up 时，bind mount 的宿主目录由 Docker
# 以 root 创建，直接 USER node 会 EACCES；macOS 的 Docker Desktop 对 bind mount
# 权限宽松，本地测试测不出这个坑。做法与官方 postgres 镜像同款：root 只负责 chown，
# 应用进程始终以非 root 运行。
#
# 属主检查用 find -user（BSD/GNU/BusyBox 三家通吃）；顶层目录已属 node 时跳过
# 递归 chown——大图床（百万文件级）重启不做全量扫描。
set -e
# 容器必须绑 0.0.0.0 才能被端口映射转发（裸 Node 形态的回环默认在 server.ts 里，不冲突）
export HOST="${HOST:-0.0.0.0}"
DATA_DIR="${TENANTS_DIR:-/data/tenants}"
mkdir -p "$DATA_DIR"
# 注意不能用 find 判断属主：find 没匹配到也退出 0（退出码只反映操作错误，
# 不反映有没有找到），「! find -user node」永远为假——真机 bind mount（root 属主）
# 上 chown 会被跳过，容器崩溃循环 EACCES（甲骨文服务器实测踩过）。
# 用 stat 比对 uid：顶层不是 node 的（首次挂载/被 root 动过）才递归修，之后跳过，
# 百万文件级大图床重启不做全量扫描。BusyBox stat 兼容 alpine。
if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
  echo "[entrypoint] 修正数据卷属主 → node:node（仅首次或属主变化时递归）"
  chown -R node:node "$DATA_DIR" || echo "[entrypoint] chown 失败，仍尝试以 node 启动"
fi

# 顶层之外还要看上传子树：只要顶层属主是对的，上面那步就整段跳过；可若是某个子目录
# 被 root 动过（早期手工 docker exec、批量补图之类），node 往里面写就 EACCES，而这种情况
# 完全自愈不了。2026-11-05 图片传不上去就是这么挂的——uploads/u/202611 属主是 root，
# 其余月份目录都是 node。这里逐级 stat 到月份目录（每租户每月一个，数量很小），
# 命中才递归那一个子树，仍然不做全量扫描。
fix_owner() {
  target="$1"
  if [ ! -d "$target" ]; then return 0; fi
  if [ "$(stat -c %u "$target")" = "$(id -u node)" ]; then return 0; fi
  echo "[entrypoint] 修正属主 → node:node：$target"
  chown -R node:node "$target" || echo "[entrypoint] chown 失败，继续启动：$target"
  return 0
}
for d in "$DATA_DIR"/*/uploads "$DATA_DIR"/*/uploads/u "$DATA_DIR"/*/uploads/u/*; do
  fix_owner "$d"
done

exec su-exec node:node "$@"

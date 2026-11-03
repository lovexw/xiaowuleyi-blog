# 全站备份到树莓派

甲骨文那台机器随时可能被回收（免费实例的常见结局）。这套方案让整站有一份**可独立还原**的副本躺在家里，
不依赖任何云服务商，也不需要 GitHub 在线。

- 备份机：树莓派 4B（`192.168.6.184`，Debian 13 / aarch64），数据盘 `/data` 3TB
- 源站：甲骨文 `167.234.216.40`（Ubuntu 20.04 / aarch64）
- 数据落点：`/data/backup/xwblog/`
- 全量约 3.0G，增量一次约 40 秒

## 为什么是「树莓派主动拉」

树莓派在家宽后面，没有公网 IP；甲骨文有。所以方向只能是树莓派 → 甲骨文：

```
树莓派 ──SSH(只读密钥)──> 甲骨文
   │                        │
   │                    /opt/xwblog-backup/   ← 每 30 分钟刷新的「可备份视图」
   │                    /opt/xwblog-data/     ← 附件
   └── rsync 增量 ──────────┘
```

反过来做（服务器推给树莓派）需要家里有固定公网入口，家宽 IP 一变就断，还得在服务器上存树莓派的凭据。
现在的方向里，**甲骨文完全不知道树莓派在哪**，家庭网络怎么变都不影响。

树莓派上的密钥 `~/.ssh/oracle_backup` 在甲骨文侧被加了 `restrict` 选项：能读文件、能跑命令，
但禁止端口转发、agent 转发和 X11。即使树莓派被入侵，这把钥匙也不能当跳板用。

## 备份了什么

| 内容 | 来源 | 说明 |
|---|---|---|
| 博客库 | `/opt/xwblog-data/blog.xiaowuleyi.com/blog.db` | sqlite `.backup` 一致性快照 |
| 博客附件 | 同上 `uploads/` | 6178 个文件 / 2.2G |
| btchao 库 | `/opt/btchao-blog/data/blog.btchao.com/blog.db` | 同上 |
| btchao 附件 | 同上 `uploads/` | 5439 个文件 / 655M |
| 代码仓库 | `/opt/xwblog-app/` | 含 `.git`，可离线接着部署 |
| 反代配置 | `/opt/1panel/.../conf.d/*.conf` | 12 个站点 |
| systemd 单元 | 自动部署 + 限速 | 换机后服务行为一致 |
| 3x-ui 配置 | `/etc/x-ui/x-ui.db` | **含 REALITY 私钥** |
| hysteria 配置 | `/etc/hysteria/` | **含证书私钥** |
| tenants.json | 两个站 | 少了它容器起不来 |
| Docker 镜像 | `xwblog:sha-xxx` | 71M，换版本时存一份，留最近 3 版 |
| 历史清理备份 | `/opt/backup/` | 124M |

### 为什么数据库不能直接拷

`blog.db` 是 WAL 模式，主库 15M 而 `blog.db-wal` 有 6.8M 没合并。
直接 `rsync` 那个主库，拿到的是**丢数据的旧状态**；三个文件一起拷则可能在拷贝过程中错位。

所以服务器端每 30 分钟用 `sqlite3 .backup` 导一份干净副本到 `/opt/xwblog-backup/db/`，
导完还跑一次 `pragma integrity_check`。树莓派只拉这个副本，不碰运行中的库。

## 目录结构

```
/data/backup/xwblog/
├── bin/
│   ├── backup.sh          # 拉取备份
│   └── restore.sh         # 还原
├── snapshots/
│   ├── 2026-11-03T2216/   # 每份都是完整视图
│   │   ├── .complete      # 有它才算有效快照
│   │   ├── MANIFEST.txt
│   │   ├── server/        # db + 配置 + 元信息
│   │   ├── data/          # 博客与 btchao 附件
│   │   ├── code/          # 代码仓库
│   │   └── legacy/        # 历史清理备份
│   └── 2026-11-03T2303/
├── images/                # docker 镜像，按版本去重
├── logs/                  # 按月一个文件
└── latest -> snapshots/…
```

### 硬链接增量

每份快照目录**看起来都是完整的 3.0G**，但只有第一份真占那么多。
后续快照通过 `rsync --link-dest` 把没变的文件硬链接到上一份，实际只占新增部分。

实测：两份快照逻辑总和 5.8G，`du` 实际只算 3.0G；同一个图片文件在两份里的 inode 相同、链接数为 2。

好处是**任何一份都能独立还原**，不用像增量链那样必须顺着往回找。

保留策略：日备留 30 天，每月 1 号那份永久保留。删一份不影响其他份（硬链接引用计数递减而已）。

## 日常

```bash
# 看有哪些快照
sudo /data/backup/xwblog/bin/restore.sh --list

# 手动备份一次（平时不用管，定时器每天 03:30 跑）
sudo /data/backup/xwblog/bin/backup.sh

# 只校验最新快照能不能用，不写任何文件
sudo /data/backup/xwblog/bin/restore.sh --verify

# 看定时器状态
systemctl list-timers xwblog-backup.timer
tail -f /data/backup/xwblog/logs/backup-$(date +%Y%m).log
```

定时器 `xwblog-backup.timer` 每天 03:30 触发，带 5 分钟随机延迟。
`Persistent=true`，树莓派那天没开机的话，开机后会补一次。

## 还原

### 场景一：甲骨文被回收，换一台新服务器

新机器装好 Docker 后：

```bash
# 从树莓派把 bin/ 和 snapshots/ 拷过去，或直接把硬盘挂上
sudo ./restore.sh --to-server 2026-11-03T2216
```

脚本会：校验快照 → 恢复 `/opt/xwblog-data`、`/opt/btchao-blog` → 放回 db 和 tenants.json →
恢复代码仓库 → `docker load` 镜像（没有就从 Dockerfile 构建）→ 起两个容器 → 打健康检查。

跑完还需要手动做的两件事：

1. **装反向代理**。备份里有 `server/config/openresty/` 的 12 份站点配置，
   但 openresty 本身要重新装（1Panel 或裸 nginx 都行），把 conf 放进 `conf.d/` 即可。
2. **重建 x-ui / hysteria**。`server/config/x-ui/x-ui.db` 和 `server/config/hysteria/`
   是原样备份，装回对应位置就能恢复代理和证书。

### 场景二：甲骨文还在，只是要演练

```bash
# 在树莓派上起一套，绑 18788/18790，验证完自动清理
sudo ./restore.sh --local

# 想让它一直跑着（灾备接管时用）
sudo ./restore.sh --local --keep-running
```

### 场景三：让树莓派直接对外提供服务

`--local --keep-running` 起容器后，用 Cloudflare Tunnel 把域名指过来：

```yaml
# CF 后台 Zero Trust → Networks → Tunnels → 该 tunnel → Public Hostname
blog.xiaowuleyi.com  →  http://localhost:18788
blog.btchao.com      →  http://localhost:18790
```

树莓派已装 `cloudflared`（token 模式，服务名 `cloudflared`）。ingress 规则在 CF 后台配，
改完几十秒生效。这条路不依赖家庭公网 IP，也不占 443。

注意树莓派 4B 的性能：静态页和普通访问没问题，但比甲骨文慢；
2TB 那块盘在跑 qbittorrent 和 mtphotos，备份期间磁盘 I/O 会互相拖慢。

## 踩过的坑

留在这里，免得以后重写时再摔一次。

**1. `--link-dest` 必须指到上一份快照的对应子目录，不能指快照根**

rsync 找复用文件的规则是：**link-dest 目录 + 文件相对于「目标参数」的路径**。

目标参数是 `snapshots/新/data/blog/uploads/`，里面的文件 `u/202610/x.png`
相对于目标参数的路径就是 `u/202610/x.png`。
所以 link-dest 要写 `snapshots/旧/data/blog/uploads`，rsync 才会去
`snapshots/旧/data/blog/uploads/u/202610/x.png` 找到同名文件。

如果偷懒写成 `snapshots/旧`，rsync 会去找 `snapshots/旧/u/202610/x.png`——
不存在，于是当成新文件重传。

症状：每份快照都全量重传 2.2G，`Total transferred file size` 等于总大小而不是 0。
所以脚本里的 `pull` 函数要求传入相对路径，每段单独拼 link-dest。

**2. 不要加 `-H`（保留硬链接）**

源站数据里一个硬链接都没有（`find -type f -links +1` 结果为 0），
但 `-H` 会让 rsync 在两端各建一遍完整 inode 映射表，上万文件时开销极大，
叠加--link-dest 产生的硬链接后直接卡死十几分钟没有进展。

硬链接复用是 `--link-dest` 自己做的，跟 `-H` 无关。

**3. rsync 不会帮你建目标父目录**

目标 `snapshots/x/data/blog/uploads/` 如果 `data/blog/` 不存在，rsync 报
`mkdir ... failed: No such file or directory` 并退出码 11。
必须自己 `mkdir -p` 目标路径。

**4. 用管道接 rsync 会把失败吞掉**

`rsync ... | tee | grep` 的退出码是最后一个命令的。rsync 挂了、管道照样"成功"，
脚本会继续往下跑还盖上 `.complete` 章。必须先把 rsync 输出重定向到临时文件、
单独取 `$?`，再决定是否中止。

**5. 以 root 跑脚本时 git 会拒绝**

`/opt/xwblog-app` 属主是 `ubuntu`，root 进去执行 git 会报 `dubious ownership`。
用 `sudo -u $(stat -c %U /opt/xwblog-app) git -C ...` 提权到属主身份，或配 `safe.directory`。

**6. `sudo rm -rf /路径/*` 是假删**

目录权限 700 时，通配符在普通用户 shell 里展不开，命令收到的是字面量 `*`，
什么都不删还不报错。要删就 `sudo bash -c "find /路径 -type f -delete"`。

## 与自动部署的关系

两套机制互不干扰：

- **部署**：GitHub main → 甲骨文（`xwblog-deploy.timer`，每 2 分钟）
- **备份**：甲骨文 → 树莓派（`xwblog-backup.timer`，每天 03:30）

备份的是**服务器当前状态**（包括数据库），所以即使 GitHub 上的代码回滚了，
数据也不会跟着回滚——这是有意的。

## 服务器端安装

```bash
scp deploy/backup/snapshot.sh ubuntu@<host>:/tmp/
ssh ubuntu@<host> 'sudo install -m 755 /tmp/snapshot.sh /opt/xwblog-backup/snapshot.sh'
scp deploy/backup/systemd/xwblog-backup-snapshot.* ubuntu@<host>:/tmp/
ssh ubuntu@<host> 'sudo install -m 644 /tmp/xwblog-backup-snapshot.* /etc/systemd/system/ &&
  sudo systemctl daemon-reload && sudo systemctl enable --now xwblog-backup-snapshot.timer'
```

树莓派端同理，`backup.sh` / `restore.sh` 装到 `/data/backup/xwblog/bin/`，
`xwblog-backup.service` / `.timer` 装到 `/etc/systemd/system/`。

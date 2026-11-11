# 甲骨文自托管实例的自动部署

> **这是本项目唯一的部署真相源（2026-11-05 起）。** 涉及"生产怎么跑的、怎么回滚、数据在哪"，
> 一律以本文为准。Cloudflare 等形态已冻结（演示站已删除），见 [MAINTENANCE.md](MAINTENANCE.md)。

> 一句话：**代码只改 GitHub，服务器只负责拉取和重建。** 推送到 `main` 后，服务器上的
> systemd 定时器会在 2 分钟内发现新提交，用 ARM 原生构建出新镜像并替换容器，健康检查失败自动回滚。

首次接入：2026-11-03，机器 `167.234.216.40`（Ubuntu 20.04 / aarch64 Ampere A1）。当天起这台机器跑两个实例：

| 实例 | 容器 | 监听 | 数据目录 |
| --- | --- | --- | --- |
| blog.xiaowuleyi.com | `xwblog-next` | `127.0.0.1:8788` | `/opt/xwblog-data` |
| blog.btchao.com（比特囤币） | `btchao-blog` | `127.0.0.1:8790` | `/opt/btchao-blog/data` |

两个实例共用同一份代码、同一个镜像，一次构建同时升级，见下文「多实例」。

## 为什么是「服务器定时拉」而不是「GitHub 推」

两种都能做，这里选拉取，原因很实际：

| 方案 | 需要什么 | 代价 |
| --- | --- | --- |
| GitHub Actions → SSH 推 | 把 SSH 私钥存进 GitHub Secrets，还要开一个能 `docker` 的账号 | 私钥泄露面 +1；Actions 挂掉/额度用完就停摆 |
| **服务器定时拉（当前）** | 服务器能访问 GitHub（它已经能） | 最长 2 分钟延迟；日志在服务器上 |

个人博客对「延迟 2 分钟」不敏感，而少存一把私钥是长期收益。要推模式的话见文末。

## 部署模型

```
GitHub main  ──(git fetch, 每 2 分钟)──▶  /opt/xwblog-app    代码（视为只读）
                                              │ docker build（ARM 原生，只构建一次）
                                              ▼
                                          xwblog:sha-47f2cae   镜像按 commit 打 tag
                                              │
                        ┌─────────────────────┴─────────────────────┐
                        ▼                                           ▼
                  xwblog-next                                 btchao-blog
                  127.0.0.1:8788                              127.0.0.1:8790
                        │                                           │
              /opt/xwblog-data                      /opt/btchao-blog/data
        （blog.db + uploads + tenants.json）      （blog.db + uploads + tenants.json）
```

关键点：**代码目录和数据目录是分开的**。`git reset --hard`、`docker build`、重建容器都不会碰到
`blog.db` 和 `uploads/`，所以自动部署没有丢数据的风险。两个实例各自有独立的数据目录，互不干扰。

## 一次性初始化（已在本机完成，换机器时照做）

```bash
# 1. 拿代码（服务器上已有 /opt/xwblog-app）
sudo git clone https://github.com/lovexw/xiaowuleyi-blog.git /opt/xwblog-app

# 2. 数据目录与租户配置（已有，勿覆盖）
#    /opt/xwblog-data/blog.xiaowuleyi.com/{blog.db,uploads/}
#    /opt/xwblog-data/tenants.json  →  {"blog.xiaowuleyi.com": {"demo": false}}

# 3. 装定时器
cd /opt/xwblog-app && ./scripts/install-oracle-deploy.sh
```

宿主机另有两个辅助定时器，不在上面这个安装脚本里，换机器要单独装（装完都要 `systemctl daemon-reload`）：

| 单元 | 干什么 | 来源 |
|---|---|---|
| `xwblog-image-variants.timer` | 每天 05:10 给图床补 WebP 变体（192/480/960），缺了只会退化成「传原图」 | `deploy/images/xwblog-image-variants.{service,timer}`（`User=1000`，别改回 root） |
| `xwblog-backup-snapshot.timer` | 每 30 分钟刷 `/opt/xwblog-backup` 的「可备份视图」，树莓派来拉它（见 `docs/BACKUP-RASPBERRY.md`） | `deploy/backup/systemd/xwblog-backup-snapshot.*` + `deploy/backup/snapshot.sh` |


## 日常：改完推上去就行

```bash
git add -A && git commit -m "..." && git push origin main
```

服务器 2 分钟内自动完成构建与替换。**2026-11-10 起是零中断切换**：新容器起在备用端口，
健康检查通过才把 nginx 上游指过去并 reload，旧容器排空几秒后才停（见下文「零中断」）。

**改的是部署脚本本身时**，那次部署跑的还是旧版（脚本先 `git reset` 再往下跑，bash 读的是旧 inode），
所以脚本改动要等下一次部署才生效。推完补一条 `./scripts/deploy-oracle.sh --force` 即可立刻生效 ——
2026-11-05 给 `start_container` 加 `TRUST_PROXY=cf` 就是这么漏掉一次的。

想立刻部署、不等定时器：

```bash
ssh ubuntu@167.234.216.40
sudo systemctl start xwblog-deploy          # 立即跑一轮
journalctl -u xwblog-deploy -f              # 盯日志
```

## 多实例：一台机器跑多个站点

一台机器可以同时托管多个站点，它们共用同一份代码和同一个镜像，部署时只构建一次、
逐个替换容器。实例清单写在 systemd 单元的 `INSTANCES` 环境变量里：

```
容器名|绑定地址|健康检查域名|数据目录|上游名:备用端口
```

第 5 段可选，填了就启用蓝绿切换（见下一节），留空则退回「停旧起新」。

多个实例用**分号**分隔，例如当前这台机器（`/etc/systemd/system/xwblog-deploy.service`）：

```ini
Environment="INSTANCES=xwblog-next|127.0.0.1:8788|blog.xiaowuleyi.com|/opt/xwblog-data|xwblog_main:8789;btchao-blog|127.0.0.1:8790|blog.btchao.com|/opt/btchao-blog/data|xwblog_btchao:8791"
```

不设置 `INSTANCES` 时退化为单实例，行为与老版本一致（读 `CONTAINER` / `BIND_ADDR` /
`HEALTH_HOST` / `DATA_DIR`）。

**新增一个站点**：

```bash
# 1. 准备数据目录与租户配置（脚本要求 $DATA_DIR/tenants.json 存在）
sudo mkdir -p /opt/<新站>/data
echo '{"<新域名>": {"demo": false}}' | sudo tee /opt/<新站>/data/tenants.json

# 2. 编辑单元，在 INSTANCES 末尾追加一段，然后重载
sudo systemctl edit --full xwblog-deploy   # 或在 /etc/systemd/system/ 下直接改
sudo systemctl daemon-reload

# 3. 手动跑一轮（会 git reset + build + 起新容器）
cd /opt/xwblog-app && ./scripts/deploy-oracle.sh
```

**部署行为**：

- 「已是最新」的判定是**所有**实例都跑在目标 commit 上，任一实例落后就会触发部署
- 镜像只构建一次，所有实例共用（`xwblog:sha-xxxxxxx`）
- 某个实例健康检查失败，只回滚它自己，其它实例保持新版本；`last-failed` 记下这个
  commit 防止每 2 分钟重试
- `--status` 会按实例分段打印镜像 / 提交 / 健康码

## 零中断：蓝绿切换（2026-11-10 起）

**为什么加这个**：在这之前，部署是「停旧容器 → 同端口起新容器」。停和起之间那几十毫秒到几秒里，
端口上没有监听者，nginx 的连接卡在建立阶段——既不成功也不立刻被拒，后台页面要等满 20 秒的
`AbortController` 才弹「后台没有响应，请求已超时」。2026-11-10 20:23–20:25 那段 103 秒的请求空白
就是撞在部署窗口上（当晚连推三次，制造了三个窗口）。

**现在怎么切**：

```
                    nginx :80
                       │  proxy_pass http://xwblog_main
                       ▼
          00-xwblog-upstreams.conf      ← 部署脚本只改这一行的端口
                       │
             ┌─────────┴─────────┐
             ▼                   ▼
      127.0.0.1:8788        127.0.0.1:8789
     （旧容器，仍在服务）   （新容器，健康检查中）
```

1. 新容器起在备用端口（8788 ⇄ 8789），旧容器一个字节都没动
2. 健康检查（带 Host 头，最多 `HEALTH_TIMEOUT` 秒）通过才继续
3. `sed` 改上游端口 → `openresty -t` → `openresty -s reload`
4. 等 `DRAIN_SECONDS`（默认 3 秒）排空在途请求
5. 停旧容器 → 新容器改名回 `xwblog-next`（容器名对用户始终不变）

**任何一步失败都只是「新容器被删掉」**，旧容器继续服务，站点不受影响。所以蓝绿模式下
「回滚」这个概念消失了，只有「这次没更新」。

| 失败点 | 结果 |
|---|---|
| 新容器起不来 / 健康检查不过 | 删新容器，旧版继续跑 |
| 上游文件里找不到这个 upstream 名 | 本实例退回「停旧起新」 |
| `sed` 改完回读不符（配置格式被改过） | 放弃切换，旧版继续跑 |
| `openresty -t` 不过 | 恢复上游备份并重载，删新容器 |
| 备用端口被别的服务占了 | 本实例退回「停旧起新」 |
| 上次死在 rename 之前 | 下次部署把遗留的 `-incoming` 认领回来，不会误删服务中的容器 |

**前提**（一次性，脚本不会自动改 nginx）：

- `conf.d/00-xwblog-upstreams.conf` 里定义上游，一个一行：
  `upstream xwblog_main { server 127.0.0.1:8788; }`。
  文件名 `00-` 前缀是必须的：nginx 解析到 `proxy_pass` 时就得找得到这个 upstream。
- 站点 conf 的 `location /` 写 `proxy_pass http://xwblog_main;`，不再写死端口
- 这两个文件都在仓库 `deploy/nginx/`，服务器上已装（备份在
  `/opt/xwblog-deploy/state/nginx-backup-20261110/`）

**1Panel 会覆盖站点 conf**：在面板里改站点设置会把 `proxy_pass` 写回 `127.0.0.1:8788`，
蓝绿退化成「停旧起新」（脚本自己会发现上游缺失并退回，不报错）。遇到就用 `deploy/nginx/`
下的版本覆盖回去再 reload。

**为什么能两个容器同时开着**：它们共用同一个 `blog.db`。`docker-poc/shims/d1.ts` 已设
`journal_mode=WAL` + `busy_timeout=5000`，写写之间是排队等锁而不是立刻抛 `SQLITE_BUSY`。
这两条是蓝绿成立的前提，别去动。

**验证零中断**（部署窗口里连续打请求，看有没有失败）：

```bash
# 一个终端：每 50ms 打一次首页，记下失败
while :; do curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: blog.xiaowuleyi.com' http://127.0.0.1/; sleep 0.05; done |
  awk '$1 != 200 { bad++ } END { print "非 200：", bad + 0 }'
# 另一个终端：sudo systemctl start xwblog-deploy
```

## 常用命令

```bash
cd /opt/xwblog-app
./scripts/deploy-oracle.sh --status   # 当前提交 / 镜像 / 容器状态 / 健康码 / 可用镜像
./scripts/deploy-oracle.sh --dry-run  # 只看远端有没有新提交
./scripts/deploy-oracle.sh --force    # 强制重建（镜像已存在也会重建并重启）
./scripts/deploy-oracle.sh            # 手动跑一轮（等同定时器做的事）
```

## 回滚

镜像按 commit 打 tag，回滚就是把上一个镜像跑起来。**先用 `--status` 看 nginx 当前指向哪个端口**
（蓝绿切换后主站可能停在 8789 而不是 8788），手工起的容器必须监听那个端口，否则 nginx 指向空端口：

```bash
cd /opt/xwblog-app && ./scripts/deploy-oracle.sh --status | grep -E '流量入口|容器提交'
sudo docker images --filter 'reference=xwblog:sha-*'          # 看有哪些
sudo docker rm -f xwblog-next
sudo docker run -d --name xwblog-next --restart unless-stopped \
  -p 127.0.0.1:8788:8787 \
  -v /opt/xwblog-data:/data/tenants \
  -v /opt/xwblog-data/tenants.json:/app/docker-poc/tenants.json:ro \
  -e NODE_ENV=production -e PORT=8787 \
  -e TENANTS_DIR=/data/tenants \
  -e TENANTS_CONFIG=/app/docker-poc/tenants.json \
  -e PUBLIC_ROOT=/app/public \
  -e OPS_LOG_PATH=/data/tenants/ops.log \
  -e TRUST_PROXY=cf \
  --label xwblog.sha=手动回滚 \
  xwblog:sha-<上一个短 sha>
```

`-e TRUST_PROXY=cf` 与部署脚本必须一致：少了它，访客 IP 会被记成 CF 边缘地址（172.7x），
所有访客共用一个限流桶，TG 登录告警里的 IP 也是错的。

或者干脆在 GitHub 上把坏提交 revert 掉推上去——定时器会自己部署回来，这通常更省事，
因为服务器状态始终等于 `main`。

**坏提交不会反复重启**：部署失败（构建失败或健康检查不过）会记进
`/opt/xwblog-deploy/state/last-failed`，定时器跳过同一个 commit，避免每 2 分钟重启一次。
修好后推新提交即可；确实要重试旧提交用 `--force`。

## 暂停自动部署

```bash
sudo systemctl disable --now xwblog-deploy.timer   # 停定时器，容器照常跑
cd /opt/xwblog-app && ./scripts/install-oracle-deploy.sh --uninstall
```

## 不要做的事

- **不要在服务器上改代码**。`git reset --hard` 会覆盖，改了也白改；要改就改 GitHub。
- 不要在服务器上手动 `docker run` 别的容器占 8788/8789 端口，脚本按名称 `xwblog-next` 管理，
  备用端口要留给蓝绿切换。
- 不要给 `/opt/xwblog-data` 做 `git` 操作，它不在仓库里。
- 不要去掉 `blog.xiaowuleyi.com.conf` 里的 `proxy_set_header Host $host`，多租户按 Host 路由。
- 不要把站点 conf 的 `proxy_pass` 改回写死端口——那样每次部署都会断流几秒，等于关掉蓝绿。
- 不要把 `00-xwblog-upstreams.conf` 里的上游改成多行写法，脚本用 sed 按单行改端口。

## 与 Cloudflare 的关系

仓库曾经连着 Cloudflare Workers Builds，push `main` 会同时部署到 CF。**2026-11-05 起 CF 形态冻结**，
`.github/workflows/deploy.yml` 已删除，仓库里不再有任何指向 Cloudflare 的部署入口。

但有一件事改仓库文件管不到：**Cloudflare 控制台侧的 Git 集成**。如果那个 Worker 上还连着，每次
push 仍会同时更新 CF（白烧构建额度，还可能让 CF 上留一份旧代码）。要去断：

Workers & Pages → 选中该 Worker → Settings → Build → 断开 Git / 关闭自动部署。

> 判断方法：Cloudflare 控制台 → 该 Worker → Deployments，若最近还有你 push 的时间点对应的部署记录，
> 说明集成仍活着。

注意：断开后，只要域名还解析到 Cloudflare，**线上站点会冻结在最后部署的那版**，直到把
`blog.xiaowuleyi.com` 切到甲骨文（见下一节）。本机当前线上已由甲骨文容器服务（2026-11-05 实测）。

## 域名接入：CF 橙云回源 80

源站 443 被 xray（VLESS+REALITY，伪装 `www.tesla.com`）占着，所以博客**不启用源站 HTTPS**，
而是保持 Cloudflare 橙云代理、回源 80。这样不动代理配置、不用另签证书，回滚只需改 DNS。

源站侧落在 1Panel 的 openresty 上（host 网络，容器内 `/www` ← 宿主机
`/opt/1panel/apps/openresty/openresty/www`）：

`/opt/1panel/apps/openresty/openresty/conf/conf.d/blog.xiaowuleyi.com.conf`

- `listen 80` + `server_name blog.xiaowuleyi.com`
- `proxy_pass http://127.0.0.1:8788`（容器 `xwblog-next`）
- **必须透传 `Host`**：应用按 Host 路由多租户，头丢了直接 404
- 透传 `X-Forwarded-Proto`，并把 CF 边缘注入的 `CF-Visitor` 原样带到后端——Flexible SSL 下
  回源段是 http，应用靠 `resolveScheme` 读 `CF-Visitor` 判定访客侧是 https，否则登录会被判跨站
- 日志目录 `/www/sites/blog.xiaowuleyi.com/log` 必须先在容器内存在，否则 `openresty -t` 报
  `No such file or directory`

改完自检：

```bash
sudo docker exec 1Panel-openresty-fokI openresty -t
sudo docker exec 1Panel-openresty-fokI openresty -s reload
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
  -H 'Host: blog.xiaowuleyi.com' http://127.0.0.1/
```

Cloudflare 控制台三件事：

1. **DNS**：`blog.xiaowuleyi.com` A → `167.234.216.40`，代理状态保持**橙色云**
2. **SSL/TLS → Overview**：必须是 **Flexible**（源站只有 80；选 Full / Full strict 会 526）
3. 保留 **Always Use HTTPS**（边缘跳转，不影响回源）

确认切换生效：

```bash
curl -sI https://blog.xiaowuleyi.com/ | head -3
# 期望 200，且 server: cloudflare
ssh ... 'tail -5 /opt/1panel/apps/openresty/openresty/www/sites/blog.xiaowuleyi.com/log/access.log'
# 能看到 CF 节点的回源请求
```

回滚：把 DNS 记录改回切换前那条即可，所以**改之前先截图原有记录**。

## 排障

| 现象 | 先看 |
| --- | --- |
| 推了但没变化 | `journalctl -u xwblog-deploy -n 50`；`systemctl list-timers xwblog-deploy.timer` |
| 一直是旧版本 | `--status` 里「容器提交」是否等于远端 sha；`last-failed` 是否有记录 |
| 部署后 502/连不上 | `journalctl` 里的健康检查输出；`docker logs xwblog-next --tail 50` |
| 切域名后 526 / 5xx | CF 的 SSL/TLS 模式不是 Flexible，或回源打到了 443（那是 xray） |
| 切域名后是应用自己的 404 | openresty 没透传 `Host`，应用按 Host 找不到租户 |
| 构建慢或失败 | `/opt/xwblog-deploy/state/build.log`，多为 npm 网络或磁盘满（`df -h /`） |
| 数据像丢了 | 基本不会：`ls /opt/xwblog-data/blog.xiaowuleyi.com/`，容器只是挂载它 |
| 图片/视频传不上去（界面报 `Unexpected token '服'`） | 数据目录被 root 动过。`sudo docker exec xwblog-next ls -lnd /data/tenants/*/uploads/u/*`，属主不是 1000 就 `sudo chown -R 1000:1000 /opt/xwblog-data/<站点>/uploads`（btchao 是 `/opt/btchao-blog/data/<站点>/uploads`）。应用进程是 `node`(1000)，写 root 目录会 EACCES。entrypoint 启动时会把这一层自愈，但仅限 `*/uploads`、`*/uploads/u`、`*/uploads/u/<月份>` 三级；若是更深的子目录被 root 弄脏，手工 chown。**别用 `docker exec` 默认的 root 去写数据目录** |

## 想改成「推送即部署」（GitHub Actions → SSH）

如果 2 分钟延迟不能接受，可以在 `.github/workflows/` 新增一个 job：用 `ssh` 连到
`167.234.216.40` 执行 `systemctl start xwblog-deploy`（或直接跑脚本）。需要：
仓库 Secrets 存一把专用私钥（`ssh-keygen -t ed25519 -N ''`，公钥追加到服务器
`~/.ssh/authorized_keys`），私钥只授予执行部署脚本的权限。代价是 GitHub 侧多一把能登服务器的钥匙。

# 甲骨文自托管实例的自动部署

> 一句话：**代码只改 GitHub，服务器只负责拉取和重建。** 推送到 `main` 后，服务器上的
> systemd 定时器会在 2 分钟内发现新提交，用 ARM 原生构建出新镜像并替换容器，健康检查失败自动回滚。

首次接入：2026-11-03，机器 `167.234.216.40`（Ubuntu 20.04 / aarch64 Ampere A1），
容器 `xwblog-next` 监听 `127.0.0.1:8788`，数据在 `/opt/xwblog-data`。

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
                                              │ docker build（ARM 原生）
                                              ▼
                                          xwblog:sha-47f2cae   镜像按 commit 打 tag
                                              │ 停旧容器 → 起新容器 → 健康检查
                                              ▼
                                          xwblog-next          监听 127.0.0.1:8788
                                              │
                     /opt/xwblog-data  ───────┘  数据（blog.db + uploads + tenants.json）
```

关键点：**代码目录和数据目录是分开的**。`git reset --hard`、`docker build`、重建容器都不会碰到
`blog.db` 和 `uploads/`，所以自动部署没有丢数据的风险。

## 一次性初始化（已在本机完成，换机器时照做）

```bash
# 1. 拿代码（服务器上已有 /opt/xwblog-app）
sudo git clone https://github.com/lovexw/bloghao-xwblog.git /opt/xwblog-app

# 2. 数据目录与租户配置（已有，勿覆盖）
#    /opt/xwblog-data/blog.xiaowuleyi.com/{blog.db,uploads/}
#    /opt/xwblog-data/tenants.json  →  {"blog.xiaowuleyi.com": {"demo": false}}

# 3. 装定时器
cd /opt/xwblog-app && ./scripts/install-oracle-deploy.sh
```

## 日常：改完推上去就行

```bash
git add -A && git commit -m "..." && git push origin main
```

服务器 2 分钟内自动完成构建与替换。期间站点中断约 2–5 秒（停旧容器到新容器起来）。

想立刻部署、不等定时器：

```bash
ssh ubuntu@167.234.216.40
sudo systemctl start xwblog-deploy          # 立即跑一轮
journalctl -u xwblog-deploy -f              # 盯日志
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

镜像按 commit 打 tag，回滚就是把上一个镜像跑起来：

```bash
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
  --label xwblog.sha=手动回滚 \
  xwblog:sha-<上一个短 sha>
```

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
- 不要在服务器上手动 `docker run` 别的容器占 8788 端口，脚本按名称 `xwblog-next` 管理。
- 不要给 `/opt/xwblog-data` 做 `git` 操作，它不在仓库里。
- 不要去掉 `blog.xiaowuleyi.com.conf` 里的 `proxy_set_header Host $host`，多租户按 Host 路由。

## 与 Cloudflare 的关系

仓库曾经连着 Cloudflare Workers Builds，push `main` 会同时部署到 CF（GitHub Actions 里的
`deploy.yml` 因为没有 `CLOUDFLARE_API_TOKEN` 一直是 skipped，真正干活的是 Workers Builds）。
现在部署目标是甲骨文，**需要在 Cloudflare 控制台断开 Git 集成**，否则每次 push 仍会同时更新 CF：

Workers & Pages → 选中该 Worker → Settings → Build → 断开 Git / 关闭自动部署。

`.github/workflows/deploy.yml` 已改为只能手动触发（`workflow_dispatch`），从此 push 不会
再经 Actions 部署到 CF；即使哪天补上 secrets 也不会误触发。

注意：断开后，只要域名还解析到 Cloudflare，**线上站点会冻结在最后部署的那版**，直到把
`blog.xiaowuleyi.com` 切到甲骨文（见下一节）。

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

## 想改成「推送即部署」（GitHub Actions → SSH）

如果 2 分钟延迟不能接受，可以在 `.github/workflows/` 新增一个 job：用 `ssh` 连到
`167.234.216.40` 执行 `systemctl start xwblog-deploy`（或直接跑脚本）。需要：
仓库 Secrets 存一把专用私钥（`ssh-keygen -t ed25519 -N ''`，公钥追加到服务器
`~/.ssh/authorized_keys`），私钥只授予执行部署脚本的权限。代价是 GitHub 侧多一把能登服务器的钥匙。

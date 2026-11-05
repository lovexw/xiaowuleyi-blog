# AUDIT_REPORT — xwblog 全项目深度审计报告（阶段 A）

> 审计对象：`lovexw/bloghao-xwblog` @ commit `864c73f`（2026-11-05 与 origin/main 同步）。
> 方法：8 路并行专项审计（SEO / Node 运行时 / SQLite / 业务逻辑 / 安全 / 文件存储 / 前端主题 / 备份DR与文档）+ 审计长逐条交叉验证 P0/P1 证据 + 纯函数级实验复现。
> 纪律：全程只读，未修改任何源码；实验脚本与产物全部位于系统临时目录 `C:/Users/Administrator/AppData/Local/Temp/xwblog-audit/`（各子目录：seo/ exp/ media/ sec/ frontend-themes/ backup-dr/）。
> 配套文档：`ARCHITECTURE_REPORT.md`（架构摸底）、`REMEDIATION_PLAN.md`（阶段 B 修复计划）、`AUDIT_PROGRESS.md`（过程台账）。

---

## 0. 结论速览

| 维度 | 结果 |
| --- | --- |
| 类型检查 | ✅ `tsc --noEmit` 通过 |
| 回归测试 | ✅ **1006/1006 全绿**（两轮：11-04 23:0x 与 11-05 01:10；另有 1 个真钟依赖 flake 在北京 00:00-01:00 窗口复现过，见 P3-1） |
| 运行时依赖漏洞 | ✅ `npm audit --omit=dev` 0 漏洞（运行时依赖仅 hono） |
| 问题总数 | **P0 × 1｜P1 × 13｜P2 × 27｜P3 × 30**（已跨线去重） |
| 数据丢失风险 | 无直接路径；但有 **3 条备份完整性 P1**（静默老化 / 还原毁库 / 第三租户无备份）与 1 条启动崩溃循环 P1，均属「出事时才炸」的地雷 |
| 权限绕过 | 无已确认绕过；安全线结论：鉴权矩阵完整、无存储型 XSS、无公开面 SSRF、CSRF 双保险成立 |
| 跨租户泄漏 | 数据/缓存/Cookie 隔离成立；**泄漏面在可用性层**（P0-1 限流互伤、P1-2 TG 幂等键碰撞丢消息） |
| 生产形态口径 | ⚠ 任务书（裸 Node 无 Docker）与仓库部署文档（2026-11-03 起双实例 Docker 容器替换）冲突，见 §1.2，**需站长拍板**；软件栈两种口径一致（Node 26 + node:sqlite + 本地磁盘） |

**总体评价**：代码库整体工程质量显著高于同类个人项目——防线密集且有 1006 个测试钉住、注入面收敛一致、软删/可见窗口/防泄漏清单执行到位、八主题模板层零漂移。本次审计的实质产出集中在三类：① **多租户单进程形态下「按 isolate 设计」的机制未跟上**（P0-1、P1-2、P1-6）；② **删除/备份/引用完整性等「反向路径」落后于功能演进**（P1-7/8/10/11/12）；③ **文档与生产现实脱节**（§1.2、P2-25/26/27）。

---

## 1. 生产环境适配分析（核心基础设施结论）

### 1.1 实际运行形态（以代码与部署文档为准）

- 入口 `docker-poc/server.ts` → esbuild 产物 `dist/server.js`（node:26-alpine 内裸 Node 26 进程，无原生模块）
- 单进程**多租户**：按 Host 头路由，每租户独立 `blog.db`（node:sqlite，WAL/busy_timeout=5000/synchronous=NORMAL/foreign_keys=ON）+ 独立 `uploads/` 磁盘目录（`.meta.json` 旁车）
- cron：server.ts 内 `setInterval(60s)` 逐租户调 `xwblog.scheduled`（定时发布每分钟；备份/清理族在北京时间 00:30；demo 每 2h）
- systemd 三组单元：deploy timer（2 分钟轮询 GitHub main → `deploy-oracle.sh` Docker 容器替换 + 健康检查回滚）、backup timer（snapshot 30 分钟 + 每日拉树莓派）、image-variants timer（每日 05:10 gen-variants.py）
- 双实例：`xwblog-next`@127.0.0.1:8788（blog.xiaowuleyi.com）、`btchao-blog`@127.0.0.1:8790（blog.btchao.com）；数据目录分离（`/opt/xwblog-data`、`/opt/btchao-blog/data`）；反代 Caddy 同机；文档另记录 CF 橙云回源 80 的域名接法

### 1.2 ⚠ 平台口径三方冲突（需站长拍板，P2-25 关联）

| 来源 | 口径 |
| --- | --- |
| 本次任务书 | 生产 = 裸 Linux Node.js，**不使用 Docker** |
| 仓库部署文档/自动化（docs/DEPLOY-ORACLE.md，2026-11-03；deploy/systemd/） | 生产 = **双实例 Docker 容器替换**，`Requires=docker.service`，镜像按 commit 打 tag + 健康检查回滚 |
| AGENTS.md / AI-COLLAB.md（宪法，最后更新 2026-10） | 「Cloudflare 是最终部署归宿」「推送即上线（Workers Builds）」——已失实 |

**审计基准不受影响**：两种形态跑的是同一份 `dist/server.js`、同一套数据目录约定，软件栈确为 Node.js + SQLite + 本地磁盘（与任务书一致）。差异只在进程监督（容器 `--restart unless-stopped` vs systemd）与发布方式。**待站长确认后**：若生产确为 Docker 形态 → Node 线的 P1-6（裸 Node 无落地物）降级为文档项；若确为裸 systemd Node → P1-6 升级为必须补齐（service 单元 + 绑定地址 + 运维文档）。AGENTS.md 与 AI-COLLAB.md 的部署章节**无论哪种口径都必须重写**（当前会引导下一个 AI 拿 Workers/D1 的模型去「修」生产，例如对 D1 跑诊断、去 CF 后台找部署）。

### 1.3 形态差异带来的结构性风险（本轮审计主发现的经验归纳）

| Workers 形态假设 | Node 多租户现实 | 后果（本轮发现） |
| --- | --- | --- |
| 每站点独立 isolate → 模块级内存天然隔离 | 单进程单次 import，全租户共享模块状态 | P0-1 限流互伤、P1-2 TG 幂等碰撞丢消息 |
| schema 变更由部署时 `d1 execute` + 运行时 ensureSchema 分担 | server.ts 启动期先跑整份 schema.sql | P1-1 老库/加列发布启动崩溃循环 |
| cron 由平台触发，重启不丢 | setInterval 内存态，单分钟窗口 | P2-4 备份错过窗口整天无补偿 |
| Cache API 边缘缓存层 | 无 caches.default，整层退化 | 无页缓存（性能，非缺陷）；CF 形态靠它兜视频 Range（P2-15） |
| 平台管请求体上限 | Node 层无兜底，chunked 无 CL 绕过预检 | 登记过的残余风险，Node 下放大（§5 Node 线 Q2） |

---

## 2. 发现详情

> 置信度标注：**已确认** = 读码/实验可证；**潜在** = 条件成立才触发；**需生产验证** = 需要生产数据定论。
> 每条给出证据（文件:行号）与修复方向；完整修复方案、兼容性影响、验收标准在 `REMEDIATION_PLAN.md` 对应编号。

### P0（1 项）

#### P0-1 内存限流桶跨租户共享——单进程多租户下所有站点共用同一组计数器【已确认】
- **证据**：`src/auth.ts:179` `const buckets = new Map<string, { n: number; reset: number }>()`（模块级）；全部调用点 key 无租户维度（`src/api.ts:307` `login:${ip}`、`:428` `mreg:${ip}`、`:3379` `cmt:${ip}` 等 40+ 处）；多租户事实 `docker-poc/server.ts:577-585`（单进程单次 import src/index.ts）。**字面量桶**：`src/api.ts:2744` `backup:global`、`:2763` `bundle-export:global`、`:2810` `bundle-step:global`。
- **影响**（业务线与安全线独立发现，交叉印证）：① A 站登录失败 10 次锁死同 IP 的 B 站管理员/会员登录（CGNAT 手机网络下真实用户互相耗尽桶完全可行）；② A 站管理员备份一次 → B 站管理员 10 分钟内备份/整站包全部 429；③ 登录失败 TG 告警（`login-alert:${ip}`）跨站失真。
- **旁证**：同批代码已意识到同类问题并修了别处——`src/pages.ts:165-173` shouldCountView 加了 host 前缀；`tests/batch2-regressions.test.ts:70` 断言注释明写「Node 多租户共进程，去重键不带 host 会跨站误伤」——rateLimit 是同类问题未同改。
- **修复方向**：`rateLimit` 增加租户维度（key 统一拼 host，或 env/db 实例 WeakMap 隔离——与 settings 快照/navTags 同款规矩）；三处 `*:global` 改按租户拼 key。Workers 形态行为不变（每 isolate 天然隔离，拼了 host 也无碍）。

### P1（13 项）

#### P1-1 server.ts 先跑 schema.sql 后跑 ensureSchema——老库恢复与未来加列发布会启动崩溃循环【已确认，实验复现】
- **证据**：`docker-poc/server.ts:152-153`（`await db.exec(SCHEMA_SQL); await ensureSchema(...)`）；`:577` 顶层 `await loadTenants()` 无 try/catch；schema.sql:166/169/233/234/345-347 七条索引引用 `deleted_at`/`pinned`——这两列在老库上只由 SCHEMA_COLUMNS 的 ALTER 补出。
- **实验**（SQLite 线 exp2）：构造 trash 功能之前的库跑真实 schema.sql → `no such column: deleted_at`；补列后仍 → `no such column: pinned`。新库连跑两遍幂等成立。
- **影响**：① 从旧备份还原（restore.sh 正是 P1-11 的主角）缺列即进程崩溃循环；② **今后任何一次「schema.sql 加列 + 建索引引用该列」的发布，全部存量租户库升级即炸**（ensureSchema 自身的先 ALTER 后建索引顺序是对的，问题只在 server.ts 的顺序）。
- **修复方向**：`createTenantFor` 把 `ensureSchema` 提到 `exec(SCHEMA_SQL)` 之前（或 exec 包 try/catch 交给 ensureSchema 兜底）；立规矩：schema.sql 的索引只准引用建表列体，ALTER 补列的索引只进 SCHEMA_INDEXES。

#### P1-2 TG webhook 幂等 Map 用裸 update_id 作键——跨租户碰撞直接丢用户消息【已确认】
- **证据**：`src/external.ts:33` `const tgDoneUpdates = new Map<number, number>()`（仅 update_id）；短路点 `:479`。Telegram 的 update_id 是 **per-bot** 独立序列，不同租户是不同 bot，update_id 大量重叠。
- **影响**：A 租户 bot 处理完 update_id=N 后，B 租户 bot 自己的合法 update_id=N 消息被当重投**静默丢弃**；`tg:${chatId}` 限流 key（`:536`）同病（chatId 跨 bot 也重叠）。Workers 形态无此问题。
- **修复方向**：Map 键改 `host或botToken哈希:updateId`（与 batch2 修 shouldCountView 同款）；限流 key 同加租户维度。

#### P1-3 publicComment 会员分支缺 `membersEnabled` 门控——与登记防线不符【已确认】
- **证据**：`src/api.ts:3373` `const member = user ? null : await getMemberUser(db, c.req.raw)`（无条件加载）；会员发言分支 `:3457-3488`（member_id 落库 + `awardCommentPoints` 计分）。AGENTS「会员体系」节明文要求挂门控；同文件 `:3648`（微博评论 GET）与 pages.ts 四处 SSR 都是正确实现。
- **影响**：站长关闭会员功能后，浏览器残留 `xw_member_session` 的用户仍以会员身份在三路留言接口发言并**继续计分**——关闭开关没有真正关掉会员公开写入口与积分通道。
- **修复方向**：一行改 `settings.membersEnabled === '1' ? await getMemberUser(...) : null`；补回归用例（与 batch2「会员开关统一守卫」同形）。

#### P1-4 robots.txt 的 `Sitemap:` 行跟随请求 Host，与全站域名口径不一致【已确认，实验复现】
- **证据**：`src/index.ts:302` 传 `new URL(c.req.url).origin`；sitemap/RSS/llms/canonical 全部走 `siteBase(settings)`（settings.siteUrl 优先，`src/render.ts:74-76`）。SEO 线实验 #3：siteUrl=A + origin=B → `Sitemap: https://wrong-host.example/sitemap.xml`。
- **影响**：别名域名/服务器 IP/错误 Host 访问时把爬虫引去错误主机；反代漏传 XFP 时 https 站输出 `Sitemap: http://…`——跨域 Sitemap 声明是搜索引擎明确不建议的信号。全站唯一漏收口的绝对 URL 构造点。
- **修复方向**：一行改传 `siteBase(settings, ...)`；tests/seo.test.ts ROBOTS_BASELINE 用例传参与 siteUrl 一致，不会破。

#### P1-5 `TRUST_PROXY=proxy` 在 CF 橙云 + 反代拓扑下系统性拿错访客 IP（文档指导方向相反）【已确认（代码语义）；实际拓扑需生产验证】
- **证据**：`docker-poc/server.ts:401-410`（proxy 档取 XFF 最后一跳）；`docker-poc/DEPLOY-MICRO.md:92-95` 明确教「橙云在 Caddy 外时用默认 proxy 档、别设 cf 档」且其 Caddyfile 未配 trusted_proxies——Caddy 未配 trusted_proxies 时以立即对端（CF 边缘回源 IP）重写 XFF，**无论反代怎么配，最后一跳都是 CF 边缘 IP**。
- **影响**：同 colo 全部访客共享一个 IP → 所有限流桶整站合并；**任何人试错 10 次登录即可把该边缘 IP 上全部访客（含真站长）锁 10 分钟**（零成本整站登录 DoS）；评论落库 IP 全是 CF 节点；`login-alert` 告警失真。
- **修复方向**：该拓扑唯一正确档位是 `TRUST_PROXY=cf`（CF-Connecting-IP 边缘强制写入、反代默认透传）；配套源站 80/443 防火墙收敛到 CF IP 段（防直连伪造）；改 DEPLOY-MICRO.md:92-95 的反向指导。**需生产验证**：抓一次回源请求头确认现网实际形态（若域名未走橙云则 proxy 档正确，本文档错误降级 P2）。

#### P1-6 「裸 Node 生产」在仓库无任何落地物（进程托管/绑定面/文档三缺）【已确认（仓库状态）；实际进程管理方式需生产验证】
- **证据**：`deploy/systemd/` 只有 deploy 定时器（Docker 流程）；`scripts/deploy-oracle.sh:169-181` 全流程 Docker 容器替换；`docker-poc/server.ts:587` `server.listen(PORT)` **无 host 参数 = 绑全部接口**，无 HOST/BIND 环境变量（容器形态靠端口映射解决，裸 Node 无此层）。
- **影响**：若生产真是裸 Node——① 无 Restart 策略/资源限制/非 root 承诺，一次崩溃全部租户下线到人工介入（叠加 P2-10 的进程崩溃面）；② 端口公网可达时直连流量绕过 Caddy，且默认 proxy 档下 XFF 最后一跳完全由攻击者控制（README「访客 IP 信任档位」红线被默认组合违反）。
- **修复方向**：与 §1.2 联动——站长拍板后二选一：补齐裸 Node 形态（xwblog.service + `listen(PORT,'127.0.0.1')` 或 HOST env + 文档），或在文档明确「生产就是 Docker 形态」消除口径分裂（server.ts 的绑定收敛无论如何都建议做，见 P2-8 关联）。

#### P1-7 已删除图片经「变体 URL」永久可达——所有删除路径都不清理 `@宽.webp` 派生文件【已确认，实验复现】
- **证据**：媒体库删除 `src/api.ts:2265-2277` 只删原 key（已亲核）；`r2disk.ts:207-214` delete 只删传入 key 及其 meta；audit.ts cleanupUnreferenced/mergeDuplicate 的 `IMAGES.delete` 同样不带变体；`sitebundle.ts:394-428` collectBundleImageKeys 不含变体（不进 uploads 表，gen-variants.py:11-13 明确「不写旁车、不注册」）；/images 路由 `src/index.ts:382` 的 `u/` 前缀白名单拦不住孤儿变体，照常服务 + immutable 1y。
- **实验**（文件线 F 组）：删原图后 `orig.jpg@480.webp` 仍在磁盘、仍可 get。
- **影响**：站长删除图片（隐私/版权/撤稿）后，任何持原 URL 者**机械变换尾部即可永久访问 3 份衍生副本**；磁盘单调增长无 GC；CF 边缘副本也未 purge（purgeImageCache 只清原 key）。
- **修复方向**：删除/合并/清理/reset 的删图点同批删 `<key>@{192,480,960}.webp` 并传给 purgeImageCache（可在 r2disk.delete 单点做派生 key 级联）；gen-variants 加「原图缺失时删变体」反向清扫。

#### P1-8 媒体「体检 → 清理未引用」会误删正在使用的评论/会员头像【已确认】
- **证据**：头像落库 `comments.avatar`（api.ts:3499-3506）与 `members.avatar`（api.ts:667-668）；引用扫描 `src/audit.ts:137-158`（pullReferenceTexts）与 `:266-274`（REF_TABLES）都只有 users.avatar——**两张 avatar 列不在清单**；audit.ts:11-14 头注自己写着「新增存图片地址的字段时必须同步 pullReferenceTexts」，C2 头像功能（2026-10-07）没同步。已亲核。
- **影响**：后台「媒体 → 体检」把活跃头像标为未引用，一键清理即打瘫评论区头像（会员可重绑恢复、游客头像永久丢失直到同 QQ 再评论）；mergeDuplicate 合并头像同样断链；tests/audit.test.ts 未锁引用源清单，防线拦不住。
- **修复方向**：pullReferenceTexts 与 REF_TABLES 补 `comments.avatar`、`members.avatar`；audit.test.ts 加引用源清单快照守卫。

#### P1-9 视频元数据（含 iPhone 拍摄 GPS 坐标）不剥离；带旋转标记的 JPEG/GIF 整体跳过剥离【已确认（代码路径）；生产文件实际含 GPS 需抽样】
- **证据**：`src/exif.ts:17-32` 只认 JPEG/PNG/WebP 魔数，`store.ts:90` 对 mp4/webm 原样透传——iPhone 视频 GPS 在 moov/udta ©xyz atom 里随原片公开可下（/images 无访问控制）；`exif.ts:48-49,180-182` orientation≠1 整体跳过——竖拍手机照（orientation 6 最常见）EXIF 含 GPS 全保留。客户端压缩链路只救 >150KB 或 >2000px 的图；≤150KB 原图直传、采集转存、外站抓取的竖拍图都带元数据落库。变体产物干净（cwebp -metadata none）。
- **影响**：公开可下载视频携带拍摄位置与设备信息，与 exif.ts 建防线的意图相悖（只覆盖 2/5 种白名单类型）。
- **修复方向**：短期文档/上传提示如实告知；中期 exif.ts 加「剥 GPS IFD 保留 orientation」的字节手术（优于整体跳过）；宿主侧可用 ffprobe 体检既有文件。

#### P1-10 snapshot.sh 失败即整体退出 + backup.sh 无快照新鲜度检查 → RPO 静默老化【已确认（代码行为）】
- **证据**：`deploy/backup/snapshot.sh:5`（`set -euo pipefail`）+ `:28-31`（.backup 失败只 log「保留上一次快照」随即整脚本退出，跳过 config/tenants.json/meta 收集）；`backup.sh:53-56` 不检查 `snapshot_at` 新鲜度，MANIFEST 里该字段无消费者；无 `command -v sqlite3` 预检。
- **影响**：sqlite3 缺失/损坏、库路径变更、`.backup` 持续 BUSY 时，树莓派每天 03:30「成功」备份同一份陈旧库，全程无告警——备份成功表象下 DB 副本可静默老化数天，真实 RPO 无上界。
- **修复方向**：backup.sh 校验 snapshot_at 距今 ≤2h 否则 die；snapshot.sh 失败写显式 `meta/stale` 标记并进 `.complete` 校验；补 sqlite3 预检（与 P2-23 告警项同批）。

#### P1-11 restore.sh 对「目标机上有同名生产容器在跑」零守卫——先毁库后失败【已确认（代码层）；场景为运维动作】
- **证据**：`deploy/backup/restore.sh:134-172`（restore_data 直接 `install -m 644 ... blog.db` + `rm -f blog.db-wal/-shm`）→ `:203-226` start_one 在 **restore_data 之后**才因 8788/8790 端口被占用而失败；全程不检查/不停止 `xwblog-next`/`btchao-blog`。
- **影响**：在原甲骨文机做事故回滚时，运行中容器仍持旧 inode，覆盖主库 + 删 WAL 即损库——DR 脚本在它最该用的机器上是破坏性的。
- **修复方向**：restore_data 前检测运行容器即 die（提示先停），或提供 `--stop-containers` 显式步骤。

#### P1-12 备份/还原链路硬编码两租户——第三个站点静默无备份【已确认（现状两租户）；新增租户即成真】
- **证据**：`snapshot.sh:44-45`（两条写死路径）、`backup.sh:117-121`（verify_db 两个文件名 + 只拉一个 uploads）、`restore.sh:90,238-239`、`deploy/images/xwblog-image-variants.service:20-21`；而 `docs/DEPLOY-ORACLE.md:94-107`「新增一个站点」只教改 INSTANCES + tenants.json，**不提备份五处触点**。
- **影响**：按文档加站后，新租户 DB 与附件完全不在快照/拉取/还原范围，且所有校验照常全绿。
- **修复方向**：租户清单提为三脚本读同一来源（state.env 生成 `tenants=` 列表循环）；DEPLOY-ORACLE.md「新增站点」补备份接线步骤；image-variants 单元改读列表。

#### P1-13 news（快讯）主题 CSS 对共享语义类几乎零覆盖，但已在正式主题选择器中可选【已确认】
- **证据**：`src/themes/news.css` 仅 135 行，只覆盖 `nw-*` 壳 + `.rich`；共享构建器的约 50 个语义类全无样式（`.wb-cmt/.wb-composer/.cmt-form/.fl-card/.mem-card/.rk-item/.ar-item/.pn-nav/.hm-cell/.otd-card/.fs-chip/.pager/.paywall/.like-btn/.fc/.xw-readbar-fill/导航条 snav` 等，逐类矩阵见 frontend-themes/theme-css-matrix.md）；`registry.ts:326-331` 注册 + `/meta/themes` 可选。
- **影响**：选中后 /weibo、/guestbook、/member、/rank、/archives、/search 大面积退化为浏览器默认样式（评论表单不满宽、热力图塌陷、翻页裸链接、付费墙无框、阅读进度条不可见）。功能不丢，视觉半成品。
- **修复方向**：按 paper/minimal 的覆盖清单补 news.css（或暂从 `/meta/themes` 摘出标为原型）；补 tests/themes.test.ts「每主题 CSS 必须命中共享类最小集合」守卫。

### P2（27 项，紧凑展开）

**数据库 / 业务**

- **P2-1 WXR 导入 slug 预取滤掉回收站行，恢复时撞 UNIQUE**【已确认，已亲核】`src/api.ts:2872` `SELECT slug FROM posts WHERE deleted_at IS NULL` 与同处注释「含回收站占用行」及 `db.ts:419` uniqueSlugIn 口径相反；恢复端点（api.ts:2075-2076）UPDATE 不重生 slug → `UNIQUE constraint failed`，该文卡死回收站。修：预取去掉 WHERE（对齐 pages 侧）；或恢复遇 UNIQUE 自动加后缀。
- **P2-2 管理面 guestbook 同族查询漏 INDEXED BY，规划器实测误选索引**【已确认，EQP 实验】`src/api.ts:2354-2370`（/admin/comments 列表+计数）与 `src/mcp.ts:249-259`（list_comments）的 `post_id=0 AND weibo_id=0` 分支 → `SEARCH c USING INDEX idx_comments_weibo`（扫全部文章评论）；AGENTS P0-3 防线明文要求同族查询带 INDEXED BY 别信规划器。修：四处等值分支加 `INDEXED BY idx_comments_post`。
- **P2-3 listMemberReplies（/member「收到的回复」）r 侧扫全部已审评论**【已确认，EQP 实验】`src/db.ts:1993-2007` `member_id IS NOT ?` 非等值谓词不可索引 → `SEARCH r USING idx_comments_status`（生产 14k 行量级）；会员 3.0 新增的随 N 线性读路径，未过读放大记账清单。修：拆查询以「我参与过的 parent_id 集合」为主驱动；或走快照/缓存。（与 P3 圈层一致性项同函数，见 P3 组）
- **P2-4 备份/清理族挂 UTC 16:30 单分钟 tick，错过即整天跳过（无补偿）**【已确认】`docker-poc/server.ts:521,526` + `firedBackupDay` 内存态重启清零；00:30 那一分钟进程不可用 >60s → 当晚备份 + 全部清理（purgeVisits/purgeBots/purgeMemberVisits/purgeTrash/footstats/wbPubCount/onThisDay 校准）静默跳过，连日志都没有。修：窗口放宽「16:30-16:39 内首个未 fired 的 tick」。定时发布不受影响（每分钟扫，欠账下 tick 补齐）。
- **P2-5 每晚备份同步全量导出冻结多租户事件循环**【已确认】`server.ts:539-545` 逐租户串行 + `src/backup.ts:69-78` 17 张表全量物化 + JSON.stringify 整库 + r2disk put 同步 md5（基线：本机 5k 行 SELECT≈4ms、50MB 正文租户估算秒级冻结 × 多租户叠加）。同族：FTS 全量 rebuild（冷启动无感/热开台有感）。修：导出分片（复用 sitebundle 字节切片）或至少 README 标注备份窗口卡顿。

**适配层 / 运行时**

- **P2-6 r2s3 shim 不支持流式 put 与 Range get——`storage:"r2"` 租户整站包上传/导入双断**【已确认】`shims/r2s3.ts:75-80`（对流 throw → 上传 500）、`:156-161`（get 签名不收 range → ZipSource 拿到整包，解析必坏 + 100MB 全量入内存）；docker-poc/README.md:68-89 把 r2 列为一等选项。修：补 S3 Range 头与流式 put，或明确禁用 r2 租户的整站包入口并给可读错误。
- **P2-7 控制面公开投稿端点无上限**【已确认】`docker-poc/control.ts:1407-1450` /showcase-submit 会话门前公开：readBody 无上限堆内存 + 每次同步全量读写 submissions.json + 去重只按 URL、IP 只增不减。修：readBody 限 16KB、列表长度上限 FIFO、改内存限流桶。
- **P2-8 compose 默认 `0.0.0.0` 绑定 + 默认 TRUST_PROXY=proxy**【已确认】`docker-compose.yml` `XWLBLOG_BIND:-0.0.0.0` + docs/DEPLOY.md 快速开始未带 BIND；直连者 XFF 最后一跳可伪造（重置所有限流桶）。修：默认值翻转 127.0.0.1（DEPLOY-MICRO 已把「只绑回环」当铁律）；或 proxy 档 + 非回环监听时启动告警。
- **P2-9 Docker 容器日志无轮转**【已确认】`deploy-oracle.sh:169-180` 无 --log-opt；server.ts 每请求一条日志 → json-file 无限增长直到磁盘满。修：`--log-driver json-file --log-opt max-size=10m --log-opt max-file=3`。
- **P2-10 无进程级 uncaughtException/unhandledRejection 兜底；响应流 .pipe 无错误处理**【已确认（缺失）；触发面潜在】`server.ts:597-603` 只注册 SIGINT/SIGTERM；`:385` `Readable.fromWeb(appRes.body).pipe(res)` 无 error 回调（r2disk 读文件中途 ENOENT、客户端中止写事件 → Node ≥15 unhandledRejection = 进程退出）→ **单租户一次流异常 = 全部站点同时下线**。修：注册两个 process 处理器（记日志 + 优雅退出交给 Restart 拉起）；pipe 换 `stream.pipeline`。
- **P2-11 控制面 /enable 失败路径不一致**【已确认】`control.ts:1569-1584` 先写配置后 createTenantFor 无 try/catch（对比 /create 有回滚）→ 失败后配置 enabled 但路由未挂，运行期 404 直到重启。修：照 /create 同款回滚。
- **P2-12 r2s3 出站 fetch 无超时**【已确认】`shims/r2s3.ts:103-112` 裸 fetch（全 shim 唯一）；R2 僵死连接挂住请求，cron 串行备份被卡住后续租户全跳过。修：`AbortSignal.timeout(30_000)`。

**SEO**

- **P2-13 sitemap 文章条目 2000 篇静默截断**【已确认，实验】`src/db.ts:536` `LIMIT 2000` 硬编码（协议上限 5 万/50MB）；超限时最旧文章悄悄退出提交，无告警无文档。修：短期提 cap + 超限日志/后台提醒；长期按月分片 + sitemap index。
- **P2-14 siteNoindex='1' 时 llms 桩把真实站错标为「演示/预览实例」，.md 镜像不随动**【已确认】`src/index.ts:318` 落进 `llms.ts:132` 演示文案；`pages.ts:598-603` renderPostMarkdown 的 hidden 条件只含 aiDenied。修：buildLlmsStub 增加 noindex 档文案；评估 .md 在 siteNoindex 下同口径 404（与 deny 档对齐）。

**文件存储**

- **P2-15 /images 路由不支持 Range——自托管形态视频 seek/续传全无**【已确认；Safari 实际表现需生产验证】`src/index.ts:374-434` 无 Range/206/Accept-Ranges；CF 形态靠 caches.default 对已缓存条目自动切 206 兜住，Node 形态没有这层——每次拖进度条从 0 重下 25MB。修：解析 Range 头走 `IMAGES.get(key,{range})`（r2disk 已支持，实验 D 组验证）回 206 + Accept-Ranges。
- **P2-16 缺 `.meta.json` 的对象每次请求同步 md5 全文件（变体 100% 命中此路径）**【已确认，实验计时】`r2disk.ts:104` etag 回退；25MB head 46.26ms vs 0.128ms（360×）；触发面：全部 gen-variants 产物（设计如此不写旁车）+ 断流残文件 + 手工拷贝。修：按 `(path,mtime,size)` 记忆化 etag；或 gen-variants.py 补写 .meta.json（顺带写准 Content-Type）。
- **P2-17 `u/fav/` 友链图标绕过 saveUpload：不进 uploads 表**【已确认】`api.ts:1704-1730` 直接 put → 整站包导出漏全部友链图标（还原后 404，有 fetch-icon 兜底但体验破损）、resetSiteContent 漏删成孤儿、体检盲区；key `u/fav/<host>.<ext>` 可枚举（轻微探测面）。修：storeLinkIcon 补登记 uploads，或 collectBundleImageKeys 补扫 friend_links.icon。
- **P2-18 磁盘面无孤儿检测**【已确认】runAudit 只认 uploads 行，「磁盘有而库无」（变体/残文件/u/fav/手工）完全不可见；媒体占用统计低估。修：体检加「磁盘有而库无」差集一节（r2disk.list vs uploads 全集，注意限流/分页）。

**安全**

- **P2-19 自托管 DNS rebinding TOCTOU——同机 Caddy admin 接口是最高价值回跳目标**【潜在；文档已声明局限，自托管放大】`fetchsafe.ts:130-143` 只对主机名字符串判私网、fetch 阶段才解析；linkmeta/transferImage/插件安装/collect 均为管理员触发出网点；本机回环上 Caddy admin（默认 127.0.0.1:2019）可改写全部反代配置 ≈ 接管站点。修（最低成本）：Caddyfile `admin off` 或绑 unix socket；中期 Node 侧 dns.lookup 预解析钉 IP。
- **P2-20 编辑器插件「远程安装」无来源白名单/完整性校验**【已确认（行为）；评级为设计取舍】`pluginpkg.ts:36-42` 只验文本+registerPlugin 子串；装包即同源模块在后台执行（可调全部 /api/admin/*）；`pluginsInstalled` 记录来源但源内容被替换无告警。修：安装确认弹窗明示「此 JS 将以你的管理员身份运行」+ 内容哈希 pin（重装 diff 提示）；中期来源域名白名单。

**前端**

- **P2-21 前台 viewport 缺 `interactive-widget=resizes-content`**【已确认】`src/render.ts:110` 只有 viewport-fit=cover；AGENTS「全站移动端适配」红线两件套；贴底输入框（评论/发布器）Android Chrome 上可能被键盘遮住。修：一行补齐 + 跑 themes.test/冒烟。
- **P2-22 响应式变体只有 wechat 落地，其余 7 主题封面/头像/缩略图直出原图**【已确认】`grep variantUrl src/themes/*.ts` 仅 wechat.ts 6 处；正文图不受影响（responsiveContentImages 全主题统一）。小屏手机列表首屏仍拉全尺寸原图。修：抽共享助手或逐主题套 variantUrl（/images 对缺失变体有回退原图短 TTL 兜底，无裂图风险）。

**备份 / 文档**

- **P2-23 备份链路无失败告警**【已确认】`xwblog-backup.service` 无 OnFailure=/Restart=no；snapshot/backup 失败只落本地日志；应用内 TG 告警只覆盖 app 级备份不覆盖 shell 链路。修：service 加 OnFailure=（TG webhook）或哨兵文件巡检。
- **P2-24 树莓派是唯一异地副本且明文持有服务器敏感凭据**【已确认】单副本设计（Pi 盘坏=异地归零）；snapshot.sh:60-63 收集 x-ui.db（REALITY 私钥）与 hysteria 证书私钥进快照（Pi 入侵=代理面失守）。修（建议）：Pi 加第二跳（restic/borg → 对象存储，只备 server/db+data）；敏感配置 age 加密单独存放。
- **P2-25 文档平台口径漂移（宪法级）**【已确认】AGENTS.md:22/274/277、AI-COLLAB.md:35/39 仍按「CF 最终归宿/Workers Builds 推送即上线/wrangler d1 insights 查生产」书写，2026-11-03 起全部失实；AGENTS.md 全文 0 次登记 deploy/、DEPLOY-ORACLE.md、BACKUP-RASPBERRY.md。修：AGENTS「线上站点/部署链路」两节 + AI-COLLAB 文档地图改写（与 §1.2 联动）。
- **P2-26 website 文档中心生成物滞后**【已确认】guide.html（10-20）< GUIDE.md（11-01）、api.html（10-18）< API.md（11-01）、sitemap.xml 10-20；页面自称「与仓库 docs/ 同步」。修：重跑 `npm run build:docs`；进 RELEASING 清单或 CI。
- **P2-27 GUIDE/README/DEMO 部署陈述错误**【已确认】GUIDE.md:604「push main 会经 GitHub Actions 自动部署」（deploy.yml 实为 workflow_dispatch only）；README.md:46/120-125 自相矛盾；DEMO.md:106 同族。修：按「一键部署副本=Workers Builds；主站=甲骨文双实例」句式更新。

### P3（30 项，表格式）

| # | 项 | 位置 | 说明 |
|---|---|---|---|
| P3-1 | **tests/stats.test.ts 真钟依赖 flake** | tests/stats.test.ts:132-146 | 北京 00:00-01:00 插入的「今天」行错位必挂（业务线 00:06 复现两次）；注入固定 now 即修。测试卫生 |
| P3-2 | meta.changes 双引擎语义差 | src/api.ts 等 | node:sqlite 不计触发器（=1）、D1 计入（=2）——实验确认现有 `<1`/`===1` 判定全部安全；立规矩：触发器 OF 清单内列的写语句禁用 `===` 精确值 |
| P3-3 | node:sqlite 读 >2^53 INTEGER 抛 RangeError | shims/d1.ts | D1 静默截断；现绑定值域远离，登记备查 |
| P3-4 | findPublishedByOldSlug ORDER BY 带 `,0` 与索引失配 | src/db.ts:401 | 404 路径 TEMP B-TREE；去掉 `,0` 吃 idx_posts_chrono |
| P3-5 | WXR 图片替换 LIKE 预筛未声明 ESCAPE | api.ts:3039,3042 | 无实际损害（后续精确替换）；登记 |
| P3-6 | 无 VACUUM/ANALYZE 计划 | 全库 | DELETE 轮转 freelist 复用不膨胀；ANALYZE 缺席=规划器纯启发式（INDEXED BY 是正确解法）；可选每周 ANALYZE（按形态门控） |
| P3-7 | writeTenantsConfig 原地截断写，崩溃窗口=启动失败 | server.ts:129-137 | 写前留 .bak，读失败回退 |
| P3-8 | Node 形态无页缓存/设置快照/图床边缘缓存（实测确认） | pagecache/db.ts | 容量测算须按零缓存理解；README 显著标注 |
| P3-9 | 控制面仪表盘同步 dirSize 全树 stat | control.ts:1201,834-845 | 30-50 站规模秒级冻结；按 mtime 缓存 |
| P3-10 | ensureSchemaOnce 进程级单例不按 db 区分 | src/index.ts:35-44 | 仿 settingsInflight 用 WeakMap 按 db 键控 |
| P3-11 | cron tick 无重入护栏 | server.ts:519-546 | 既有双发护栏+原子 UPDATE 兜底，仅记录 |
| P3-12 | handle 兜底对已发头错误追加文本 | server.ts:580-584 | 改 res.destroy() |
| P3-13 | 控制面 /login 在 Origin 校验前（login-CSRF≈0） | control.ts:1380-1402 | 已论证影响趋零，保持现状可接受 |
| P3-14 | /images 对穿越样式 key 回 500（CF 形态 404） | r2disk safeJoin throw | 校验前置回 404，消除 500 噪音 |
| P3-15 | 流式 put 中断留残文件；ENOSPC 半截态 | r2disk.ts:155-170 | 失败清理 + .tmp+rename 原子化（gen-variants 同款） |
| P3-16 | gen-variants.py 运维细节 | gen-variants.py | ①固定 .tmp 并发互写 ②失败退出码恒 0 ③u/fav 覆盖键变体不更新 ④service 硬编码两租户（新租户永远无变体）⑤og/ 无谓生成 |
| P3-17 | 上传内存峰值 3-4×文件体积 | api.ts /admin/upload | 单管理员使用无虞；记账 |
| P3-18 | asset 单哈希捆绑前台+后台 5 资产 | server.ts:64-74 | 改任一侧全体缓存作废；拆两哈希 |
| P3-19 | admin.css/插件 JS 未版本化 | assets.ts:44 | CF 形态 4h 窗口混跑；Node 形态 ≤120s 可接受 |
| P3-20 | bitcoin/news 主题空态硬编码英文 | bitcoin.ts:124 等 | 统一走 tr() |
| P3-21 | journal 缺 .fl-grid/.fl-submit 样式 | journal.css | 确认设计意图，至少补按钮 |
| P3-22 | news.ts 冗余三目/缺 weiboHomeEntry/头像无变体 | news.ts:57-277 | 清理 + 补齐 |
| P3-23 | 点赞失败静默无反馈 | site.js:631 | 给失败态或 toast |
| P3-24 | admin.css 编辑器查找栏 13px 覆盖 16px 规则 | admin.css:426 | iOS 聚焦放大；媒体块补一条 |
| P3-25 | /archives 单页 DOM 上限 2000 行无分页 | db.ts:470 | 设计取舍（利于收录+pagecache）；逼近上限再按年分片 |
| P3-26 | 会员「收到的回复」未过 applyCommentGate（存量泄漏） | db.ts:1987-2008, pages.ts:1287-1301 | 60 字摘要本人私有页、量级小；与 P2-3 同函数可同批修 |
| P3-27 | 邀请码有效性预言机在 Turnstile 之前 | api.ts:437-449 | 枚举不可行；挪序或统一文案 |
| P3-28 | tenants.json 固定 644，启用 r2 时凭据全局可读 | add-tenant.sh:84-86 | r2 配置拆独立 0600 文件 |
| P3-29 | 部分管理端 500 透传内部错误串 | api.ts:2750, control.ts:1512 | 收敛通用文案+服务端日志 |
| P3-30 | 备份运维杂项 | deploy/backup 等 | ①rsync TOFU 建议预置 known_hosts ②每月快照永久保留无上界 ③仓库硬编码生产 IP/Pi 内网 IP（开发仓公开即泄拓扑，建议 env 化）④verify_db 与 snapshot 30min 节奏竞争（fail-safe 次日自愈）⑤r2s3 模式悄然离开备份范围 ⑥restore.sh 依赖未声明/注释失实 ⑦还原文档缺「备份点后上传的图丢失」说明 ⑧image-variants 单元无安装文档 ⑨cf-purge.env 不在备份 ⑩BUNDLE_TABLES 计数注释漂移（11/12 vs 实测 16）⑪migration-memos README 仍 Workers 口径 ⑫AGENTS 缺 MAX_IMPORT_COMMENTS 登记 ⑬plaza hub D1 无备份（应写明可丢口径）⑭官网文档中心不含两份自托管运维文档（疑似刻意，无文字说明）⑮评论删除/退审无积分回冲（设计取舍，建议文档明确） |

---

## 3. 需生产验证清单（需要站长/生产环境数据定论）

| # | 问题 | 需要什么 | 关联发现 |
|---|---|---|---|
| 1 | 生产进程监督形态：Docker 容器替换 or 裸 systemd Node？ | 站长一句话确认（或服务器 `docker ps` / `systemctl list-units`） | §1.2、P1-6、P2-25 |
| 2 | 域名接入形态：CF 橙云回源 or DNS-only 直连 Caddy？ | 服务器抓一次回源请求头（`curl -H 'Host: …' http://127.0.0.1:8788 -v` 看经反代后的 XFF/CF-Connecting-IP） | P1-5 |
| 3 | 各租户 blog.db 体量与上传目录大小 | `ls -lh /opt/xwblog-data/*/blog.db` + `du -sh uploads` | P2-5、P2-16 量级校准 |
| 4 | iOS Safari 对无 Range 的 `<video>` 实际表现 | 手机实测微博视频拖进度条 | P2-15 |
| 5 | IndexNow 提交在 Node（undici）形态是否实际失败（manual 重定向被弃） | 生产日志 grep `[indexnow]` | SEO P3（hooks.ts:856） |
| 6 | 评论落库 IP 是否已是 CF 节点 IP | 后台评论列表看 IP 形态 | P1-5 影响实证 |
| 7 | 现存视频文件是否含 GPS 元数据 | 抽样 ffprobe | P1-9 影响实证 |
| 8 | douban-relay 与 plaza hub 当前生产运行形态 | 站长确认（douban-relay 不在 deploy/ 覆盖内；plaza=独立 CF Worker） | 架构报告 12.5 |

---

## 4. 已检查且无问题（分域绿名单，负面结论也是审计结论）

**安全（结论：无 P0/P1）**
- 鉴权矩阵：全部 751 行起的 /admin 路由注册在会话中间件（api.ts:704）与 author 白名单（713-728）之后；223-700 行只有 health/auth/member；新增 invites/member-tiers/members 端点不在 author 白名单（正确，站点管理语义）；redeem 有统一守卫+登录+banned+限流+原子扣费
- CSRF：全局 Origin 同源校验 + SameSite=Lax 双保险；解锁端点单列校验+按文按 IP 限流；控制面业务 POST 全在 sessionOk+originOk 之后；未发现可利用 CSRF
- XSS：admin SPA 63 处 innerHTML 逐一抽检全 esc/服务端可信；site.js 新增渲染全 esc；档位色经 cleanTierColor 白名单；skinpack 双净化；无 eval/document.write/内联事件（9 文件统计全 0）
- SSRF：出网点全盘点——fetchsafe 通道 14 处 + 固定可信端点 8 处 + douban 固定主机表；38 个 URL 形态实验（整数/十六进制/八进制 IPv4、IPv6 全形态、user@、169.254、CGNAT、localhost 变体…）全部正确 REJECT/PASS
- 会话：PBKDF2 10 万次+16 字节盐；token 32 字节随机；库内无明文 token 查询残留；TOTP 恒时三窗口；过期会话 cron 清+登录清+10 上限；三 Cookie 属性齐全
- 注入：SQL 全参数化（新增 invite/redeem 核对无拼接）；Location 全代码构造无开放重定向；TG 通知纯文本
- 信息泄漏：全局 500 固定文案；SECRET_SETTINGS 9 键双向打码；微博评论 JSON 显式列清单 email/qq/ip/tier_expires_at 均不出
- `npm audit --omit=dev` 0 漏洞；tsconfig strict

**数据库**
- schema.sql 与 db.ts SCHEMA_* 三份表达逐列/逐索引对照一致（含 invite/member_visits/member_likes 新表）
- 软删过滤：三表全部读路径核对带 deleted_at IS NULL；故意不过滤点与 AGENTS 例外清单一致（唯一漏网是方向相反的 P2-1）
- INDEXED BY 8 处使用点与 SCHEMA_INDEXES 一一对应；HTTP listen 在建库之后无冷启动窗口；缺索引=prepare 期硬报错（与 D1 同语义，实验验证）
- EQP 全量 45 条：首页/微博流/深翻页/评论计数/FTS/sitemap/归档/排行全部精准命中，无新增违规形态
- FTS 防线（ftsMatchExpr 唯一入口、加密文退出、触发器只在 SCHEMA_TRIGGERS）完整
- getSettings 快照按 db 实例隔离不串租户；语句缓存 DDL 清缓存正确；batch 事务与 D1 等价（实验验证）
- 本地 .wrangler 库 integrity_check ok、foreign_key_check 0 违例
- inject 面：全部 `${}` 拼接点白名单核对（表名/列名/ORDER BY/LIMIT 全收口）

**业务**
- 定时发布：重启欠账下 tick 补齐、`UPDATE ... WHERE status='scheduled'` 原子单发、恢复过期定时文转草稿防线完整
- PUT 缺键即保留：has 清单覆盖全部字段（含 minTier/password/video/pinned 转草稿归零）
- 会员四层：effectiveTier 全判定点唯一出口、会话 SQL 带出 tier_expires_at、到期边界毫秒比较+北京日
- 邀请码：原子核销+抢输回滚+备份登记+爆破不可行（32^8+限流+Turnstile）
- 积分：批内条件写互斥谓词、spendPoints 幽灵账本修复到位、签到三道幂等
- 评论：限流/蜜罐/先审后展/圈层三读侧服务端截断、写侧线程根判定、出参剥 tier_expires_at、级联删除走 idx_comments_parent
- 密码墙+付费墙组合、teaserHtml 截断、RSS/llms/.md 防泄漏、/random 与搜索排除——全链复核未回归
- 微博：话题三镜像未动、25MB/魔数/HEVC 链路未回归、置顶原子名额含恢复路径
- sitebundle 三契约（空站守卫/身份排除/版本三向）与 reset 顺序、回收站级联守卫——全部保持

**Node 运行时**
- 内存有界：rateLimit 5000 上限淘汰、tgDoneUpdates 500、bots gate 400、控制面会话 100、stmtCache 256——key 无上界 Map 仅 P0-1 与 P2-7 两处（均已列）
- 请求生命周期：Node 默认 requestTimeout=300s/headersTimeout=60s 适用（slow-loris 有默认防护）
- 部署脚本：flock/last-failed 门/健康检查带 Host/逐实例回滚/镜像裁剪/CF purge 失败不翻部署结果；数据目录与代码目录分离，部署不碰数据（git check-ignore 实测）
- 控制面：safeEqual 常时比较+限流+12h 会话+HttpOnly/SameSite/Secure 按档；/reset 新密码不落日志
- 日志：不含 query/token/cookie/密码；tenants.json 仅演示条目无凭据；*.log/data/ 均正确 gitignore
- 静态服务与 safeJoin 双实现穿越防线 solid（实验 A 组）

**SEO**
- 全部绝对 URL 构造点收口 siteUrl（除 P1-4 一处）；跨租户缓存污染不成立（键带 host）
- canonical 分页实现正确（7a1e3c7 复核）；lastmod 三口径全真实时间；标签页 noindex+自指与 sitemap 互斥
- JSON-LD isAccessibleForFree 选择器与实际 DOM 一致；404/软 404/301 语义全对（含旧 slug 窗口外必须 404）
- robots 基线逐字节、AI 三档、Content-Signal、Speculation Rules、max-snippet 全部符合登记口径

**前端/主题**
- 8 主题 10 模板函数全实现零缺页；共享构建器调用矩阵零漂移；member/rank/page 有运行时兜底
- pagecache 键=epoch/host/path/规范化 query，三 Cookie 挡缓存方向安全；html-etag 只碰 200+text/html+无 Set-Cookie，无会话串号（缓存键=内容哈希，无会话输入）
- 资产版本化 v 校验只认自算哈希，失败模式安全（落回 max-age=120）；sw.js 透传无冲突
- site.js ES5 红线全合规（0 箭头/0 let/0 const/0 模板串/0 lookbehind；例外仅登记过的 2 处）；isComposing 守卫 11 处全带
- 8 主题移动断点/16px/横滚齐备；admin SPA 红线（无内联事件/pickFiles/navigate 防串页/MENU 登记/密钥打码）全过；9 个 JS node --check 全过

**备份/DR**
- DB 备份一致性链路正确：`.backup` 一致性快照 + integrity_check + sha256 记账 + `.complete` 防半成品 + 还原前再验 + rm -wal/-shm 顺序正确（**不是裸拷贝**）
- rsync --link-dest/--delete 用法正确；bash -n 全过；systemd 单元人工核对无语法问题
- RPO/RTO：server 侧快照 ≈30min；树莓派副本 ≈24.5h；Pi 接管 RTO ≈15-30 分钟；新云主机 ≈2-4 小时
- /images 只放行 u/ og/——backups/、bundles/（含密钥的备份 JSON）不公开可达
- gen-variants.py 魔数嗅探/绝不放大/原子落盘/SKIP_DIRS 含 backups/ 与备份共存

---

## 5. 测试执行记录

| 时间 | 动作 | 结果 |
|---|---|---|
| 11-04 23:0x | `npm run typecheck` | ✅ 通过 |
| 11-04 23:0x | `npm test`（全量） | ✅ 1006/1006（11.5s） |
| 11-05 00:06 | 业务线复跑全量 | ⚠ 1005/1006——stats.test.ts 挂（真钟 flake，P3-1；产品代码口径正确） |
| 11-05 01:10 | 审计长复跑全量 | ✅ 1006/1006（6.7s，已出午夜窗口） |
| 审计期内 | SEO 线复跑 seo/canonical/jsonld/llms/og/rss/html-etag 七套 | ✅ 67/67 |
| 审计期内 | 业务线复跑 invite/redeem/commentgate/batch2/weibo-comments-retry/tiers 六套 | ✅ 46/46 |
| 审计期内 | 业务线复跑 member-tiers/multi-author/feed-index/readamp/members 等 | ✅ 全绿（含于全量） |
| 未执行 | `npm run smoke`（需起 wrangler dev 全链路） | 留给阶段 D（修复落地后）执行——冒烟是回归守卫不是发现工具，且本轮全部发现已由代码/实验/单测证据支撑 |

## 6. 方法学说明

- 8 路专项审计各自独立执行并出具子报告（全文收录在会话记录中，要点已合并进本报告并去重；去重合并的对：Node 线 P2-2 ≡ 文件线 P2-2（r2s3）、业务线 P0 ≡ 安全线 P3-5③（限流）、业务线 P2-4 ≡ 备份线 P2-2（tick）、业务线 P2-3 ≡ 安全线 P3-1（member replies））
- 审计长（本会话）对全部 P0/P1 逐条亲核证据：server.ts:152 顺序、index.ts:302、DEPLOY-MICRO.md:92、api.ts:2872 与 db.ts:419、auth.ts:179、api.ts:3373、external.ts:33、api.ts:2265-2277、audit.ts:137-158/266-274——全部成立
- 实验均为纯函数/临时库级（node:sqlite scratch 库、r2disk 临时目录、fetchsafe 纯函数段转译），零出网、零生产接触、零仓库写入
- 未发现的问题不等于不存在：并发竞态类（P2-5 的实测冻结量级）、生产配置类（§3 清单）需生产环境数据定论

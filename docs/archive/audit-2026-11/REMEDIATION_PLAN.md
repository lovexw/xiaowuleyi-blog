# REMEDIATION_PLAN — xwblog 修复计划（阶段 B）

> 依据：`AUDIT_REPORT.md`（阶段 A，编号一一对应）。执行载体：阶段 C 在独立分支 `audit/2026-full-project-review` 上按批次逐项修复（**每个独立任务一个提交**：改码 → 查 diff → 相关测试 → 全量回归 → 记录 → 提交；不混合互不相关的修改）。
> 全局纪律（继承 AGENTS.md）：每批次合并前 `npm run typecheck` + `npm test` 必须全绿；动了 SQL 拼接/渲染/路由加跑 `npm run smoke`；新增防线登记进 AGENTS.md；**未经站长明确指示不推送**（本仓库推送触发生产部署）。

## 0. 批次总览与顺序

| 批次 | 主题 | 包含 | 预估规模 | 前置 |
|---|---|---|---|---|
| R1 | 多租户隔离（P0+跨租户 P1） | P0-1、P1-2、P1-3 | 小（3 处核心改动+测试） | 无 |
| R2 | 启动与 schema 安全 | P1-1、P3-10 | 小 | 无 |
| R3 | 删除/引用完整性 | P1-7、P1-8、P2-17、P2-18、P3-14 | 中 | 无 |
| R4 | SEO 收口 | P1-4、P2-13、P2-14、P3-4 | 小 | 无 |
| R5 | Node 适配层加固 | P2-10、P2-8、P2-9、P2-7、P2-11、P2-12、P3-7、P3-12、P2-6 | 中 | 无 |
| R6 | 备份链路（shell，不进代码） | P1-10、P1-11、P1-12、P2-23 | 中 | 生产形态确认（§4） |
| R7 | 隐私（媒体元数据） | P1-9 | 中 | 无 |
| R8 | 前端与主题 | P1-13、P2-21、P2-22、P3-20/21/22/23/24 | 中 | 无 |
| R9 | 读放大与性能 | P2-2、P2-3（+P3-26）、P2-16、P3-6（可选）、P2-5（可选） | 中 | 无 |
| R10 | 文档与宪法对齐 | P2-25、P2-26、P2-27、P3-30、P2-24（建议案） | 中 | **站长拍板 §4** |
| R11 | 测试卫生 | P3-1、P3-2（立规矩登记） | 小 | 无 |
| — | 需站长拍板后才动 | P1-5、P1-6、P2-19（Caddy 配置在生产侧）、P2-20（信任边界产品决策） | – | §4 |

建议执行顺序：R1 → R2 → R4 → R3 → R9 → R5 → R11 → R8 → R7 → R6/R10（后两者依赖站长答复，可并行推进）。

---

## 1. P0 / P1 修复卡（编号/问题/证据/等级/原因/位置/方案/兼容性/测试/验收）

### R1 批次

**P0-1 限流桶跨租户共享**
- 问题：单进程多租户下所有站点共用同一组内存限流计数器；`backup:global` 等字面量桶跨站互斥。
- 证据：auth.ts:179 模块级 Map；api.ts:307/428/3379 等 key 无租户维度；api.ts:2744/2763/2810 三处 `*:global`（详见 AUDIT_REPORT P0-1）。
- 等级：P0｜原因：机制按「每 isolate 一份」设计，docker-poc 单进程打破前提；同批 shouldCountView 已修同类问题，rateLimit 漏改。
- 位置：src/auth.ts（rateLimit）；src/api.ts（40+ 调用点 + 3 处 global 字面量）。
- 方案：`rateLimit(key, limit, windowMs)` 增加第 4 参 `scope`（调用侧传租户标识，从 `c.env` 取——server.ts 已把 host 写进 env 或由中间件注入；实现取「最小侵入」：新增 `rateLimitFor(env, key, ...)` 包装，内部 key = `${tenantId}:${key}`，tenantId 由 env 弱映射或显式字段提供）。`*:global` 三处 key 拼 host。Workers 形态行为不变（isolate 内 host 恒定）。
- 兼容性影响：无接口变化；部署瞬间内存桶清零（本来就会，重启语义）；测试中直调 rateLimit 的用例需过包装或保持原函数用于纯测试。
- 测试方式：新增回归用例（两个模拟 env/租户，同 IP 互不挤占；`backup:global` A 站消耗后 B 站可用）；跑 tests/auth.test.ts + 全量。
- 验收：新用例双租户断言通过；全量 1006+ 全绿；AGENTS.md「会员体系/防线」处登记 rateLimit 租户维度规矩。

**P1-2 TG webhook 幂等键跨租户碰撞**
- 问题：`tgDoneUpdates` 以裸 update_id 为键，跨 bot 序列重叠 → B 租户合法消息被当重投丢弃；`tg:${chatId}` 限流同理。
- 证据：external.ts:33/479/536。
- 等级：P1｜原因：同 P0-1（isolate 假设）；2026-11 刚修过「先记后做」问题但租户维度未补。
- 位置：src/external.ts（tgUpdateDone/tgMarkDone/限流 key；webhook 路由入口有 c.env 可取 host）。
- 方案：键改 `${host}:${updateId}`（host 从请求 env 取；拿不到时回退 token 前缀哈希）；限流 key 同拼。TTL/容量逻辑不变。
- 兼容性影响：无；部署瞬间幂等记忆清零（5 分钟 TTL 本来就短）。
- 测试方式：新增双租户同 update_id 用例（A 处理后 B 仍正常处理）；tests/ 现有 TG 用例回归。
- 验收：新用例通过；全量绿。

**P1-3 publicComment 会员分支缺 membersEnabled 门控**
- 问题：关闭会员功能后，残留 `xw_member_session` 用户仍以会员身份发言并计分。
- 证据：api.ts:3373（无条件 getMemberUser）对照同文件 :3648 与 pages.ts 四处正确实现；AGENTS「会员体系」节明文要求。
- 等级：P1｜原因：防线登记在案但实现遗漏（新公共留言路接线时漏抄门控）。
- 位置：src/api.ts publicComment 一处。
- 方案：`const member = user ? null : (settings.membersEnabled === '1' ? await getMemberUser(...) : null)`。
- 兼容性影响：与登记语义一致（关闭时按游客发言不计分）；无出参变化。
- 测试方式：新增用例（membersEnabled='0' + 有效会员会话 → 评论落库 member_id 为空、不进积分）；batch2-regressions 同族补一条。
- 验收：新用例通过；全量绿；AGENTS 该防线条目标注「已由测试钉住」。

### R2 批次

**P1-1 server.ts 建表顺序（先 schema.sql 后 ensureSchema）**
- 问题：老库（缺 ALTER 补列）或未来「schema.sql 加列+建索引」发布在启动期 exec 抛错 → 全租户崩溃循环。
- 证据：server.ts:152-153 + schema.sql:166/169/233/234/345-347（七条索引引用 deleted_at/pinned）；实验复现（no such column）。
- 等级：P1｜原因：D1 形态由部署时 `d1 execute` 分担建表，Node 形态把整份 schema.sql 放在增量迁移之前。
- 位置：docker-poc/server.ts createTenantFor 两行。
- 方案：调换顺序——先 `ensureSchema(env.DB)`（其 SCHEMA_TABLES 全列建表 + 先 ALTER 后建索引）再 `db.exec(SCHEMA_SQL)`（此时 CREATE TABLE IF NOT EXISTS 全 no-op、索引全部可建）；或 exec 包 try/catch 降级交给 ensureSchema。取前者（语义清晰）。
- 兼容性影响：新库双跑幂等（实验已验证 schema.sql 幂等；SCHEMA_TABLES 建表语句自带全部列——AGENTS 既有硬规矩保证）；老库 ALTER 补列后索引可建。
- 测试方式：新增 Node 适配层单测（构造「缺 deleted_at/pinned 的老库」→ createTenantFor 成功启动 + 业务查询可用；复用实验 exp2 场景做成测试）；docker-poc/smoke.sh 全链。
- 验收：新用例通过；smoke 绿；AGENTS「部署链路」节登记「schema.sql 索引只准引用建表列体」硬规矩（ALTER 补列的索引只进 SCHEMA_INDEXES）。

**P3-10 ensureSchemaOnce 进程级单例**（同批顺手）
- 方案：`schemaReady` 改 WeakMap 按 db 实例键控（仿 settingsInflight）。兼容性：无。测试：现有 ensureSchema 用例 + smoke。验收：每租户首请求自跑 ensureSchema。

### R4 批次

**P1-4 robots.txt Sitemap 行跟请求 Host**
- 证据：index.ts:302；实验 #3 复现。
- 等级：P1｜原因：全站唯一漏收口的绝对 URL 构造点（其余全走 siteBase）。
- 方案：改传 `siteBase(settings, new URL(c.req.url).origin)`。
- 兼容性：siteUrl 已配置的站，正确 Host 访问输出字节不变；ROBOTS_BASELINE 测试传参与 siteUrl 一致不破。
- 测试：tests/seo.test.ts 补「settings.siteUrl=A + 请求 origin=B → Sitemap 行用 A」用例；全量。
- 验收：新用例通过；全量绿。

**P2-13 sitemap 2000 截断**：db.ts:536 cap 提到 50000（协议上限内）+ 超限时 console.warn 与 /admin/stats 记数（后续再评估分片）。兼容性：条目变多纯增量；测试：构造 >cap 数据集断言不截断 + 超限告警出现。
**P2-14 siteNoindex llms 桩**：buildLlmsStub 增加第四态文案「本站已声明不希望被收录」；renderPostMarkdown 的 hidden 条件补 siteNoindex（与 deny 档对齐 404）。兼容性：siteNoindex 站的 .md 从 200 变 404（该口径本就该与 noindex 一致；llms 侧 AGENTS 已登记同口径先例）。测试：tests/llms.test.ts 补 noindex 档断言。
**P3-4 ORDER BY `,0`**：db.ts:401 去掉 `,0`；跑 tests/oldslug.test.ts + EQP 复验吃 idx_posts_chrono。

### R3 批次

**P1-7 删除路径不清理变体派生文件**
- 证据：api.ts:2265-2277（媒体删除）、audit.ts:336-356/316（清理/合并）、sitebundle.ts:345-349（reset）；r2disk delete 不级联（实验 F 组）；/images 白名单放行孤儿变体 + immutable 1y。
- 等级：P1｜原因：变体线（528d774）只做了生成侧，删除侧五条路径全部未接线。
- 位置：src/api.ts（媒体删除）、src/audit.ts、src/sitebundle.ts、src/index.ts（purgeImageCache 调用点）、docker-poc/shims/r2disk.ts（可选单点）。
- 方案：首选在 r2disk.delete 单点级联（对每个删除 key 追加删 `<key>@192/480/960.webp`——变体命名规则 `variantBaseKey` 已有单点）；同时各调用点把派生 key 一并传给 purgeImageCache。r2s3 形态走应用层级联兜底（保持 shim 纯粹）→ 实现为应用层 `deleteImageWithVariants(env, keys)` 助手，五条删除路径统一换用。
- 兼容性：多删不存在的 key 是 no-op（r2disk force:true / R2 delete 幂等）；不碰非变体文件。
- 测试：单测（删原 key 断言三个变体同时消失、无变体时无害）；r2disk 实验 F 组场景固化为测试；smoke「媒体删除」段回归。
- 验收：删除任意原图后变体 URL 立即 404；审计「孤儿变体」数为 0。

**P1-8 引用源清单缺两张 avatar 列**
- 证据：audit.ts:137-158（pullReferenceTexts）、:266-274（REF_TABLES）缺 comments.avatar、members.avatar；头注 11-14 自述同步义务未履行。
- 等级：P1｜方案：两处补列（`SELECT avatar AS v FROM comments WHERE avatar LIKE '%/images/%'`、同款 members）；audit.test.ts 加「引用源清单快照」守卫（列清单常量与 pullReferenceTexts 的 SELECT 逐一对齐）。
- 兼容性：体检「未引用」结果变少（修正假阳性）；无删除行为变化。
- 测试：新增「评论头像不被标未引用」用例 + 清理端到端用例；全量。验收：在用头像不再进清理名单。

**P2-17 u/fav 绕过 uploads 表**：storeLinkIcon（api.ts:1704-1730）put 后补 INSERT uploads（name=host、size、mime）；或 collectBundleImageKeys 补扫 friend_links.icon。取前者（整站包/体检/统计/孤儿检测一次全修）。兼容性：无；既有存量图标由 audit 的磁盘差集（P2-18）回填。测试：单测断言整站包含图标 + 体检可见。
**P2-18 磁盘孤儿检测**：runAudit 增「磁盘有而库无」差集段（r2disk.list 限流分页 vs uploads 全集；变体与 u/fav 已由 P2-17/本条口径归位），只报告不自动删（与「宁少删不错删」纪律一致）。测试：单测（磁盘放杂散文件 → 报告出现、库内文件不报）。
**P3-14 穿越样式 key 500→404**：/images 路由 decode 后前置校验（含 `..`/`\`/`\0` 直接 404）。测试：单测三条路径断言 404。

### R5 批次

**P2-10 进程级兜底 + 流错误**
- 证据：server.ts:597-603（无 uncaughtException/unhandledRejection）；:385 pipe 无 error 回调。
- 方案：① 注册两个 process 处理器：记 `[fatal]` 日志后 `process.exit(1)`（交给 `--restart unless-stopped`/systemd Restart 拉起——多租户共进程下「带病运行」风险大于重启代价）；② `sendToNode` 的 pipe 换 `stream.pipeline(..., cb)`，cb 里 `res.destroy()` + 记日志。
- 兼容性：行为变化=崩溃后自动重启（当前=可能僵死或崩溃后无人拉起）；正常路径无感。
- 测试：手工/冒烟（模拟流错误断言进程存活或干净退出）；docker-poc/smoke.sh。
- 验收：断流场景不再产生 unhandledRejection 崩溃；崩溃被 Restart 拉起。

**P2-8 绑定默认值**：server.ts `listen(PORT, process.env.HOST || '127.0.0.1')`——**注意**：Docker 容器内必须绑 0.0.0.0 才能被端口映射转发，故默认值需区分形态：容器由 entrypoint/Dockerfile 传 `HOST=0.0.0.0`，裸进程默认回环。同时 compose 默认 `XWLBLOG_BIND:-127.0.0.1`。兼容性：compose 升级后容器内已显式传（检查 docker-compose.yml environment 补 HOST=0.0.0.0）；deploy-oracle.sh 的 `-p 127.0.0.1:8788:8787` 不变。测试：smoke（本地起服断言 127.0.0.1 可达）+ 文档同步。
**P2-9 日志轮转**：deploy-oracle.sh start_container 补 `--log-driver json-file --log-opt max-size=10m --log-opt max-file=3`；文档手动命令块同步。
**P2-7 showcase-submit 上限**：readBody 限 16KB（超 413）；submissions 列表长度上限 200 FIFO；限流改内存桶。兼容性：正常表单远小于上限。测试：控制面用例（超限 413）。
**P2-11 /enable 回滚**：照 /create 补 try/catch（失败回写 disabled:true + flash 错误）。
**P2-12 r2s3 超时**：s3fetch 加 `AbortSignal.timeout(30_000)`。
**P2-6 r2s3 流式 put + Range get**：put 支持流（S3 PutObject 需 Content-Length：先落临时文件再发，或缓冲 ≤100MB——与 bundles 上限一致，取临时文件方案对齐 r2disk 语义）；get 增 opts.range → `Range: bytes=start-end` 头解析（206 语义在 makeObject 层补齐对齐 r2disk）。兼容性：r2 租户整站包从「必断」变「可用」；无存量行为破坏。测试：单测 mock S3（Range 头断言）+ 文档 README 标注 r2 模式整站包已支持。
**P3-7 tenants.json .bak**：writeTenantsConfig 写前 `copyFileSync` 到 `.bak`；readTenantsConfig 失败时尝试 `.bak`。
**P3-12 已发头错误**：handle 兜底 else 分支改 `res.destroy()`。

### R9 批次

**P2-2 管理面 guestbook INDEXED BY**：api.ts:2354-2370（列表+计数）与 mcp.ts:249-259 的等值分支加 `INDEXED BY idx_comments_post`。兼容性：无（硬约束索引已在 SCHEMA_INDEXES 兜底）。测试：tests/feed-index.test.ts 守卫计数同步（AGENTS 规矩：改动后更新守卫计数并跑真库断言）。
**P2-3 listMemberReplies 读放大**：拆查询——先查「我参与过的线程根集合」（走 idx_comments_member/idx_comments_parent），再按 parent_id IN 查 r（等值谓词可索引）；同时给 r 行带出 member_tier/tier_expires_at 供 P3-26 的圈层过滤（两问题一次修）。兼容性：出参排序/去重口径保持（「我参与过的线程里别人的回复」归账不变，r.member_id IS NOT ? 保留）。测试：tests/member 相关 + 新增 EQP 断言（feed-index 风格）+ 圈层过滤断言。
**P2-16 缺 meta etag 记忆化**：r2disk makeObject 对缺 meta 文件按 `(path,mtime,size)` 记忆化 etag（Map 上限 + mtime 失效）；**同时** gen-variants.py 补写 .meta.json（一行等价 writeMeta，顺带写准 Content-Type——根治）。兼容性：无。测试：r2disk 单测（同文件两次 head 第二次不走 md5——计时断言或注入计数）。
**P2-5 备份导出分片（可选，量大后置）**：backup.ts 改按表分片/字节切片直传（复用 sitebundle 思路）；先在生产实测 db 体量（§4-Q3）再决定是否本期做。**P3-6 每周 ANALYZE（可选）**：备份 cron 分支按形态门控执行（D1 不支持需 isNode 判断），先不做，登记。

### R8 批次

**P1-13 news 主题 CSS 补齐**：按 paper/minimal 覆盖清单补 news.css 全部共享语义类（wb-*/cmt-*/fl-*/mem-*/rk-*/ar-*/pn-nav/hm-*/otd-*/fs-*/pager/paywall/like/share/fc/snav/xw-readbar-fill）；news.ts 补 weiboHomeEntry 渲染（或与站长确认快讯形态是否刻意不带首页微博入口）。兼容性：纯样式新增，无 DOM/结构变化。测试：tests/themes.test.ts 全 8 主题渲染回归 + 新增「每主题 CSS 必须命中共享类最小集合」守卫用例（52 类矩阵关键行）；390px 目检建议站长过目。
**P2-21 viewport**：render.ts:110 补 `interactive-widget=resizes-content`；跑 themes.test + 冒烟。
**P2-22 变体铺满 7 主题**：render.ts 抽 `coverVariant(cover, width)` 助手，7 主题 img 套 480/960/192（对照 wechat 用法）；news.ts:57 头像 192。兼容性：/images 对缺失变体回退原图短 TTL（无裂图）；存量图变体未生成前回原图（回退已有）。测试：themes.test 镜像断言（srcset 存在性）+ image-variants.test 回归。
**P3 杂项**：P3-18 拆前台/后台两哈希；P3-19 admin.css 入版本化（injectAdminAssetVersion 重写 link）；P3-20 bitcoin/news 空态走 tr()；P3-21 journal 补 .fl-submit（.fl-grid 确认设计意图）；P3-22 news 三目清理；P3-23 点赞失败 toast；P3-24 findbar 16px。

### R7 批次

**P1-9 媒体元数据剥离缺口**
- 方案分两步：① exif.ts 增加「JPEG/WebP 剥 GPS IFD / XMP GPS 段但保留 orientation」的字节手术（替代整体跳过——直接消除「竖拍图带 GPS」主泄漏面）；② 视频暂不做字节手术（mp4 ©xyz 剥离复杂度高），先做三件事：上传成功 toast 文案补「视频可能包含拍摄位置信息」提示（前后台各一处）、GUIDE §8.4 增「视频隐私」小节、`scripts/` 增 `--dry-run` 式体检脚本（ffprobe 可选依赖，扫 uploads 报含 GPS 的 mp4 清单）供站长对存量处置。GIF/ICO 登记不处理（无实质敏感面）。
- 兼容性：①只影响新上传与重新上传；存量文件靠脚本清单处置（不自动改写，遵守「未验证不删改」纪律）。
- 测试：tests/exif.test.ts 补 orientation=6 带 GPS 的 JPEG 样本断言（GPS 段消失、orientation 保留、图可解码）；现有全量回归。

### R11 批次

**P3-1 stats 测试真钟 flake**：getVisitStats/tests 注入固定 now（函数加可选 now 参数，默认 Date.now()——与 fanDay 可注入同款先例）；stats.test.ts 全部用固定 now。验收：任意时刻跑 stats.test 稳定绿。
**P3-2 立规矩**：AGENTS.md「SQL/输入」节登记「meta.changes 双引擎口径：触发器 OF 清单内列的写语句禁用 === 精确值，用 <1/>0 口径」。

### R6 批次（shell，生产侧落地需站长授权）

**P1-10 快照新鲜度**：backup.sh 增「snapshot_at 距今 ≤2h 否则 die」；snapshot.sh 失败写 `meta/stale` 并让 .complete 校验感知；补 `command -v sqlite3` 预检。
**P1-11 restore 守卫**：restore_data 前 `docker ps --filter name=` 检测运行容器即 die（提示 --stop-containers）；restore.sh 头注写明「原机回滚必须先停容器」。
**P1-12 租户清单化**：state.env 生成 `tenants="a b c"`（由 deploy-oracle 的 INSTANCES 或 tenants.json 派生）；snapshot/backup/restore/image-variants 四处循环读清单；DEPLOY-ORACLE.md「新增站点」补备份接线一节。
**P2-23 告警**：xwblog-backup.service 加 `OnFailure=`（TG webhook 或哨兵文件）；backup.sh 结束时输出汇总行（成功/跳过/失败计数）。
**P2-24 建议案（不实施，报站长）**：Pi 第二跳对象存储；x-ui/hysteria 凭据 age 加密隔离。

### R10 批次（需站长拍板口径后执行）

**P2-25 宪法对齐**：AGENTS.md「线上站点/部署链路」两节 + AI-COLLAB.md §1 文档地图改写为实际形态（主站=甲骨文双实例+部署 timer+树莓派备份；CF 角色=DNS/CDN/演示站保留路径；Workers Builds=一键部署副本专用）；补登 deploy/、DEPLOY-ORACLE.md、BACKUP-RASPBERRY.md；登记本次审计三份报告与 R 系列防线。
**P2-26**：重跑 `npm run build:docs`；RELEASING.md 发版清单补「build:docs 必跑」。
**P2-27**：GUIDE §19/README/DEMO 的部署句式按实际更新。
**P3-30**：择机清理（IP env 化、注释计数修正、migration README 标注存档等）。

---

## 2. 需站长拍板事项（阻塞项汇总）

1. **生产进程形态**（§1.2）：Docker 容器替换 or 裸 systemd Node？→ 决定 P1-6 的处置（补裸 Node 落地物 or 文档确认 Docker）与 P2-8 的 HOST 默认值细节。
2. **域名接入形态**（P1-5）：CF 橙云 or 直连？→ 决定 TRUST_PROXY 正确档位与 DEPLOY-MICRO.md 改法；顺带确认是否做「源站防火墙收敛到 CF IP 段」。
3. **P2-20 插件信任边界**：是否接受「安装确认弹窗+哈希 pin」方案（推荐），或收紧来源白名单（影响第三方插件生态）。
4. **P2-24 树莓派备份加固**：是否上第二跳对象存储 / 凭据加密（涉及 Pi 上安装新组件，需授权）。
5. **R6 批次的生产侧落地**：shell 修改进仓库后，生产机脚本更新需一次授权的运维动作（脚本本身在 /opt 仓库内随 git 走，但 systemd 单元 reload 与手动验证需登机）。
6. **P3-25 /archives 2000 上限**与 **P2-13 分片**：当前规模不影响，是否提前做按年分片由站长按增长预期定。

## 3. 阶段 D 回归计划（每批次合并后 + 最终）

1. `npm run typecheck` + `npm test`（全量 1006+）——每批次必跑
2. `npm run smoke`（wrangler dev 逐路由）——R2/R3/R4/R8/R9 触及渲染与 SQL 后必跑
3. docker-poc/smoke.sh——R2/R5（适配层）必跑
4. 新增回归用例清单（各修复卡的测试方式列）合并入 tests/
5. EXPLAIN QUERY PLAN 复验——R9 的 INDEXED BY/ORDER BY 改动（feed-index 守卫 + 手工 EQP）
6. 备份/还原——R6 落地后在隔离环境走一遍「备份 → 清空 → 还原」全链（对齐 B26 演练口径）
7. 安全复核——R1/R5 落地后重跑安全线的 38 形态 fetchsafe 实验与鉴权矩阵抽查
8. 七（八）主题渲染——tests/themes.test.ts 全量 + 390px 抽查截图（建议站长参与目检 news 主题）

## 4. 回滚方案

- 代码层：每批次独立提交 → 单条 `git revert` 可回滚；分支 `audit/2026-full-project-review` 合并 main 前整支可弃。
- schema 层：R 批次**不改任何表结构**（本轮全部修复无需 DDL——审计确认所有问题都在应用层/脚本层）；若未来 R 系列外新增 DDL，按 AGENTS 两处同步 + 老库 ALTER 演练先行。
- 数据层：修复不触碰生产数据；媒体清理类（P2-18）只报告不自动删。
- 生产层：R6 的 shell 改动有 `last-failed`/fail-safe 语义兜底；任何一步异常按「备份可还原（P1-11 修复后的守卫版）+ 镜像按 commit tag 回退」执行。
- 推送即部署：**所有批次未经站长明确「推送」指令不 push origin**；本地逐批次验证。

## 5. 生产环境注意事项（修复上线时）

- R1/R2 涉及重启行为变化：部署窗口选低峰；部署后观察 `[http]` 日志与限流行为。
- P2-8 绑定值变化：确认 docker-compose/environment 与 deploy-oracle.sh 的端口映射组合后再合入（避免容器内绑回环导致端口映射失效——这是本批次唯一的「改错=全站不可达」点，测试卡里有专项）。
- P1-5 若确认橙云形态：改 TRUST_PROXY=cf 的同时必须同步做防火墙收敛，否则等于把「伪造 CF-Connecting-IP 绕限流」的口子从「理论」变「现网」——两步必须一次完成。

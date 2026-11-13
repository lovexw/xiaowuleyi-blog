# 精简方案与审计报告（2026-11-13 深夜批次，站长「回归个人博客」指令落地）

> **一句话**：基于 `origin/main d03f452`（2026-11-12），按「少就是多 / 第一性原理 / 个人使用」对代码库做了一次**真删**——
> 净 **-22,429 行（137 个文件）**，主题 8→2，四套验证（typecheck / npm test 756 / smoke 225 / docker-poc smoke 59）全绿。
> 本文档 = 精简方案 + 删除清单 + 代码审计结论 + 风险与残留项，是本次大改的**唯一交底文档**。

---

## 一、依据（为什么删这些）

三份既有拍板文档已经把「该不该删」论证完了，这次只是把结论从「冻结」推进到「删除」：

1. **docs/MAINTENANCE.md（2026-11-05）**：项目转为站长自用，唯一生产形态是甲骨文自托管。
   判断标准原话：「只让这两个站更好的改动做，只让『别人部署这个项目』更顺的改动不做」。
2. **docs/FROZEN-FEATURES.md（2026-11-10）**：会员 / 排行榜 / 评论圈层 / 跨站继承 / 广场同步依据
   **线上真实用量**冻结（全站 4 个会员、1 个测试号、点赞 0、签到 0；后台 95 个端点 7 天只被调用 7 个）。
3. **docs/ROADMAP.md（2026-11-10 减法）**：原话「铁粉签到上线后 0 次使用，在一个没人用的底座上盖徽标和**抽奖**，是把维护面往外扩」。
4. **2026-11-12 口令改造**：文章可见性改两档站级口令（固定密码 / 会员密码，`posts.min_tier` = all/fixed/member），
   与会员账号体系**彻底解耦**——会员系统失去最后一个存在理由。
5. **站长 2026-11-13 指令**：「精简，践行少就是多，个人使用，第一性原理」「皮肤只保留 2-3 个」。

> FROZEN-FEATURES.md 曾论证「先不删」（git 历史可捞回）。站长的精简指令构成对该结论的显式推翻；
> 删除前的完整状态在 `git tag xw-20261105-before-freeze` 与本批次各提交里，单条 revert 可复活任一块。

---

## 二、删了什么（五批提交，逐项可 revert）

| 提交 | 内容 | 体量 |
| --- | --- | --- |
| `8e3013b` | **主题 8→2**：删 journal / paper / midnight / bitcoin / rednote / news 六套（ts+css+预览脚本），appearance 映射表、市场目录、后台「外观」页皮肤市场 tab 同步收口；保留 wechat（**两站线上实测均在用**）+ minimal（极简备胎） | -7,542 |
| `b7477cc` | **会员体系全家桶**：points / tiers / invite / commentgate / fanrank / partner / turnstile 七模块 + 八张表 + 全部端点 / 页面 / 徽标 / 圈层 / 签到 / 邀请码 / 跨站继承 / 多作者 + 前后台 UI + 12 个测试文件 | -10,003 |
| `982c89f` | **MCP + 更新中心 + 广场**：src/mcp.ts、src/update.ts、plaza/ hub、plaza-sync 插件、控制面收录链路、docs/PLAZA.md / PARTNER.md / UPDATING.md、docker-poc/.test-rc 仓库内测试产物 | -4,862 |
| `f901827` | 基线小修：d1-batch 测试 Windows 临时路径（os.tmpdir）、.gitignore | -1 +5 |
| `a66adb2` | 审计收尾：PUT 白名单残留分支（updateIgnoredVersion / rankTopN）、wechat 页脚排行链接、死文档注释、audit.ts members.avatar 引用源 | -17 |

**删掉的表**（schema.sql 与 SCHEMA_* 三处同步；老库存量数据留在库文件里不迁移，随文件级备份留存）：
members / member_sessions / member_points_log / member_visits / member_likes / invite_codes / invite_uses / partner_grants

**删掉的端点**：`/api/member/*` 全家、`/partner/grant`、`/admin/members`、`/admin/member-tiers`、`/admin/partner-grants`、
`/admin/invites`、`/admin/authors`、`/admin/plaza-stats`、`/admin/update`、`/mcp`、`/rank`

**删掉的设置键**：membersEnabled / memberTiers / memberRegOpen / rankEnabled / showMemberBadge /
commentGateTier / memberNotice / premiumPointsCost / premiumPaidNote / partnerSelfId / partnerPushUrl /
partnerPushSecret / turnstileSiteKey / turnstileSecret / rankTopN / contentVisibleForMembers /
updateIgnoredVersion / plazaEndpoint / plazaToken

**删掉的页面**：/member、/rank、后台会员页 / 邀请码页 / 跨站继承页 / 作者管理、外观页皮肤市场 tab

**保留但随之简化的**：
- 评论回到游客口径（+ 作者回复）：不 JOIN members、无徽标无圈层；楼中楼回复收回「只有作者能回复」的老口径；
  **游客选填 QQ 头像（C2）保留**——它是评论功能不是会员功能，qlogo 抓取转存链路原样。
- 楼中楼「回复」按钮只有登录管理员可见（与游客同口径的刷量防线不变）。
- 可见窗口（contentVisibleRangePosts/Weibo）保留，会员豁免开关随会员删除（窗口恒对所有人生效，管理员预览豁免不变）。

---

## 三、明确不删的（第一性原理推演后留下的）

| 项 | 理由 |
| --- | --- |
| `website/`（官网 bloghao.com 源码） | **线上仍活着**（2026-11-13 实测 200），且服务器从仓库目录 `/opt/xwblog-app` 直出——push 删目录 = 2 分钟内打断线上。站长哪天不要官网了，先停 openresty 站点再删 |
| `docker-poc/` 全部 | **就是生产运行时**（tenants.json 机制跑着两个站）。控制面收录广场的代码已删，多租户骨架原样 |
| `wrangler.jsonc` + CF 兼容分支 | `npm run dev` / `npm run smoke` 依赖 wrangler dev 本地跑；src 里的 caches.default 分支已有 memory-cache 替代，清理属负收益（MAINTENANCE.md §6.3 的结论仍成立） |
| `src/douban.ts` + douban-relay/ + 编辑器插件 | 书影音卡片是「个人便利」非「给别人用」，只是默认停用（pluginsDisabled 预置），随时可开 |
| 外部发布全家（externalToken / TG bot / Buffer / collect 采集） | 个人发帖工具，两站在用口径 |
| Turnstile 替代物 | 无——注册没了就不需要人机验证；`/api/auth/login` 按既有口径不校验（管理员登录有 TOTP + 登录失败告警 + 限流三道） |
| 插件市场（catalog.json 只剩 plugins） | 编辑器插件仍可安装；皮肤市场随双主题失去意义，已删 |

---

## 四、代码审计结论（精简后专项）

**越权面** ✓
- `/admin/*` 鉴权中间件位置审计：**全部 62 个 admin 路由注册均在中间件之后**（脚本核对 0 异常）。
  审计过程中发现会员区段切割曾把该中间件误删，已在 `b7477cc` 内恢复并有「未登录 401」冒烟断言守着。
- 公开端点 12 个逐一过目：无会话级数据外泄面；微博评论 JSON 出参已无 member_* / viewerRank 字段。
- commentgate（圈层）删除后，历史被遮罩评论的正文**恢复公开**——这正是「关圈层必须清 commentGateTier」
  规律的自然延伸：settings 键已不存在，无配置残留路径。

**schema 一致性** ✓
- schema.sql 与 db.ts SCHEMA_COLUMNS / SCHEMA_TABLES / SCHEMA_INDEXES 三处同步由 tests/schema-upgrade.test.ts
  守卫（5 关键表 + FTS 虚表、幂等重放、索引归位三条全过）。
- comments.member_id / users.role 列从 schema 移除：老库留存量列无害（代码不再引用，`grep member_id src/` 为 0），
  新库不再建——WXR 导入的 INSERT 列清单已同步收口（11→10 值的错位在 import-wxr 端到端测试里被抓住修复）。

**防线失效检查** ✓
- 防泄漏清单走查：RSS / JSON Feed / llms / .md 镜像 / 搜索 / /random 的 `min_tier ≠ all` 收口原样保留
  （口令墙语义与会员无关，判定函数 canRead 未动）。
- settings 键一致性脚本核对：DEFAULT_SETTINGS 51 键 ↔ PUT 白名单分支 ↔ 后台表单 0 漂移
  （抓出并修掉 updateIgnoredVersion / rankTopN 两个残留分支）。
- 备份 / 整站包表清单同步收口：BACKUP_TABLES 与 BUNDLE_TABLES 均已无会员表；BUNDLE_SETTINGS_SKIP 无死键。

**死代码** ✓
- `grep -rn "membersEnabled|memberTiers|invite|partner|plaza|turnstile|awardPoints|spendPoints" src/` = 0 活引用；
- 主题 CSS `.mem-* / .rk-* / .paywall / .cmt-gate` 0 残留（wechat/minimal 各 -180 行）；
- site.js / app.js 无会员 UI 残留（`node --check` 语法 + 镜像守卫测试全过）。

**审计中修复的回归**（都在测试/冒烟里被抓住，无一带上线）：
1. /admin 鉴权中间件被会员区段切割误删 → 恢复 + 「未登录 401」断言守卫；
2. WXR 导入评论 INSERT 列/值错位（member_id 删除后）→ import-wxr 端到端测试抓住修复；
3. api.ts 设置段切割误删 parseId / readPostPayload 助手 → 恢复；
4. docker-poc 控制面 sessionOk / issueSession / sessions / FLASH_COOKIE / takeFlash / flashRedirect /
   opsLog 七件随广场块误删 → 逐件恢复 + docker smoke 59 项全绿验证。

---

## 五、验证基线（全绿）

```
npm run typecheck        ✓ 0 error
npm test                 ✓ 756/756（会员相关 12 个测试文件随功能删除，其余逐个改造适配）
npm run smoke            ✓ 225/225（会员链路 / MCP 链路段随功能删除）
docker-poc/smoke.sh      ✓ 59/59（控制面广场收录链路段随功能删除）
```

---

## 六、风险与残留项（站长醒来先读这段）

1. **push 即部署**：服务器 systemd 定时器 2 分钟拉 main 重建。本批次 5 个提交**只提交在本地、未 push**；
   站长确认后 `git push origin main` 才上线。上线后两站行为差异 = 会员入口消失 / 页面更瘦，其余零变化
   （两站本就 membersEnabled='0'，唯一可见变化是主题 CSS 变小与页脚排行链接消失）。
2. **会员存量数据**：库里 4 个会员、15k 条带 member_id 的历史评论**原样留在库文件里**（删除的是代码不是数据）。
   回滚任一提交即可重新读写。备份清单不再含会员表 → **恢复旧备份到新版代码时，会员表会被忽略**（预期行为）。
3. **lottery 抽奖原型**：2026-11-08 的未提交原型已完整存档到分支 `wip/lottery-prototype-20261113`
   （含提案文档与 2026-11-08 审计报告）。它依赖会员体系，复活需先回滚会员删除。
4. **blog.xiaowuleyi.com 的 emlog 并行**：实测该域名首页走 emlog（旧站）、`/rss.xml` `/feed.json` `/admin/`
   走 xwblog 容器——两套系统同域并存，与本次精简无关，站长知悉即可。
5. **website/ 与官网**：未删（见「三」）。哪天决定关停 bloghao.com：先停 openresty 站点 → 再删目录 →
   连带删 website-docs / website-sitemap 测试与 build:docs / deploy:site 脚本。
6. **文档**：GUIDE.md 的会员章节还带着历史描述（本次未逐节重写，加横幅指路本文档）；
   API.md / THEMES.md / FROZEN-FEATURES.md / MAINTENANCE.md / ROADMAP.md / AGENTS.md / AI-COLLAB.md 已同步。

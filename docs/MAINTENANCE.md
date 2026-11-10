# 维护状态与冻结范围

> 一句话：这个仓库是**站长自用**的博客系统，只保证 blog.xiaowuleyi.com / blog.btchao.com
> 两站在甲骨文服务器上稳定运行。仓库保持公开，代码随时可取用，但**不再对外承诺维护**。

2026-11-05 拍板。此前这个项目同时维护三条部署线（Cloudflare Workers、Docker 多租户托管、
演示站），加上官网与广场两套附属件——一个功能要在多条运行时上都成立，成本翻倍，而真正产生
收益的只有一条。所以收敛：**一条主线继续迭代，其余全部冻结。**

冻结不是删除。代码留在原处，随时能翻回来（见 §5），只是不再投入维护。

---

## 1. 现行主线（唯一还需要维护的部分）

| 项 | 内容 |
| --- | --- |
| 部署形态 | 甲骨文 ARM 服务器 Docker 自托管，**见 [DEPLOY-ORACLE.md](DEPLOY-ORACLE.md)**（唯一部署真相源） |
| 代码来源 | GitHub `main`，服务器 systemd 定时器每 2 分钟 `git fetch` + `git reset --hard` |
| 站点 | `blog.xiaowuleyi.com`（容器 `xwblog-next`）、`blog.btchao.com`（容器 `btchao-blog`） |
| 数据 | 每站独立 SQLite（WAL），数据目录与代码目录分离，自动部署碰不到 |
| 维护承诺 | 生产站点可用性、安全修复、数据安全、自用功能迭代 |

**判断标准**：一个改动如果只让这两个站更好，做；只让「别人部署这个项目」更顺，不做。

---

## 2. 冻结清单（代码保留，不再维护更新）

> 这一节冻结的是**部署形态**（跑在哪个运行时、给谁用）。站内**功能**的冻结另有清单：
> 会员 / 排行榜 / 评论圈层 / 广场同步 / 豆瓣 / 英文版等见 [FROZEN-FEATURES.md](FROZEN-FEATURES.md)。

| 形态 | 位置 | 状态 | 说明 |
| --- | --- | --- | --- |
| Cloudflare Workers / D1 / R2 部署 | `wrangler.jsonc`、`src/` 内的兼容分支 | 冻结 | 不再部署、不跟进 CF 平台的 API 变化；`wrangler.jsonc` 留作参照实现 |
| Docker **多租户托管**（给他人开站） | `docker-poc/tenants.json`、`add-tenant.sh`、`control.ts` | 冻结 | **机制保留可用**（现在两个站就跑在它上面），但不再优化「一键给别人开站」的体验、不写托管服务文档 |
| 演示站 | `demo/`、`wrangler.demo.jsonc`、`src/demo.ts` | 冻结 | 不再更新；`src/demo.ts` 的 `DEMO_MODE` 门控**保留**（防误操作安全网，不是演示站专属） |
| 广场（Plaza） | `plaza/`、`src/hooks.ts` 的广场同步插件 | 冻结 | 服务端协议不再演进；站上的广场同步插件继续可用，出事不修 |
| 官网 | `website/` | 冻结 | 源码留档，不再更新内容与构建脚本 |

### 「冻结」到底意味着什么

- **不修 bug、不跟新特性、不主动部署**。这些形态报出的问题，记录但不排期。
- **代码保留，作为参照实现**。哪天怀疑「这段逻辑在 D1 上成不成立」「多租户路由会不会串站」，
  还能翻出来对照——这是保留而不是删除的主要理由。
- **不做兼容性取舍**。为了 Workers 运行时能跑而绕开的 Node 特性，以后可以直接用（见 §4）。

### 为什么不直接删掉

两个实际原因，不是舍不得：

1. **`/opt/xwblog-app` 就是仓库目录**。服务器靠 `git reset --hard` 同步，删掉 `website/` 这类目录，
   pull 之后目录就真的消失了。官网与演示站目前仍在线（2026-11-05 实测均 200），删源码等于
   给线上留一颗定时炸弹。
2. **引用面太广**。`docs/GUIDE.md`、`docs/CLOUDFLARE-BASICS.md`、`docs/UPDATING.md` 里共 6 处
   相对链接指向 `docs/DEPLOY.md`，`package.json` 里有 `deploy:site` / `build:docs` 指向 `website/`。
   删文件要连带改一圈，收益只有几 MB 仓库体积——不划算。

---

## 3. 仍然算「生产代码」的范围

改这些要按 AGENTS.md 的红线走、要跑测试：

```
src/            后端 + SSR + 主题（全部）
public/         前台 site.js + 后台 SPA + 插件
docker-poc/     现行部署的适配层（Node 运行时、SQLite shim、静态服务）
schema.sql      D1 表结构（老库兼容纪律见 AGENTS.md）
tests/          回归测试（唯一的刹车）
scripts/        部署与运维脚本（deploy-oracle.sh 等）
docs/DEPLOY-ORACLE.md   唯一部署真相源
```

---

## 4. 自用之后可以做的事（以前为兼容而放弃的）

这不是待办清单，是**许可**：碰到时可以直着走，不必再为另一条线留余地。

- `pagecache` 的 `caches.default` 分支在 Node 下恒 miss —— **已兑现（2026-11-05）**：新增
  `src/memory-cache.ts` 提供进程内实现，自托管形态的页面 / 图床缓存从「整层短路」变成真生效。
  这条是自用红利的第一笔，也是「只维护一条线」最直接的回报
- 定时任务可以用 systemd timer / crontab 直管，不必再走 Cron Triggers 的口径
- 备份可以只考虑本地磁盘 + 树莓派，不必再为 R2 留路径
- 可以放心依赖 `node:sqlite` 的特性（语句缓存、WAL 调优已在用）

**反向纪律不变**：schema 演进仍要守「老库运行时 ALTER 补的列，索引只能进 `SCHEMA_INDEXES`」；
测试仍不许砍——以前有开源用户帮忙踩坑，以后只有自己。

---

## 5. 想恢复某条线怎么办

冻结前的完整状态打了 tag：

```bash
git tag --list | grep freeze      # xw-20261105-before-freeze
git show xw-20261105-before-freeze --stat
```

冻结期间的代码从未删除，只是在文档层面停止承诺。真要复活某条线（比如重新对外发布），
从 tag 对照当前状态，把差异补回来即可。

---

## 6. 对协作者（含 AI）的约束

1. **默认只改主线**。接到「优化一下」这类模糊指令时，默认指 §1 的现行主线，不要顺手去动 §2 的冻结目录。
2. **发现冻结目录里的 bug，记录不修**。在提交信息或文档里留一句即可，除非站长明确说「这个要修」。
3. **不要为兼容 Workers 而增加复杂度**。Node 下能直写的就直写；反之，也不要去「清理」那些只为 Workers 存在的分支——
   它们现在无害，清理要连带改测试，属于负收益。
4. **部署相关的文档只认 `docs/DEPLOY-ORACLE.md`**。`docs/DEPLOY.md`、`docs/DEMO.md`、`docs/PLAZA.md`
   已挂冻结横幅，读到它们时要意识到那是历史形态。

---

*本文档与 AGENTS.md「线上站点」、`docs/AI-COLLAB.md` 文档地图三处互为索引，改一处要同步另两处。*

-- 博客号 BlogHao 数据库结构（D1 / SQLite）
-- 幂等：可以重复执行，用于首次初始化与升级
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  display_name  TEXT    NOT NULL DEFAULT '',
  avatar        TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  -- token 存 SHA-256（auth.ts tokenHash）：库里没有可重放的明文会话 token
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
-- 登录时「清本账号过期会话 + 计活跃会话数」都按 user_id 过滤，没这条索引就扫整张会话表
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id, expires_at);

CREATE TABLE IF NOT EXISTS posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL UNIQUE,
  old_slugs    TEXT    NOT NULL DEFAULT '[]', -- 历史 slug（B22，JSON 数组）：改 slug 后旧地址 301 到新地址，最多保留 20 个
  title        TEXT    NOT NULL,
  content      TEXT    NOT NULL DEFAULT '',
  summary      TEXT    NOT NULL DEFAULT '',
  cover        TEXT    NOT NULL DEFAULT '',
  tags         TEXT    NOT NULL DEFAULT '[]', -- JSON 数组，如 ["生活","Cloudflare"]
  status       TEXT    NOT NULL DEFAULT 'draft', -- draft | published | scheduled（定时发布）
  pinned       INTEGER NOT NULL DEFAULT 0,
  views        INTEGER NOT NULL DEFAULT 0,
  likes        INTEGER NOT NULL DEFAULT 0,
  min_tier     TEXT    NOT NULL DEFAULT 'all', -- 可见档位：all 公开 | fixed 固定密码 | member 会员密码（两档口令见 src/protect.ts）；会员体系时代的 coffee/top 等值由冷启动迁移收成 member
  author_id    INTEGER,
  published_at INTEGER,
  publish_at   INTEGER,                -- 定时发布时间：到点由 Cron 翻成 published（src/scheduler.ts）
  password_hash TEXT   NOT NULL DEFAULT '', -- 已退役（2026-11）：单篇访问密码被两档站级口令取代，此列不再读写；冷启动迁移会把存量值转成 min_tier='member' 并清空。保留列是为了不做 SQLite 删列 + 老库 ALTER
  ai_generated INTEGER NOT NULL DEFAULT 0, -- AI 生成标注（编辑器「更多」自愿申报，勾选后文章页 meta 行显示标识；PUT 缺键即保留同 password 口径）
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER                 -- 回收站：非 NULL = 已移入回收站（30 天后 cron 彻底清除，src/trash.ts）
);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts (status, pinned DESC, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_updated ON posts (updated_at DESC);
-- 列表时间线排序索引（D1 读放大优化 P0-1）：listPosts/listWeibo 的 ORDER BY 用 COALESCE(published_at, created_at)，
-- 与上面裸 published_at 列结构不匹配，翻页会全表扫描 + 临时排序（D1 按行读取计费）。
-- 表达式必须与 src/db.ts 的排序片段一字不差（含 DESC 与部分索引 WHERE），改排序三处同步（tests/feed-index.test.ts 守卫）
CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL;
-- 相邻文章专用（无 pinned 前缀的纯时间序，posts.ts adjacentPosts 的 ORDER BY 结构匹配），
-- 表达式与 src/db.ts SCHEMA_INDEXES 双份登记一致
CREATE INDEX IF NOT EXISTS idx_posts_chrono ON posts (status, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,            -- 文章评论；微博评论固定为 0
  weibo_id   INTEGER NOT NULL DEFAULT 0,  -- 微博评论；文章评论固定为 0
  parent_id  INTEGER NOT NULL DEFAULT 0,  -- 楼中楼：父评论 id，0 = 顶层（作者回复用）
  is_admin   INTEGER NOT NULL DEFAULT 0,  -- 1 = 作者（管理员）发言，前台加徽标
  nickname   TEXT    NOT NULL,
  email      TEXT    NOT NULL DEFAULT '',
  website    TEXT    NOT NULL DEFAULT '',
  qq         TEXT    NOT NULL DEFAULT '',          -- 游客选填的 QQ 号（评论头像 C2）：仅头像抓取记账位，任何公开出参不携带
  avatar     TEXT    NOT NULL DEFAULT '',          -- 游客头像（服务端 qlogo 抓取后站内转存的 /images/ 地址），空 = 首字块
  content    TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'approved', -- approved | pending
  ip         TEXT    NOT NULL DEFAULT '',
  ip_region  TEXT    NOT NULL DEFAULT '', -- 评论 IP 属地快照（src/ipregion.ts）：写库定格 cf（CN:Guangdong / US / HK），空 = 无数据（旧评论/自托管）不展示
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at);
-- idx_comments_qq 只进 src/db.ts SCHEMA_INDEXES：qq 是老库运行时 ALTER 补的列（同 idx_comments_parent 归位规矩），
-- 本文件对老库执行时该列可能尚不存在，在这里建索引会直接报错
-- idx_comments_weibo 由 src/db.ts ensureSchema() 在运行时创建：
-- 老库执行本文件时 weibo_id 列尚不存在（ALTER 由运行时补齐），在这里建索引会报错
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments (status, created_at DESC);
-- idx_comments_parent（楼中楼级联删除 DELETE WHERE id = ? OR parent_id = ? 的 MULTI-INDEX OR 依赖，
-- 没有它 OR 全表扫）只进 db.ts SCHEMA_INDEXES：parent_id 在老库是运行时 ALTER 补的列，
-- schema.sql 在部署时对老库执行时该列尚不存在，在这里建索引会报错（同 weibo_id 的归位规矩）

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  slug        TEXT    NOT NULL UNIQUE,
  sort        INTEGER NOT NULL DEFAULT 0,
  description TEXT    NOT NULL DEFAULT '', -- 分类描述（B23）：归档页页头一行说明 + meta description
  created_at  INTEGER NOT NULL
);

-- 单分类：一篇文章最多属于一个分类（post_id 为主键）
CREATE TABLE IF NOT EXISTS post_categories (
  post_id     INTEGER NOT NULL PRIMARY KEY,
  category_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_categories_cat ON post_categories (category_id);

-- 微博：随手记，短文字 + 最多 9 张图，无标题无 slug
CREATE TABLE IF NOT EXISTS weibo (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content      TEXT    NOT NULL DEFAULT '',
  images       TEXT    NOT NULL DEFAULT '[]', -- JSON 数组，如 ["/images/u/202510/xxx.jpg"]
  video        TEXT    NOT NULL DEFAULT '',   -- 单条视频（B19）：JSON 串 {"url":"/images/u/…mp4","poster":"…jpg","w":1280,"h":720}，空串 = 无视频
  topics       TEXT    NOT NULL DEFAULT '[]', -- JSON 数组，从正文 #话题# 自动提取
  status       TEXT    NOT NULL DEFAULT 'published', -- draft | published
  pinned       INTEGER NOT NULL DEFAULT 0,          -- 置顶（最多 3 条，应用层限制）
  likes        INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER                 -- 回收站：非 NULL = 已移入回收站（30 天后 cron 彻底清除，src/trash.ts）
);
CREATE INDEX IF NOT EXISTS idx_weibo_status ON weibo (status, published_at DESC);
-- 时间线排序索引同 posts（P0-1）：pinnedFirst 形态（/weibo 页）与 recency 形态（公开 API / 首页入口卡）各一条
CREATE INDEX IF NOT EXISTS idx_weibo_feed ON weibo (status, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_weibo_feed_pinned ON weibo (status, pinned DESC, COALESCE(published_at, created_at) DESC, id DESC) WHERE deleted_at IS NULL;

-- FTS5 全文索引（src/fts.ts，ROADMAP B4）：trigram 分词适配中文（无空格文本按 3 字滑窗成词），
-- external content 挂原表省一份正文存储。增量同步触发器在 db.ts 的 SCHEMA_TRIGGERS 挂——
-- schema.sql 的执行路径可能按分号朴素切分 SQL（如测试建库 / 适配层 exec），切不开触发器的
-- BEGIN...END 体，而 ensureSchema 是所有部署形态冷启动必经的迁移路径；存量库首次升级的
-- 全量索引重建由 ensureSchema 的 ftsSeeded 记账位驱动。虚表是可重建的派生索引，不进备份。
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(title, summary, content, tokenize='trigram', content='posts', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS weibo_fts USING fts5(content, tokenize='trigram', content='weibo', content_rowid='id');

-- 标签登记表：分类页可预建标签；文章用到的标签读取时自动并入展示
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL DEFAULT '',
  mime       TEXT    NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  hash       TEXT    NOT NULL DEFAULT ''    -- 内容 SHA-256 指纹（媒体体检查重用，src/audit.ts）；missing = R2 里已丢失
);
-- 媒体库按 created_at 倒序分页；db.ts SCHEMA_INDEXES 有同款，两处同步
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads (created_at DESC);

-- 友情链接：站长维护，访客也可申请收录（source=user，默认 pending 待审）
CREATE TABLE IF NOT EXISTS friend_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  icon        TEXT    NOT NULL DEFAULT '',          -- 图标地址（站内 /images/ 或 http(s) 外链），空则前台用站名首字图标
  status      TEXT    NOT NULL DEFAULT 'pending',   -- approved | pending
  sort        INTEGER NOT NULL DEFAULT 0,           -- 数字小的靠前
  source      TEXT    NOT NULL DEFAULT 'admin',     -- admin | user
  ip          TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_friend_links_status ON friend_links (status, sort, id);

-- 独立页面：自建页面（项目页 / 书单页 / 工具页 / 隐私政策等），渲染在 /page/:slug。
-- 「关于我」也由本表承载（slug = 'about'，专属短链 /about，由 ensureSchema 从 settings.about 播种迁移）
CREATE TABLE IF NOT EXISTS pages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  slug        TEXT    NOT NULL UNIQUE,
  content     TEXT    NOT NULL DEFAULT '',            -- 净化后的 HTML（与 posts.content 同口径）
  status      TEXT    NOT NULL DEFAULT 'draft',       -- draft | published
  show_in_nav INTEGER NOT NULL DEFAULT 0,             -- 1 = 出现在前台顶部导航
  sort        INTEGER NOT NULL DEFAULT 0,             -- 数字小的靠前（导航顺序）
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER                                 -- 回收站：非 NULL = 已移入回收站（30 天后 cron 彻底清除，src/trash.ts）
);

-- Telegram 相册缓冲：一次多选会拆成多条消息（同一 media_group_id），
-- 先逐条写入这里（图片已转存 R2），几秒没有新图后合并发布成一条微博并清空
CREATE TABLE IF NOT EXISTS tg_buffer (
  media_group_id TEXT PRIMARY KEY,
  content        TEXT NOT NULL DEFAULT '',
  images         TEXT NOT NULL DEFAULT '[]', -- JSON 数组，如 ["/images/u/202510/xxx.jpg"]
  status         TEXT NOT NULL DEFAULT 'published',
  chat_id        TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- 访客统计日志（后台「统计」页）：site.js 打点 → POST /api/public/track 落这里。
-- 只存匿名 vid 与来源域名，不存 IP / 原始 UA；day 是北京时间日期（写入时算好，聚合直接 GROUP BY）。
-- 日志类数据：不进备份（与 sessions / tg_buffer 同理），保留 180 天由每晚备份 cron 顺带清理。
CREATE TABLE IF NOT EXISTS visit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,               -- 毫秒时间戳
  day     TEXT    NOT NULL,               -- 北京时间 YYYY-MM-DD
  vid     TEXT    NOT NULL DEFAULT '',    -- 匿名访客 id（localStorage）
  path    TEXT    NOT NULL DEFAULT '',    -- 页面路径（含 query，截 300）
  title   TEXT    NOT NULL DEFAULT '',    -- document.title 截 200
  ref     TEXT    NOT NULL DEFAULT '',    -- 来源域名（站内/直接为空）
  dev     TEXT    NOT NULL DEFAULT '',    -- desktop | mobile | tablet
  br      TEXT    NOT NULL DEFAULT '',    -- wechat | chrome | edge | firefox | safari | other
  country TEXT    NOT NULL DEFAULT ''     -- CF-IPCountry 两字母码
);
CREATE INDEX IF NOT EXISTS idx_visit_day ON visit_log (day, ts);
-- 滚动清理 DELETE WHERE ts < ? 走前导索引（visit_log 是量最大的日志表，全表扫不值）
CREATE INDEX IF NOT EXISTS idx_visit_ts ON visit_log (ts);

-- 爬虫 / AI 抓取日志（后台「统计」页，src/bots.ts）：服务端按 User-Agent 识别后旁路落库
-- （爬虫不执行 JS，进不了 visit_log）。只存识别名/类别 + 路径 + 国家码，不存 IP / UA 原文。
-- 识别规则与写入闸见 src/bots.ts；日志类数据不进备份，保留 180 天由每晚备份 cron 顺带清理。
CREATE TABLE IF NOT EXISTS bot_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,               -- 毫秒时间戳
  day     TEXT    NOT NULL,               -- 北京时间 YYYY-MM-DD
  name    TEXT    NOT NULL DEFAULT '',    -- 识别名（GPTBot / Google / 必应…）
  kind    TEXT    NOT NULL DEFAULT '',    -- ai | se | feed | seo | arch
  path    TEXT    NOT NULL DEFAULT '',    -- 请求路径（截 300）
  country TEXT    NOT NULL DEFAULT ''     -- CF-IPCountry 两字母码
);
CREATE INDEX IF NOT EXISTS idx_bot_day ON bot_log (day, ts);
CREATE INDEX IF NOT EXISTS idx_bot_ts ON bot_log (ts);

-- 回收站软删行极少：部分索引只收 deleted_at IS NOT NULL，trash 面查询与 30 天到期清理免全表扫
CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_weibo_deleted ON weibo (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pages_deleted ON pages (deleted_at) WHERE deleted_at IS NOT NULL;

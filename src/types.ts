export interface Env {
  DB: D1Database
  IMAGES: R2Bucket
  ASSETS: Fetcher
}

export interface SessionUser {
  id: number
  username: string
  display_name: string
  avatar: string
}

export type PostStatus = 'draft' | 'published' | 'scheduled'

export interface PostRow {
  id: number
  slug: string
  title: string
  content: string
  summary: string
  cover: string
  tags: string
  status: PostStatus
  pinned: number
  views: number
  likes: number
  author_id: number | null
  published_at: number | null
  /** 定时发布目标时间（毫秒）；仅 scheduled 状态有值 */
  publish_at: number | null
  /** 可见档位（两档站级口令见 src/protect.ts）：all 公开 / fixed 固定密码 / member 会员密码；
   *  会员体系时代的脏值由冷启动迁移收成 member；老库 ALTER 补列前可能缺省 */
  min_tier?: string
  /** 访问密码（src/protect.ts）：salt:hash（PBKDF2），空 = 未加密；不进任何后台响应 */
  password_hash?: string
  /** AI 生成标注（编辑器「更多」自愿申报，0/1）：1 = 文章页 meta 行显示 AI 生成标识；老库 ALTER 补列前可能缺省 */
  ai_generated?: number
  /** 历史 slug（B22）：JSON 数组，改 slug 时追加（utils.ts appendOldSlug），直链 404 前查它 301；老库 ALTER 补列前可能缺省 */
  old_slugs?: string
  created_at: number
  updated_at: number
  /** 回收站：非 NULL = 已移入回收站（毫秒），NULL = 存活（src/trash.ts） */
  deleted_at: number | null
}

export interface WeiboRow {
  id: number
  content: string
  images: string
  /** 单条视频（B19，解析/读侧过滤见 src/db.ts parseWeiboVideo / weiboVideoView）：JSON 串，空串 = 无视频 */
  video: string
  topics: string
  status: PostStatus
  pinned: number
  likes: number
  published_at: number | null
  created_at: number
  updated_at: number
  /** 回收站：非 NULL = 已移入回收站（毫秒），NULL = 存活（src/trash.ts） */
  deleted_at: number | null
}

export interface CommentRow {
  id: number
  post_id: number
  weibo_id: number
  parent_id: number
  is_admin: number
  nickname: string
  email: string
  website: string
  content: string
  status: 'approved' | 'pending'
  ip: string
  /** 评论 IP 属地快照（src/ipregion.ts）：写库定格 cf（CN:Guangdong / US / HK），空 = 无数据不展示；公开出参走 showCommentRegion 门控，标签由 ipRegionLabel 单点格式化 */
  ip_region?: string
  created_at: number
  /** 游客选填的 QQ 号（评论头像 C2）：仅头像抓取记账位，任何公开出参不携带 */
  qq?: string
  /** 游客头像（服务端 qlogo 抓取后站内转存地址）：评论头像位展示用；空 = 首字块 */
  avatar?: string
}

export interface CategoryRow {
  id: number
  name: string
  slug: string
  sort: number
  /** 分类描述（B23）：归档页页头说明 + meta description；纯文本，后台分类编辑维护 */
  description: string
  created_at: number
}

/** 独立页面（pages 表）：自建页面与「关于我」（slug = 'about'） */
export interface PageRow {
  id: number
  title: string
  slug: string
  content: string
  status: 'draft' | 'published'
  show_in_nav: number
  sort: number
  created_at: number
  updated_at: number
  /** 回收站：非 NULL = 已移入回收站（毫秒），NULL = 存活（src/trash.ts） */
  deleted_at: number | null
}

export interface FriendLinkRow {
  id: number
  name: string
  url: string
  description: string
  icon: string
  status: 'approved' | 'pending'
  sort: number
  source: 'admin' | 'user'
  ip: string
  created_at: number
  updated_at: number
}

export type SettingsMap = Record<string, string>

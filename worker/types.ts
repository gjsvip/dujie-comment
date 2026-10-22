/**
 * dujie-comment Worker 环境绑定与 Hono 上下文变量类型。
 *
 * 泛化约定（开源版硬性要求）：所有站点相关信息一律走 env
 * （wrangler.toml [vars] 或 `wrangler secret put`），源码内零硬编码——
 * 换一个部署方只需要改 wrangler.toml，不需要动一行 TypeScript。
 */

/** Cloudflare 资源绑定 + 可配置变量（wrangler.toml 声明） */
export interface Env {
  /** D1 数据库：评论 / 点赞 / 浏览量 / 说说 / 黑名单 / 通知邮箱 */
  DB: D1Database
  /** Workers KV：配置开关 / 限流计数 / 管理令牌哈希 / 备份状态标记 */
  KV: KVNamespace
  /** R2 对象存储：周备份 JSON（cron 周一 02:00 UTC） */
  R2: R2Bucket

  /* ---------------- 可选变量（缺省均有安全默认值） ---------------- */

  /** CORS 白名单（逗号分隔；localhost/127.0.0.1 任意端口恒允许，方便本地调试） */
  CORS_ORIGINS?: string
  /** 站点名称（通知邮件主题与署名；缺省 dujie-comment） */
  SITE_NAME?: string
  /** 站点主页 URL（通知邮件署名；缺省空） */
  SITE_URL?: string
  /**
   * 文章 URL 前缀（通知邮件「查看完整讨论」链接 = {POST_URL_BASE}{slug}；
   * 缺省回退 SITE_URL）。例：https://example.com/posts/
   */
  POST_URL_BASE?: string
  /** 通知邮件发件人（需在 Resend 后台验证域名；缺省 dujie-comment <onboarding@resend.dev>） */
  MAIL_FROM?: string
  /** 访客指纹盐（缺省 dujie-comment；仅新部署时设置，改动会使历史限流/点赞指纹失效） */
  VISITOR_SALT?: string
  /** Turnstile 服务端密钥（secret；缺失时校验自动放行并打 WARN，允许先上线后补 secret） */
  TURNSTILE_SECRET?: string
  /** Turnstile 站点密钥（公开值，可入 git；可被 KV cfg:turnstile_site_key 覆盖实现免部署轮换） */
  TURNSTILE_SITE_KEY?: string
  /** Resend API Key（secret；缺失时回复通知自动降级跳过，不影响评论主流程） */
  RESEND_API_KEY?: string
}

/** 中间件注入的上下文变量 */
export interface AppVariables {
  /** 请求 ID（requestId 中间件注入；业务日志可带此字段关联访问日志） */
  requestId: string
}

/** Hono 应用环境类型：Bindings + Variables */
export type AppEnv = {
  Bindings: Env
  Variables: AppVariables
}

/**
 * dujie-comment 公开 API（routes/comments.ts，挂载于 /api，全部免鉴权）。
 *
 * 能力：评论（树形回复）/ 点赞（文章+评论 toggle）/ 浏览量 / 批量统计 / 说说。
 * 数据存于 D1（binding DB），多端静态站（CF Pages / GitHub Pages / Gitee Pages
 * 或任意主机）共用同一 API，配 CORS_ORIGINS 白名单即可跨源调用。
 *
 * 安全策略（顺序即防线顺序）：
 * - ① 字段强校验（slug/nickname/email/website/content 长度与格式）；
 * - ② 博主身份：公开表单带有效 X-Admin-Token → 免 Turnstile、直接 approved；
 * - ③ 频率限制：同指纹每分钟最多 2 条（KV 计数桶）；
 * - ④ Turnstile 人机校验（博主身份或开关关闭时跳过；三分支降级见 lib/security.ts）；
 * - ⑤ 黑名单：邮箱非空查 email_md5，恒查 ip_hash（双轨盐前缀不同）；
 * - ⑥ 回复必须指向同文章已审核评论，防跨文章注入；
 * - ⑦ 审核状态：博主提交或审核队列关闭 → approved；否则 pending；
 * - ⑧ 限流计数 +1；⑨ 插入评论；⑩ 通知邮箱单独存放（隐私契约）；
 * - ⑪ 已审核的回复 → 异步通知被回复者（waitUntil，绝不阻塞响应）；
 * - ⑫ 201 返回 {id, status}。
 *
 * 隐私契约：comments 表只存 email_md5（Gravatar 头像），
 * 明文邮箱只进 comment_emails（回复通知用），不进任何公开查询。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from '../types'
import { ADMIN_TOKEN_HEADER, verifyAdminToken } from '../lib/security'
import { getConfig } from '../lib/config'
import { ipBanHash, md5, requestIp, visitorHash, visitorSalt, verifyTurnstile } from '../lib/security'
import { notifyParentOfReply } from '../lib/notify'

const commentRoutes = new Hono<AppEnv>()

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

const MAX_NICKNAME = 20
const MAX_CONTENT = 500
const MAX_WEBSITE = 200
const MAX_SLUG = 100
const COMMENT_RATE_LIMIT = 2
const COMMENT_RATE_TTL_SEC = 70
/** Turnstile token 长度上限（≤2048；超长按缺失处理） */
const MAX_TURNSTILE_TOKEN = 2048

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const URL_RE = /^https?:\/\/[^\s]+$/

interface CommentRow {
  id: number
  parent_id: number | null
  nickname: string
  email_md5: string
  website: string
  content: string
  created_at: string
}

interface CommentNode {
  id: number
  parentId: number | null
  nickname: string
  avatar: string
  website: string
  content: string
  createdAt: string
  likes: number
  replies: CommentNode[]
}

function fail(c: Context<AppEnv>, code: string, message: string, status: ContentfulStatusCode = 400) {
  return c.json({ code, message }, status)
}

/* ------------------------------------------------------------------ */
/* GET /api/config — 前端灰度开关唯一数据源（公开）                       */
/* ------------------------------------------------------------------ */

commentRoutes.get('/config', async (c) => {
  // fresh 读：绕过 60s 内存缓存，管理页/调试可见即时开关值
  const cfg = await getConfig(c.env, { fresh: true })
  c.header('Cache-Control', 'public, max-age=60')
  return c.json({
    code: 0,
    data: {
      turnstile: { enabled: cfg.turnstileEnabled, siteKey: cfg.turnstileSiteKey, failOpen: cfg.turnstileFailOpen },
      moderation: { enabled: cfg.moderationEnabled },
      notify: { enabled: cfg.notifyEnabled },
    },
  })
})

/* ------------------------------------------------------------------ */
/* GET /api/comments?slug=xxx — 评论树（已审核）                          */
/* ------------------------------------------------------------------ */

commentRoutes.get('/comments', async (c) => {
  const slug = (c.req.query('slug') ?? '').trim()
  if (slug === '' || slug.length > MAX_SLUG) {
    return fail(c, 'BAD_SLUG', '文章标识不合法')
  }
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.parent_id, c.nickname, c.email_md5, c.website, c.content, c.created_at,
            (SELECT COUNT(*) FROM likes l WHERE l.target_type='comment' AND l.target_id=CAST(c.id AS TEXT)) AS likes
     FROM comments c WHERE c.slug = ?1 AND c.status = 'approved' ORDER BY c.created_at ASC`,
  )
    .bind(slug)
    .all<CommentRow & { likes: number }>()

  const nodes = new Map<number, CommentNode>()
  const roots: CommentNode[] = []
  for (const row of results ?? []) {
    nodes.set(row.id, {
      id: row.id,
      parentId: row.parent_id,
      nickname: row.nickname,
      avatar: `https://gravatar.com/avatar/${row.email_md5}?d=identicon&s=80`,
      website: row.website,
      content: row.content,
      createdAt: row.created_at,
      likes: Number(row.likes ?? 0),
      replies: [],
    })
  }
  for (const node of nodes.values()) {
    if (node.parentId !== null && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.replies.push(node)
    } else {
      roots.push(node)
    }
  }
  return c.json({ code: 0, data: { comments: roots, total: nodes.size } })
})

/* ------------------------------------------------------------------ */
/* POST /api/comments — 发表评论 / 回复                                  */
/* ------------------------------------------------------------------ */

commentRoutes.post('/comments', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return fail(c, 'BAD_JSON', '请求体不是合法 JSON')
  }

  // ① 字段强校验
  const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
  const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const website = typeof body.website === 'string' ? body.website.trim() : ''
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  const parentId =
    typeof body.parentId === 'number' && Number.isFinite(body.parentId) ? Math.floor(body.parentId) : null
  // Turnstile token：≤2048 的字符串；缺失/类型不符/超长均按缺失处理
  const turnstileTokenRaw = typeof body.turnstileToken === 'string' ? body.turnstileToken.trim() : ''
  const turnstileToken =
    turnstileTokenRaw.length > 0 && turnstileTokenRaw.length <= MAX_TURNSTILE_TOKEN ? turnstileTokenRaw : null

  if (slug === '' || slug.length > MAX_SLUG) return fail(c, 'BAD_SLUG', '文章标识不合法')
  if (nickname === '' || nickname.length > MAX_NICKNAME) return fail(c, 'BAD_NICKNAME', `昵称需 1-${MAX_NICKNAME} 字`)
  // 邮箱选填：为空时放行（UI 承诺选填），非空才校验格式
  if (email !== '' && !EMAIL_RE.test(email)) return fail(c, 'BAD_EMAIL', '邮箱格式不正确')
  if (website !== '' && (website.length > MAX_WEBSITE || !URL_RE.test(website))) {
    return fail(c, 'BAD_WEBSITE', '网站需为 http(s) 链接')
  }
  if (content === '' || content.length > MAX_CONTENT) {
    return fail(c, 'BAD_CONTENT', `评论内容需 1-${MAX_CONTENT} 字`)
  }

  // ② 博主身份：公开表单带有效 X-Admin-Token → 免 Turnstile、直接 approved；
  //    无头/无效值按匿名忽略，不报错、不泄露
  const adminTokenValid = await verifyAdminToken(c.env, c.req.header(ADMIN_TOKEN_HEADER))

  const ip = requestIp(c.req.raw)

  // ③ 频率限制：同指纹每分钟最多 COMMENT_RATE_LIMIT 条（读计数，写在 ⑧）
  const hash = await visitorHash(ip, c.req.header('User-Agent') ?? '', visitorSalt(c.env))
  const bucket = Math.floor(Date.now() / 60000)
  const rlKey = `comment:rl:${hash}:${bucket}`
  const used = Number.parseInt((await c.env.KV.get(rlKey)) ?? '0', 10)
  if (used >= COMMENT_RATE_LIMIT) {
    return fail(c, 'RATE_LIMITED', '评论太频繁了，休息一分钟再来吧', 429)
  }

  // ④ Turnstile 人机校验（博主身份或开关关闭时跳过；三分支降级见 lib/security.ts）
  if (!adminTokenValid) {
    const outcome = await verifyTurnstile(c.env, turnstileToken, ip)
    if (!outcome.ok) {
      return fail(c, outcome.code, outcome.message, outcome.status)
    }
  }

  // ⑤ 黑名单：邮箱非空查 email_md5，恒查 ip_hash（双轨盐前缀不同）。
  //    空邮箱用户的派生 md5 随「昵称:文章」变化，拉黑无意义，刻意只传 null 跳过 email 维度
  const emailMd5 = md5(email || `${nickname}:${slug}`) // 空邮箱兜底：派生稳定头像哈希
  const ipBan = await ipBanHash(ip, visitorSalt(c.env))
  const banned = await c.env.DB.prepare(
    `SELECT ban_type FROM banned
     WHERE (ban_type = 'email_md5' AND ban_value = ?1) OR (ban_type = 'ip_hash' AND ban_value = ?2)
     LIMIT 1`,
  )
    .bind(email !== '' ? emailMd5 : null, ipBan)
    .first<{ ban_type: string }>()
  if (banned !== null) return fail(c, 'BANNED', '评论被拒绝，如有疑问请联系博主', 403)

  // ⑥ 回复必须指向同文章已审核评论（防跨文章注入）
  if (parentId !== null) {
    const parent = await c.env.DB.prepare(
      'SELECT id FROM comments WHERE id = ?1 AND slug = ?2 AND status = ?3',
    )
      .bind(parentId, slug, 'approved')
      .first<{ id: number }>()
    if (parent === null) return fail(c, 'BAD_PARENT', '回复的评论不存在或未审核')
  }

  // ⑦ 审核状态：博主提交或审核队列关闭 → approved；否则 pending
  const cfg = await getConfig(c.env)
  const status = adminTokenValid || !cfg.moderationEnabled ? 'approved' : 'pending'

  // ⑧ 限流计数 +1（读在 ③、写在此）
  await c.env.KV.put(rlKey, String(used + 1), { expirationTtl: COMMENT_RATE_TTL_SEC })

  // ⑨ 插入评论（ip_hash 供 IP 维度拉黑与管理列表溯源）
  const result = await c.env.DB.prepare(
    `INSERT INTO comments (slug, parent_id, nickname, email_md5, website, content, status, ip_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(slug, parentId, nickname, emailMd5, website, content, status, ipBan)
    .run()
  const id = Number(result.meta.last_row_id)

  // ⑩ 回复通知邮箱单独存放（隐私契约：comments 只存 md5；明文邮箱只进 comment_emails）
  if (email !== '') {
    await c.env.DB.prepare('INSERT OR REPLACE INTO comment_emails(comment_id, email) VALUES (?1, ?2)')
      .bind(id, email)
      .run()
  }

  // ⑪ 已审核的回复 → 异步通知被回复者（waitUntil 异步，绝不阻塞响应）
  if (parentId !== null && status === 'approved') {
    c.executionCtx.waitUntil(
      notifyParentOfReply(c.env, {
        parentId,
        replyId: id,
        replyEmailMd5: emailMd5,
        replyNickname: nickname,
        replyContent: content,
        slug,
      }),
    )
  }

  // ⑫ 201（pending 时前端提示「已提交，待审核后展示」）
  return c.json({ code: 0, data: { id, status } }, 201)
})

/* ------------------------------------------------------------------ */
/* POST /api/like — 文章/评论点赞（同指纹 toggle）                        */
/* ------------------------------------------------------------------ */

commentRoutes.post('/like', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return fail(c, 'BAD_JSON', '请求体不是合法 JSON')
  }
  // 契约归一化：前端可能发 {slug, visitor}（文章点赞）或 {comment_id, visitor}（评论点赞），
  // 同时保留原有 {type, id} 兼容形态
  let type: 'post' | 'comment' | null = null
  let id = ''
  if (typeof body.slug === 'string' && body.slug.trim() !== '') {
    type = 'post'
    id = body.slug.trim()
  } else if (body.comment_id !== undefined && body.comment_id !== null && String(body.comment_id).trim() !== '') {
    type = 'comment'
    id = String(body.comment_id).trim()
  } else if (body.type === 'post' || body.type === 'comment') {
    type = body.type
    id = typeof body.id === 'string' || typeof body.id === 'number' ? String(body.id).trim() : ''
  }
  if (type === null || id === '' || id.length > MAX_SLUG) {
    return fail(c, 'BAD_TARGET', '点赞目标不合法')
  }
  if (type === 'comment') {
    const exists = await c.env.DB.prepare('SELECT id FROM comments WHERE id = ?1')
      .bind(Number(id))
      .first<{ id: number }>()
    if (exists === null) return fail(c, 'BAD_TARGET', '评论不存在')
  }

  // 指纹计算切 lib/security.ts（sha256(IP|UA|salt)）
  const hash = await visitorHash(requestIp(c.req.raw), c.req.header('User-Agent') ?? '', visitorSalt(c.env))
  const existing = await c.env.DB.prepare(
    'SELECT id FROM likes WHERE target_type = ?1 AND target_id = ?2 AND voter_hash = ?3',
  )
    .bind(type, id, hash)
    .first<{ id: number }>()

  if (existing !== null) {
    await c.env.DB.prepare('DELETE FROM likes WHERE id = ?1').bind(existing.id).run()
  } else {
    await c.env.DB.prepare(
      'INSERT INTO likes (target_type, target_id, voter_hash) VALUES (?1, ?2, ?3)',
    )
      .bind(type, id, hash)
      .run()
  }
  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM likes WHERE target_type = ?1 AND target_id = ?2',
  )
    .bind(type, id)
    .first<{ n: number }>()
  // 同时返回 likes 别名，兼容前端读取 d.likes 的旧契约
  const n = Number(count?.n ?? 0)
  return c.json({ code: 0, data: { liked: existing === null, count: n, likes: n } })
})

/* ------------------------------------------------------------------ */
/* POST /api/view — 浏览量 +1                                            */
/* ------------------------------------------------------------------ */

commentRoutes.post('/view', async (c) => {
  let body: Record<string, unknown>
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    return fail(c, 'BAD_JSON', '请求体不是合法 JSON')
  }
  const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
  if (slug === '' || slug.length > MAX_SLUG) return fail(c, 'BAD_SLUG', '文章标识不合法')

  await c.env.DB.prepare(
    `INSERT INTO views (slug, count, updated_at) VALUES (?1, 1, datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET count = count + 1, updated_at = datetime('now')`,
  )
    .bind(slug)
    .run()
  const row = await c.env.DB.prepare('SELECT count FROM views WHERE slug = ?1')
    .bind(slug)
    .first<{ count: number }>()
  return c.json({ code: 0, data: { views: Number(row?.count ?? 1) } })
})

/* ------------------------------------------------------------------ */
/* GET /api/stats?slugs=a,b,c — 批量 views+likes+comments                */
/* ------------------------------------------------------------------ */

commentRoutes.get('/stats', async (c) => {
  const raw = c.req.query('slugs') ?? ''
  const slugs = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s.length <= MAX_SLUG)
    .slice(0, 50)
  // 返回数组结构 [{slug, views, likes, comments}]
  const data: Array<{ slug: string; views: number; likes: number; comments: number }> = []
  for (const slug of slugs) {
    const v = await c.env.DB.prepare('SELECT count FROM views WHERE slug = ?1')
      .bind(slug)
      .first<{ count: number }>()
    const l = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM likes WHERE target_type='post' AND target_id = ?1",
    )
      .bind(slug)
      .first<{ n: number }>()
    const cm = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM comments WHERE slug = ?1 AND status = 'approved'",
    )
      .bind(slug)
      .first<{ n: number }>()
    data.push({
      slug,
      views: Number(v?.count ?? 0),
      likes: Number(l?.n ?? 0),
      comments: Number(cm?.n ?? 0),
    })
  }
  return c.json({ code: 0, data })
})

/* ------------------------------------------------------------------ */
/* GET /api/says — 说说列表                                              */
/* ------------------------------------------------------------------ */

commentRoutes.get('/says', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, content, images, created_at FROM says WHERE status='approved' ORDER BY created_at DESC LIMIT 50",
  ).all<{ id: number; content: string; images: string; created_at: string }>()
  const list = (results ?? []).map((r) => ({
    id: r.id,
    content: r.content,
    images: r.images ? (JSON.parse(r.images) as string[]) : [],
    createdAt: r.created_at,
  }))
  return c.json({ code: 0, data: list })
})

export default commentRoutes

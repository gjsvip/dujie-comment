/**
 * dujie-comment 管理后台 API（routes/admin.ts，挂载于 /api/admin，全部经 adminAuth）
 * —— X-Admin-Token + KV 哈希比对 + IP 失败限流，见 lib/security.ts。
 *
 * 端点（8 个；不发「创建评论」端点：博主回复走公开 POST /api/comments
 * + X-Admin-Token 头，免 Turnstile、直接 approved）：
 *   ① GET    /comments            列表（slug/status/q 过滤 + 分页）
 *   ② POST   /comments/:id/approve 审核通过（回复则触发通知）
 *   ③ POST   /comments/:id/hide    隐藏（软删除，公开面立即不可见）
 *   ④ DELETE /comments/:id         硬删除（子评论提升为根，不级联删枝）
 *   ⑤ POST   /comments/:id/ban     拉黑（email/ip/both，INSERT OR IGNORE 幂等）
 *   ⑥ GET    /bans                 黑名单列表（banValue 脱敏）
 *   ⑦ DELETE /bans/:id             解除拉黑
 *   ⑧ GET    /stats                管理驾驶舱（状态分布/黑名单数/上次备份）
 *
 * 统一约定：成功 {code:0, data}；失败 {code, message}；分页 page≥1
 * （默认 1）、page_size∈[1,100]（默认 20）。D1 纪律：全部 ?n 参数化，
 * 零字符串拼接 SQL；批量写用 batch([...]) 保原子。
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from '../types'
import { adminAuth } from '../lib/security'
import { notifyParentOfReply, type NotifyParams } from '../lib/notify'

const adminRoutes = new Hono<AppEnv>()

// 全组鉴权：X-Admin-Token + KV 哈希比对 + IP 失败限流（lib/security.ts）
adminRoutes.use('*', adminAuth)

/* ------------------------------------------------------------------ */
/* 常量（各文件顶部 const，禁魔法字符串跨文件）                            */
/* ------------------------------------------------------------------ */

/** 评论状态三元组 */
const COMMENT_STATUS = ['approved', 'pending', 'hidden'] as const
type CommentStatus = (typeof COMMENT_STATUS)[number]

/** 状态白名单校验（防用户输入直通 SQL；管理 API status 过滤参数唯一入口） */
function isCommentStatus(value: string): value is CommentStatus {
  return (COMMENT_STATUS as readonly string[]).includes(value)
}

const MAX_SLUG = 100
/** 搜索关键词上限（超长截断而非报错——最小侵入） */
const MAX_Q = 50
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20
/** 拉黑原因上限（截断处理，不新增错误码） */
const MAX_REASON = 200

function fail(c: Context<AppEnv>, code: string, message: string, status: ContentfulStatusCode = 400) {
  return c.json({ code, message }, status)
}

/* ------------------------------------------------------------------ */
/* 参数解析助手                                                        */
/* ------------------------------------------------------------------ */

interface PageArgs {
  page: number
  pageSize: number
}

/** 分页参数解析：page≥1（默认 1）、page_size∈[1,100]（默认 20），非法 → 400 BAD_PAGE */
function parsePagination(c: Context<AppEnv>): PageArgs | Response {
  const rawPage = Number.parseInt(c.req.query('page') ?? '1', 10)
  const page = Number.isFinite(rawPage) ? rawPage : 1
  if (page < 1) return fail(c, 'BAD_PAGE', 'page 必须 ≥ 1')
  const rawSize = Number.parseInt(c.req.query('page_size') ?? String(DEFAULT_PAGE_SIZE), 10)
  const pageSize = Number.isFinite(rawSize) ? rawSize : DEFAULT_PAGE_SIZE
  if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    return fail(c, 'BAD_PAGE', `page_size 必须 ∈ [1, ${MAX_PAGE_SIZE}]`)
  }
  return { page, pageSize }
}

/** 路径 :id 解析：正整数，非法 → null（调用方返回 400 BAD_ID） */
function parseId(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** LIKE 通配符转义（ESCAPE '\'）：% _ 与转义符自身都要转，防用户输入改变匹配语义 */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, '\\$&')
}

/** 邮箱脱敏：首字符 + `***@域名`；空邮箱返回 '' */
function maskEmail(email: string): string {
  const trimmed = email.trim()
  if (trimmed === '') return ''
  const at = trimmed.indexOf('@')
  if (at <= 0) return '***'
  return `${trimmed.charAt(0)}***${trimmed.slice(at)}`
}

/** 哈希脱敏：前 8 位 + '…'（哈希无需全量展示） */
function maskHash(value: string): string {
  return `${value.slice(0, 8)}…`
}

/* ------------------------------------------------------------------ */
/* ① GET /api/admin/comments — 评论列表                                */
/* ------------------------------------------------------------------ */

adminRoutes.get('/comments', async (c) => {
  const page = parsePagination(c)
  if (page instanceof Response) return page

  const slug = (c.req.query('slug') ?? '').trim()
  if (slug.length > MAX_SLUG) return fail(c, 'BAD_SLUG', '文章标识不合法')

  const statusRaw = (c.req.query('status') ?? '').trim()
  let status: CommentStatus | null = null
  if (statusRaw !== '') {
    if (!isCommentStatus(statusRaw)) {
      return fail(c, 'BAD_STATUS', 'status 仅支持 approved/pending/hidden')
    }
    status = statusRaw
  }

  // 搜索关键词：≤50，超长截断
  const q = (c.req.query('q') ?? '').trim().slice(0, MAX_Q)

  // 条件拼接 WHERE（仅在有过滤时追加子句，零字符串拼接进 SQL 本体）
  // + 参数数组 bind：规避 D1 client 对编号参数 ?n 与 IS NULL 组合的兼容歧义
  const conds: string[] = []
  const args: (string | number)[] = []
  if (slug !== '') {
    conds.push('c.slug = ?')
    args.push(slug)
  }
  if (status !== null) {
    conds.push('c.status = ?')
    args.push(status)
  }
  if (q !== '') {
    conds.push("(c.nickname LIKE ? ESCAPE '\\' OR c.content LIKE ? ESCAPE '\\')")
    args.push(`%${escapeLike(q)}%`, `%${escapeLike(q)}%`)
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
  const pageArgs = [page.pageSize, (page.page - 1) * page.pageSize]

  interface AdminCommentRow {
    id: number
    parent_id: number | null
    slug: string
    nickname: string
    website: string
    content: string
    status: string
    created_at: string
    ip_hash: string | null
    email: string | null
    likes: number
    reply_count: number
  }

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT c.id, c.parent_id, c.slug, c.nickname, c.website, c.content, c.status, c.created_at, c.ip_hash,
              ce.email AS email,
              (SELECT COUNT(*) FROM likes l WHERE l.target_type='comment' AND l.target_id=CAST(c.id AS TEXT)) AS likes,
              (SELECT COUNT(*) FROM comments r WHERE r.parent_id = c.id) AS reply_count
       FROM comments c
       LEFT JOIN comment_emails ce ON ce.comment_id = c.id
       ${where}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...args, ...pageArgs)
      .all<AdminCommentRow>()

    // 同 WHERE 的 COUNT(*)（total 与列表严格一致）
    const totalRow = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM comments c ${where}`)
      .bind(...args)
      .first<{ total: number }>()

    const items = (results ?? []).map((r) => ({
      id: Number(r.id),
      parentId: r.parent_id === null ? null : Number(r.parent_id),
      slug: r.slug,
      nickname: r.nickname,
      emailMasked: maskEmail(typeof r.email === 'string' ? r.email : ''),
      website: r.website ?? '',
      content: r.content,
      status: r.status,
      createdAt: r.created_at,
      ipHash: r.ip_hash ?? '',
      likes: Number(r.likes ?? 0),
      replyCount: Number(r.reply_count ?? 0),
    }))
    return c.json({
      code: 0,
      data: { items, total: Number(totalRow?.total ?? 0), page: page.page, page_size: page.pageSize },
    })
  } catch (err) {
    // 诊断日志（scope=admin，不带敏感数据）；线上 500 的根因追踪用
    console.error(
      JSON.stringify({ level: 'error', scope: 'admin', msg: 'comments list failed', error: String(err) }),
    )
    return fail(c, 'INTERNAL', '服务器内部错误', 500)
  }
})

/* ------------------------------------------------------------------ */
/* ② POST /api/admin/comments/:id/approve — 审核通过                   */
/* ------------------------------------------------------------------ */

adminRoutes.post('/comments/:id/approve', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return fail(c, 'BAD_ID', '评论 ID 不合法')
  // 前置 SELECT：不存在 → 404；同时取通知所需字段（回复的作者/内容/邮箱 md5）
  const row = await c.env.DB.prepare(
    'SELECT id, parent_id, nickname, email_md5, content, slug FROM comments WHERE id = ?1',
  )
    .bind(id)
    .first<{ id: number; parent_id: number | null; nickname: string; email_md5: string; content: string; slug: string }>()
  if (row === null) return fail(c, 'COMMENT_NOT_FOUND', '评论不存在', 404)

  // 幂等：重复 approve 仍 200
  await c.env.DB.prepare("UPDATE comments SET status = 'approved' WHERE id = ?1").bind(id).run()

  // 被审核的这条是回复（parent_id 非空）→ 异步通知其父评论作者
  // （防循环同 notify.ts：父子同邮箱 md5 即同一人，内部会跳过）
  let notified = false
  if (row.parent_id !== null) {
    const params: NotifyParams = {
      parentId: Number(row.parent_id),
      replyId: id,
      replyEmailMd5: row.email_md5,
      replyNickname: row.nickname,
      replyContent: row.content,
      slug: row.slug,
    }
    c.executionCtx.waitUntil(notifyParentOfReply(c.env, params))
    notified = true
  }
  return c.json({ code: 0, data: { id, status: 'approved', notified } })
})

/* ------------------------------------------------------------------ */
/* ③ POST /api/admin/comments/:id/hide — 隐藏（软删除）                 */
/* ------------------------------------------------------------------ */

adminRoutes.post('/comments/:id/hide', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return fail(c, 'BAD_ID', '评论 ID 不合法')
  const row = await c.env.DB.prepare('SELECT id FROM comments WHERE id = ?1')
    .bind(id)
    .first<{ id: number }>()
  if (row === null) return fail(c, 'COMMENT_NOT_FOUND', '评论不存在', 404)
  // 幂等：重复 hide 仍 200；公开列表/统计立即不可见（查询均带 status='approved'）
  await c.env.DB.prepare("UPDATE comments SET status = 'hidden' WHERE id = ?1").bind(id).run()
  return c.json({ code: 0, data: { id, status: 'hidden' } })
})

/* ------------------------------------------------------------------ */
/* ④ DELETE /api/admin/comments/:id — 硬删除                           */
/* ------------------------------------------------------------------ */

adminRoutes.delete('/comments/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return fail(c, 'BAD_ID', '评论 ID 不合法')
  const row = await c.env.DB.prepare('SELECT id FROM comments WHERE id = ?1')
    .bind(id)
    .first<{ id: number }>()
  if (row === null) return fail(c, 'COMMENT_NOT_FOUND', '评论不存在', 404)

  // batch 保证原子：
  // 1. 子评论提升为根（不级联删回复，避免误删整枝）；
  // 2. 删通知邮箱（comment_emails 删除联动）；
  // 3. 删该评论的点赞（likes.target_id 是 TEXT，需 CAST）；
  // 4. 删评论自身。
  const results = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE comments SET parent_id = NULL WHERE parent_id = ?1').bind(id),
    c.env.DB.prepare('DELETE FROM comment_emails WHERE comment_id = ?1').bind(id),
    c.env.DB.prepare("DELETE FROM likes WHERE target_type = 'comment' AND target_id = CAST(?1 AS TEXT)").bind(id),
    c.env.DB.prepare('DELETE FROM comments WHERE id = ?1').bind(id),
  ])
  const childrenPromoted = Number(results[0]?.meta.changes ?? 0)
  return c.json({ code: 0, data: { id, deleted: true, childrenPromoted } })
})

/* ------------------------------------------------------------------ */
/* ⑤ POST /api/admin/comments/:id/ban — 拉黑                           */
/* ------------------------------------------------------------------ */

adminRoutes.post('/comments/:id/ban', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return fail(c, 'BAD_ID', '评论 ID 不合法')
  let body: Record<string, unknown> = {}
  try {
    body = (await c.req.json()) as Record<string, unknown>
  } catch {
    body = {} // body 可空，空对象走 scope 校验
  }
  const scope = typeof body.scope === 'string' ? body.scope.trim() : ''
  if (scope !== 'email' && scope !== 'ip' && scope !== 'both') {
    return fail(c, 'BAD_SCOPE', 'scope 仅支持 email/ip/both')
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, MAX_REASON) : ''

  const row = await c.env.DB.prepare('SELECT email_md5, ip_hash FROM comments WHERE id = ?1')
    .bind(id)
    .first<{ email_md5: string; ip_hash: string | null }>()
  if (row === null) return fail(c, 'COMMENT_NOT_FOUND', '评论不存在', 404)

  // 先构造全部目标（含 NO_IP 校验）再执行写入：任一日标非法都不落库
  const targets: Array<{ banType: 'email_md5' | 'ip_hash'; banValue: string }> = []
  if (scope === 'email' || scope === 'both') {
    targets.push({ banType: 'email_md5', banValue: row.email_md5 }) // email_md5 恒有值
  }
  if (scope === 'ip' || scope === 'both') {
    const ipHash = (row.ip_hash ?? '').trim()
    if (ipHash === '') return fail(c, 'NO_IP', '该评论无 IP 指纹')
    targets.push({ banType: 'ip_hash', banValue: ipHash })
  }

  const bans: Array<{ banType: string; banValue: string; created: boolean }> = []
  for (const t of targets) {
    // 唯一索引 idx_banned_unique 保证幂等：changes=0 表示已存在
    const res = await c.env.DB.prepare(
      'INSERT OR IGNORE INTO banned(ban_type, ban_value, reason) VALUES (?1, ?2, ?3)',
    )
      .bind(t.banType, t.banValue, reason)
      .run()
    bans.push({ banType: t.banType, banValue: t.banValue, created: Number(res.meta.changes ?? 0) > 0 })
  }
  // 拉黑不自动隐藏该评论（操作正交；需要隐藏请再调 hide）
  return c.json({ code: 0, data: { id, bans } })
})

/* ------------------------------------------------------------------ */
/* ⑥ GET /api/admin/bans — 黑名单列表                                  */
/* ------------------------------------------------------------------ */

adminRoutes.get('/bans', async (c) => {
  const page = parsePagination(c)
  if (page instanceof Response) return page
  const { results } = await c.env.DB.prepare(
    'SELECT id, ban_type, ban_value, reason, created_at FROM banned ORDER BY id DESC LIMIT ?1 OFFSET ?2',
  )
    .bind(page.pageSize, (page.page - 1) * page.pageSize)
    .all<{ id: number; ban_type: string; ban_value: string; reason: string; created_at: string }>()
  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM banned').first<{ total: number }>()
  const items = (results ?? []).map((r) => ({
    id: Number(r.id),
    banType: r.ban_type,
    banValueMasked: maskHash(r.ban_value),
    reason: r.reason ?? '',
    createdAt: r.created_at,
  }))
  return c.json({
    code: 0,
    data: { items, total: Number(totalRow?.total ?? 0), page: page.page, page_size: page.pageSize },
  })
})

/* ------------------------------------------------------------------ */
/* ⑦ DELETE /api/admin/bans/:id — 解除拉黑                              */
/* ------------------------------------------------------------------ */

adminRoutes.delete('/bans/:id', async (c) => {
  const id = parseId(c.req.param('id'))
  if (id === null) return fail(c, 'BAD_ID', '黑名单 ID 不合法')
  const res = await c.env.DB.prepare('DELETE FROM banned WHERE id = ?1').bind(id).run()
  if (Number(res.meta.changes ?? 0) === 0) return fail(c, 'BAN_NOT_FOUND', '黑名单记录不存在', 404)
  return c.json({ code: 0, data: { id, unbanned: true } })
})

/* ------------------------------------------------------------------ */
/* ⑧ GET /api/admin/stats — 管理驾驶舱                                  */
/* ------------------------------------------------------------------ */

adminRoutes.get('/stats', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT status, COUNT(*) AS n FROM comments GROUP BY status',
  ).all<{ status: string; n: number }>()
  // 状态分布：缺失状态按 0（GROUP BY 不产生零行）
  const counts: Record<CommentStatus, number> = { approved: 0, pending: 0, hidden: 0 }
  for (const r of results ?? []) {
    const key = String(r.status)
    if (isCommentStatus(key)) counts[key] = Number(r.n ?? 0)
  }
  const banRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM banned').first<{ n: number }>()

  // 上次备份时间（KV backup:last，异常时按 null 降级不影响统计）
  let lastBackupAt: string | null = null
  try {
    const raw = await c.env.KV.get('backup:last')
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { at?: unknown }
      if (typeof parsed.at === 'string') lastBackupAt = parsed.at
    }
  } catch {
    lastBackupAt = null
  }
  return c.json({
    code: 0,
    data: {
      approved: counts.approved,
      pending: counts.pending,
      hidden: counts.hidden,
      bans: Number(banRow?.n ?? 0),
      lastBackupAt,
    },
  })
})

export default adminRoutes

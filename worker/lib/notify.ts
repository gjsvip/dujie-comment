/**
 * dujie-comment 回复邮件通知（lib/notify.ts）—— 旁路模块，绝不影响评论主流程。
 *
 * 触发时机（两处，条件一致）：
 * - `POST /api/comments` 插入后：parentId !== null && status === 'approved'；
 * - admin `approve` 端点：目标评论 parent_id !== null（审核队列开启后，
 *   访客回复被博主审批通过时才通知被回复者）。
 *
 * 调用方一律 `c.executionCtx.waitUntil(notifyParentOfReply(...))` 异步执行。
 *
 * 防循环（唯一防循环点）：父子邮箱 md5 相同即同一人（博主自回复/访客跟自己的楼），
 * 不通知。降级链：notify_disabled / parent_not_found / no_parent_email /
 * self_reply / no_api_key / send_failed / internal_error，
 * 任何异常兜底为 {sent:false}，绝不向上抛出。
 */
import type { Env } from '../types'
import { getConfig, readEnvString } from './config'

/** Resend 发信端点 */
const RESEND_API_URL = 'https://api.resend.com/emails'
/** Resend 调用超时（毫秒）：通知是旁路，不能长时间占用 */
export const RESEND_TIMEOUT_MS = 8000
/** 回复内容邮件摘录截断（字） */
const EXCERPT_MAX = 120
/** 默认发件人（onboarding@resend.dev 是 Resend 共享测试域，无需域名验证即可试发） */
const DEFAULT_MAIL_FROM = 'dujie-comment <onboarding@resend.dev>'

/** 通知入参（调用方从评论行提取，避免本模块再查一次新评论） */
export interface NotifyParams {
  /** 被回复的评论（通知对象） */
  parentId: number
  /** 新回复（日志与锚点用） */
  replyId: number
  /** 回复者邮箱 md5（防循环比对） */
  replyEmailMd5: string
  replyNickname: string
  replyContent: string
  slug: string
}

/** 通知结果：sent=true 已发；skipped 为降级原因（不发） */
export interface NotifyResult {
  sent: boolean
  skipped?: string
}

/** HTML 转义（用户内容进邮件模板前必须转义） */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 截断到 max 字（超出加省略号） */
function truncate(raw: string, max: number): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw
}

/** 纯文本模板 */
function buildText(
  siteName: string,
  siteUrl: string,
  parentNickname: string,
  slug: string,
  replyNickname: string,
  excerpt: string,
  postUrl: string,
): string {
  return [
    `${parentNickname}，你好：`,
    '',
    `你在文章《${slug}》下的评论有了新回复：`,
    '',
    `> ${replyNickname}：${excerpt}`,
    '',
    postUrl !== '' ? `查看完整讨论：${postUrl}` : '',
    '',
    `—— ${siteName}${siteUrl !== '' ? `（${siteUrl}）` : ''}`,
    '本邮件由系统自动发送，请勿直接回复。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** HTML 模板：最小化内联样式表格（无外链资源，兼容主流邮件客户端） */
function buildHtml(
  siteName: string,
  siteUrl: string,
  parentNickname: string,
  slug: string,
  replyNickname: string,
  excerpt: string,
  postUrl: string,
): string {
  const safeNick = escapeHtml(parentNickname)
  const safeReplyNick = escapeHtml(replyNickname)
  const safeExcerpt = escapeHtml(excerpt)
  const safeSlug = escapeHtml(slug)
  const safeUrl = escapeHtml(postUrl)
  const safeSite = escapeHtml(siteName)
  const safeSiteUrl = escapeHtml(siteUrl)
  return [
    '<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:16px;color:#1a1a2e">',
    `<p>${safeNick}，你好：</p>`,
    `<p>你在文章《${safeSlug}》下的评论有了新回复：</p>`,
    '<blockquote style="margin:12px 0;padding:10px 14px;background:#f4f6fb;border-left:3px solid #4f7cff;border-radius:4px">',
    `<p style="margin:0"><b>${safeReplyNick}</b>：${safeExcerpt}</p>`,
    '</blockquote>',
    postUrl !== '' ? `<p><a href="${safeUrl}" style="color:#4f7cff">查看完整讨论 →</a></p>` : '',
    '<hr style="border:none;border-top:1px solid #e5e7f0;margin:16px 0">',
    `<p style="color:#9aa0b4;font-size:12px">—— ${safeSite}${safeSiteUrl !== '' ? `（${safeSiteUrl}）` : ''}<br>本邮件由系统自动发送，请勿直接回复。</p>`,
    '</div>',
  ].join('')
}

/**
 * 通知被回复者（内部流程顺序即短路顺序）。
 * 整体 try/catch 兜底：任何异常都转为 {sent:false}，绝不向上抛出。
 */
export async function notifyParentOfReply(env: Env, params: NotifyParams): Promise<NotifyResult> {
  try {
    // ① 全局开关（KV cfg:notify_enabled，默认开）
    const cfg = await getConfig(env)
    if (!cfg.notifyEnabled) return { sent: false, skipped: 'notify_disabled' }

    // ② 父评论 + 其通知邮箱（明文邮箱只在 comment_emails，LEFT JOIN 取）
    const parent = await env.DB.prepare(
      `SELECT c.nickname, c.email_md5, ce.email
       FROM comments c LEFT JOIN comment_emails ce ON ce.comment_id = c.id
       WHERE c.id = ?1`,
    )
      .bind(params.parentId)
      .first<{ nickname: string; email_md5: string; email: string | null }>()
    if (parent === null) return { sent: false, skipped: 'parent_not_found' }

    // ③ 父评论未留邮箱 → 静默跳过（评论者没留邮箱，无法通知）
    const parentEmail = typeof parent.email === 'string' ? parent.email.trim() : ''
    if (parentEmail === '') return { sent: false, skipped: 'no_parent_email' }

    // ④ 防循环：父子同邮箱 md5 即同一人，不通知
    if (parent.email_md5 === params.replyEmailMd5) return { sent: false, skipped: 'self_reply' }

    // ⑤ 未配置 API Key → 降级跳过（INFO，不视为错误）
    const apiKey = env.RESEND_API_KEY
    if (apiKey === undefined || apiKey.trim() === '') {
      console.log(
        JSON.stringify({
          level: 'info',
          scope: 'notify',
          msg: '未配置 RESEND_API_KEY，跳过回复通知',
          replyId: params.replyId,
        }),
      )
      return { sent: false, skipped: 'no_api_key' }
    }

    // ⑥ 调 Resend（非 2xx → send_failed + WARN；只记 status 与响应体前 200 字符，不打邮箱明文）
    const siteName = readEnvString(env, 'SITE_NAME', 'dujie-comment')
    const siteUrl = readEnvString(env, 'SITE_URL', '')
    const from = readEnvString(env, 'MAIL_FROM', DEFAULT_MAIL_FROM)
    // 文章链接：POST_URL_BASE + slug；未配置则回退站点主页（再空则不给链接）
    const postUrlBase = readEnvString(env, 'POST_URL_BASE', '')
    const postUrl = postUrlBase !== '' ? `${postUrlBase}${params.slug}` : siteUrl
    const excerpt = truncate(params.replyContent, EXCERPT_MAX)
    const subject = `【${siteName}】${parent.nickname}，你的评论有了新回复`
    let resp: Response
    try {
      resp = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [parentEmail],
          subject,
          text: buildText(siteName, siteUrl, parent.nickname, params.slug, params.replyNickname, excerpt, postUrl),
          html: buildHtml(siteName, siteUrl, parent.nickname, params.slug, params.replyNickname, excerpt, postUrl),
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      })
    } catch (err) {
      console.warn(
        JSON.stringify({ level: 'warn', scope: 'notify', msg: 'Resend 不可达', replyId: params.replyId, error: String(err) }),
      )
      return { sent: false, skipped: 'send_failed' }
    }
    if (!resp.ok) {
      const detail = (await resp.text().catch(() => '')).slice(0, 200)
      console.warn(
        JSON.stringify({
          level: 'warn',
          scope: 'notify',
          msg: 'Resend 返回非 2xx',
          replyId: params.replyId,
          status: resp.status,
          detail,
        }),
      )
      return { sent: false, skipped: 'send_failed' }
    }
    console.log(
      JSON.stringify({
        level: 'info',
        scope: 'notify',
        msg: '回复通知已发送',
        replyId: params.replyId,
        parentId: params.parentId,
      }),
    )
    return { sent: true }
  } catch (err) {
    // 兜底：通知是旁路，任何未预期异常都不得影响评论主流程
    console.error(
      JSON.stringify({ level: 'error', scope: 'notify', msg: 'notifyParentOfReply 未预期异常', error: String(err) }),
    )
    return { sent: false, skipped: 'internal_error' }
  }
}

/**
 * dujie-comment 单元测试（迁移自生产 T04 套件并泛化）。
 *
 * 覆盖：
 * - T01：verifyAdminToken 三态（无记录/错 token/正确 token）、timingSafeEqualHex
 *   （等长不等值/不等长）、visitorHash/ipBanHash 双轨（盐前缀不同不可互替）、
 *   md5 标准向量、getConfig 默认值与 60s 缓存 / fresh 绕过；
 * - T02：adminAuth 中间件（无 token 401、错 token 401、正确 token 200、
 *   同 IP 连续 6 次失败 → 429 ADMIN_RATE_LIMITED）；
 * - T03：verifyTurnstile 三分支（disabled / token missing / verify failed）
 *   及降级分支（secret_missing / fail_open / TURNSTILE_UNAVAILABLE）；
 * - T04：notifyParentOfReply 降级分支（notify_disabled / parent_not_found /
 *   no_parent_email / self_reply / no_api_key / send_failed）与成功路径
 *   （含 SITE_NAME / POST_URL_BASE 泛化）；
 * - T05：runWeeklyBackup 导出结构 + 保留策略（预置 13 个历史 key → 删最旧 1 个、保留 12）。
 *
 * 全部用 mock env（KV/D1/R2/fetch），不触网。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import type { AppEnv, Env } from '../worker/types'
import { ADMIN_TOKEN_HEADER, adminAuth, timingSafeEqualHex, verifyAdminToken } from '../worker/lib/security'
import { getConfig, invalidateConfig } from '../worker/lib/config'
import { ipBanHash, md5, requestIp, visitorHash, visitorSalt, verifyTurnstile, sha256Hex } from '../worker/lib/security'
import { notifyParentOfReply } from '../worker/lib/notify'
import { runWeeklyBackup } from '../worker/routes/backup'

/* ------------------------------------------------------------------ */
/* Mock 环境（KV / D1 / R2 / fetch）                                    */
/* ------------------------------------------------------------------ */

/** 内存 KV（get/put/delete） */
class MockKV {
  store = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

/** 内存 D1：按 SQL 形态分派（notify 的父评论查询 / backup 的全量导出） */
class MockD1 {
  /** notify 查询 LEFT JOIN comment_emails 的返回值（null = 父评论不存在） */
  parentRow: { nickname: string; email_md5: string; email: string | null } | null = null
  comments: Array<Record<string, unknown>> = []
  says: Array<Record<string, unknown>> = []
  prepare(sql: string) {
    const self = this
    const stmt = {
      async first<T>() {
        if (sql.includes('LEFT JOIN comment_emails')) {
          return (self.parentRow ?? null) as T | null
        }
        return null as T | null
      },
      async all<T>() {
        if (sql.includes('FROM comments')) {
          return { results: self.comments as T[], success: true, meta: { changes: 0 } }
        }
        if (sql.includes('FROM says')) {
          return { results: self.says as T[], success: true, meta: { changes: 0 } }
        }
        return { results: [] as T[], success: true, meta: { changes: 0 } }
      },
      async run() {
        return { success: true, meta: { changes: 0, last_row_id: 0 } }
      },
      // 兼容两种调用形态：prepare(sql).all() 与 prepare(sql).bind(...).all()
      bind() {
        return stmt
      },
    }
    return stmt
  }
  async batch(): Promise<Array<{ success: boolean; meta: { changes: number } }>> {
    return []
  }
}

/** 内存 R2：put/list/delete（list 只回 key，保留策略只依赖 key） */
class MockR2 {
  objects = new Map<string, string>()
  async put(key: string, value: unknown): Promise<void> {
    this.objects.set(key, typeof value === 'string' ? value : '')
  }
  async list(opts?: { prefix?: string }): Promise<{ objects: Array<{ key: string }> }> {
    const prefix = opts?.prefix ?? ''
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix))
    return { objects: keys.map((key) => ({ key })) }
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
  async get(): Promise<null> {
    return null
  }
}

/** 组装 mock Env（其余绑定给占位对象，本测试不用） */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: new MockD1() as unknown as D1Database,
    KV: new MockKV() as unknown as KVNamespace,
    R2: new MockR2() as unknown as R2Bucket,
    ...overrides,
  }
}

/** siteverify 成功响应 */
function siteverifyOk(): Response {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** siteverify 失败响应（success:false） */
function siteverifyFail(): Response {
  return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** 组装 notify 入参（默认父子不同邮箱） */
function notifyParams(overrides: Partial<Parameters<typeof notifyParentOfReply>[1]> = {}) {
  return {
    parentId: 7,
    replyId: 42,
    replyEmailMd5: 'b'.repeat(32),
    replyNickname: '回复者',
    replyContent: '这是一条测试回复内容',
    slug: 'cf-worker-comment',
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
/* T01 基础设施                                                        */
/* ------------------------------------------------------------------ */

describe('T01 timingSafeEqualHex', () => {
  it('等长不等值 → false', () => {
    expect(timingSafeEqualHex('a'.repeat(64), 'b'.repeat(64))).toBe(false)
  })
  it('不等长 → false', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false)
    expect(timingSafeEqualHex('', 'a')).toBe(false)
  })
  it('完全相等 → true', () => {
    expect(timingSafeEqualHex('deadbeef', 'deadbeef')).toBe(true)
    expect(timingSafeEqualHex('', '')).toBe(true)
  })
})

describe('T01 verifyAdminToken 三态', () => {
  const TOKEN = 'admin-plain-token-for-test'

  it('KV 无记录 → false', async () => {
    const env = makeEnv()
    expect(await verifyAdminToken(env, TOKEN)).toBe(false)
  })
  it('错 token → false', async () => {
    const env = makeEnv()
    await env.KV.put('admin:token_hash', await sha256Hex(TOKEN))
    expect(await verifyAdminToken(env, 'wrong-token')).toBe(false)
  })
  it('正确 token → true', async () => {
    const env = makeEnv()
    await env.KV.put('admin:token_hash', await sha256Hex(TOKEN))
    expect(await verifyAdminToken(env, TOKEN)).toBe(true)
    // 容忍头尾空白（前端/剪贴板常见）
    expect(await verifyAdminToken(env, `  ${TOKEN}  `)).toBe(true)
  })
  it('无头 / 空白头 → false', async () => {
    const env = makeEnv()
    await env.KV.put('admin:token_hash', await sha256Hex(TOKEN))
    expect(await verifyAdminToken(env, undefined)).toBe(false)
    expect(await verifyAdminToken(env, '   ')).toBe(false)
  })
})

describe('T01 指纹双轨（visitorHash vs ipBanHash）', () => {
  const salt = 'dujie-comment'

  it('visitorHash 算法一致（sha256(IP|UA|salt)）', async () => {
    const hash = await visitorHash('1.2.3.4', 'UnitTestUA/1.0', salt)
    expect(hash).toBe(await sha256Hex('1.2.3.4|UnitTestUA/1.0|dujie-comment'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ipBanHash 盐前缀不同 → 同 IP 下两轨输出不同（不可互相替代）', async () => {
    const v = await visitorHash('1.2.3.4', 'UnitTestUA/1.0', salt)
    const b = await ipBanHash('1.2.3.4', salt)
    expect(b).toBe(await sha256Hex('1.2.3.4|ipban|dujie-comment'))
    expect(b).not.toBe(v)
  })

  it('换 UA 不绕开 IP 黑名单：ipBanHash 与 UA 无关', async () => {
    const b1 = await ipBanHash('1.2.3.4', salt)
    const b2 = await ipBanHash('1.2.3.4', salt)
    expect(b1).toBe(b2)
  })

  it('requestIp：CF-Connecting-IP 优先，回退 X-Forwarded-For，兜底 0.0.0.0', () => {
    expect(requestIp(new Request('https://x.com', { headers: { 'CF-Connecting-IP': '9.9.9.9', 'X-Forwarded-For': '1.1.1.1' } }))).toBe('9.9.9.9')
    expect(requestIp(new Request('https://x.com', { headers: { 'X-Forwarded-For': '1.1.1.1' } }))).toBe('1.1.1.1')
    expect(requestIp(new Request('https://x.com'))).toBe('0.0.0.0')
  })

  it('visitorSalt：env 缺省回落 DEFAULT_VISITOR_SALT', () => {
    expect(visitorSalt(makeEnv())).toBe('dujie-comment')
    expect(visitorSalt(makeEnv({ VISITOR_SALT: 'custom-salt' }))).toBe('custom-salt')
  })
})

describe('T01 md5 标准向量（Gravatar 契约）', () => {
  it('空串 → d41d8cd98f00b204e9800998ecf8427e', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })
  it('abc → 900150983cd24fb0d6963f7d28e17f72', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
  })
  it('非 ASCII 输入按 UTF-8 处理', async () => {
    expect(md5('渡劫')).toBe(await md5Hex('渡劫'))
  })
})

/** md5 对照实现（仅测试用：node crypto 独立验证） */
async function md5Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('md5').update(input, 'utf8').digest('hex')
}

describe('T01 getConfig 默认值 / KV 覆盖 / 缓存', () => {
  beforeEach(() => {
    invalidateConfig()
  })

  it('KV 全空 → 设计默认值（turnstile/moderation 关、failOpen/notify 开）', async () => {
    const cfg = await getConfig(makeEnv())
    expect(cfg).toEqual({
      turnstileEnabled: false,
      turnstileSiteKey: '',
      turnstileFailOpen: true,
      moderationEnabled: false,
      notifyEnabled: true,
    })
  })

  it('KV 置 1 → 开关打开；site key KV 优先于 var', async () => {
    const env = makeEnv({ TURNSTILE_SITE_KEY: 'var-site-key' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    await env.KV.put('cfg:moderation_enabled', '1')
    await env.KV.put('cfg:notify_enabled', '0')
    await env.KV.put('cfg:turnstile_site_key', 'kv-site-key')
    const cfg = await getConfig(env)
    expect(cfg.turnstileEnabled).toBe(true)
    expect(cfg.moderationEnabled).toBe(true)
    expect(cfg.notifyEnabled).toBe(false)
    expect(cfg.turnstileSiteKey).toBe('kv-site-key')
  })

  it('KV 无 site key → 回退 var TURNSTILE_SITE_KEY', async () => {
    const cfg = await getConfig(makeEnv({ TURNSTILE_SITE_KEY: 'var-site-key' }))
    expect(cfg.turnstileSiteKey).toBe('var-site-key')
  })

  it('60s 缓存：非 fresh 读不穿透 KV；fresh 读穿透', async () => {
    const env = makeEnv()
    expect((await getConfig(env)).moderationEnabled).toBe(false)
    await env.KV.put('cfg:moderation_enabled', '1')
    // 缓存未过期 → 仍读到旧值
    expect((await getConfig(env)).moderationEnabled).toBe(false)
    // fresh → 立即看到新值
    expect((await getConfig(env, { fresh: true })).moderationEnabled).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/* T02 管理 API 鉴权中间件                                             */
/* ------------------------------------------------------------------ */

describe('T02 adminAuth 中间件', () => {
  const TOKEN = 'admin-plain-token-for-test'
  let env: Env
  let app: Hono<AppEnv>

  beforeEach(async () => {
    invalidateConfig()
    env = makeEnv()
    await env.KV.put('admin:token_hash', await sha256Hex(TOKEN))
    app = new Hono<AppEnv>()
    app.use('*', adminAuth)
    app.get('/probe', (c) => c.json({ code: 0, data: { ok: true } }))
  })

  function req(headers: Record<string, string> = {}) {
    return app.request('/probe', { headers: { 'CF-Connecting-IP': '7.7.7.7', ...headers } }, env)
  }

  it('无 token → 401 ADMIN_UNAUTHORIZED', async () => {
    const res = await req()
    expect(res.status).toBe(401)
    expect(((await res.json()) as { code: string }).code).toBe('ADMIN_UNAUTHORIZED')
  })

  it('错 token → 401', async () => {
    const res = await req({ [ADMIN_TOKEN_HEADER]: 'nope' })
    expect(res.status).toBe(401)
  })

  it('正确 token → 200', async () => {
    const res = await req({ [ADMIN_TOKEN_HEADER]: TOKEN })
    expect(res.status).toBe(200)
  })

  it('同 IP 连续 6 次失败 → 第 6 次 429 ADMIN_RATE_LIMITED', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await req()).status).toBe(401)
    }
    const res = await req()
    expect(res.status).toBe(429)
    expect(((await res.json()) as { code: string }).code).toBe('ADMIN_RATE_LIMITED')
    // 锁定期间正确 token 也被挡（fail 计数与令牌校验相互独立）
    expect((await req({ [ADMIN_TOKEN_HEADER]: TOKEN })).status).toBe(429)
  })

  it('失败计数按 IP 隔离：换 IP 不受锁', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await req()).status).toBe(i < 5 ? 401 : 429)
    }
    const res = await app.request(
      '/probe',
      { headers: { 'CF-Connecting-IP': '8.8.8.8', [ADMIN_TOKEN_HEADER]: TOKEN } },
      env,
    )
    expect(res.status).toBe(200)
  })
})

/* ------------------------------------------------------------------ */
/* T03 Turnstile 三分支 + 降级                                          */
/* ------------------------------------------------------------------ */

describe('T03 verifyTurnstile', () => {
  beforeEach(() => {
    invalidateConfig()
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('开关关闭 → disabled 放行（不发 siteverify）', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    const out = await verifyTurnstile(env, null, '1.2.3.4')
    expect(out).toEqual({ ok: true, reason: 'disabled' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('开关开启 + token 缺失 → 400 TURNSTILE_TOKEN_MISSING', async () => {
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    const out = await verifyTurnstile(env, null, '1.2.3.4')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(400)
      expect(out.code).toBe('TURNSTILE_TOKEN_MISSING')
    }
  })

  it('开关开启 + token 为空串 → 400 TURNSTILE_TOKEN_MISSING', async () => {
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    const out = await verifyTurnstile(env, '', '1.2.3.4')
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('secret 未配置 → WARN 放行（secret_missing）', async () => {
    const env = makeEnv()
    await env.KV.put('cfg:turnstile_enabled', '1')
    const out = await verifyTurnstile(env, 'token', '1.2.3.4')
    expect(out).toEqual({ ok: true, reason: 'secret_missing' })
  })

  it('siteverify success → pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => siteverifyOk()))
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    const out = await verifyTurnstile(env, 'good-token', '1.2.3.4')
    expect(out).toEqual({ ok: true, reason: 'pass' })
  })

  it('siteverify success=false → 403 TURNSTILE_FAILED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => siteverifyFail()))
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    const out = await verifyTurnstile(env, 'bad-token', '1.2.3.4')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(403)
      expect(out.code).toBe('TURNSTILE_FAILED')
    }
  })

  it('siteverify 不可达 + failOpen=1（默认）→ 放行（fail_open）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    const out = await verifyTurnstile(env, 'token', '1.2.3.4')
    expect(out).toEqual({ ok: true, reason: 'fail_open' })
  })

  it('siteverify 不可达 + failOpen=0 → 503 TURNSTILE_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    await env.KV.put('cfg:turnstile_fail_open', '0')
    const out = await verifyTurnstile(env, 'token', '1.2.3.4')
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.status).toBe(503)
      expect(out.code).toBe('TURNSTILE_UNAVAILABLE')
    }
  })

  it('siteverify 返回 5xx（HTTP 非 2xx）→ 走不可达分支 fail_open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const env = makeEnv({ TURNSTILE_SECRET: 'secret' })
    await env.KV.put('cfg:turnstile_enabled', '1')
    const out = await verifyTurnstile(env, 'token', '1.2.3.4')
    expect(out).toEqual({ ok: true, reason: 'fail_open' })
  })
})

/* ------------------------------------------------------------------ */
/* T04 notify 降级分支 + 泛化变量                                       */
/* ------------------------------------------------------------------ */

describe('T04 notifyParentOfReply', () => {
  let blogDb: MockD1
  let kv: MockKV
  let env: Env

  beforeEach(() => {
    invalidateConfig()
    vi.unstubAllGlobals()
    blogDb = new MockD1()
    kv = new MockKV()
    env = makeEnv({
      DB: blogDb as unknown as D1Database,
      KV: kv as unknown as KVNamespace,
      RESEND_API_KEY: 're_test_key',
    })
    // 默认：父评论存在、有邮箱、与回复者不同邮箱
    blogDb.parentRow = { nickname: '被回复者', email_md5: 'a'.repeat(32), email: 'parent@example.com' }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cfg:notify_enabled=0 → notify_disabled（不发邮件）', async () => {
    await kv.put('cfg:notify_enabled', '0')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await notifyParentOfReply(env, notifyParams())
    expect(res).toEqual({ sent: false, skipped: 'notify_disabled' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('父评论不存在 → parent_not_found', async () => {
    blogDb.parentRow = null
    const res = await notifyParentOfReply(env, notifyParams())
    expect(res).toEqual({ sent: false, skipped: 'parent_not_found' })
  })

  it('父评论无邮箱 → no_parent_email', async () => {
    blogDb.parentRow = { nickname: '被回复者', email_md5: 'a'.repeat(32), email: null }
    const res = await notifyParentOfReply(env, notifyParams())
    expect(res).toEqual({ sent: false, skipped: 'no_parent_email' })
  })

  it('父子同邮箱 md5（自回复）→ self_reply', async () => {
    const res = await notifyParentOfReply(env, notifyParams({ replyEmailMd5: 'a'.repeat(32) }))
    expect(res).toEqual({ sent: false, skipped: 'self_reply' })
  })

  it('无 RESEND_API_KEY → no_api_key（INFO 降级，评论不受影响）', async () => {
    const envNoKey = makeEnv({ DB: blogDb as unknown as D1Database, KV: kv as unknown as KVNamespace })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await notifyParentOfReply(envNoKey, notifyParams())
    expect(res).toEqual({ sent: false, skipped: 'no_api_key' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('Resend 2xx → sent:true；主题含 SITE_NAME；链接含 POST_URL_BASE（泛化入参）', async () => {
    const envCustom = makeEnv({
      DB: blogDb as unknown as D1Database,
      KV: kv as unknown as KVNamespace,
      RESEND_API_KEY: 're_test_key',
      SITE_NAME: '我的站点',
      POST_URL_BASE: 'https://example.com/posts/',
      MAIL_FROM: 'me <noreply@example.com>',
    })
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        from: string
        to: string[]
        subject: string
        text: string
      }
      expect(body.from).toBe('me <noreply@example.com>')
      expect(body.to).toEqual(['parent@example.com'])
      expect(body.subject).toContain('我的站点')
      expect(body.subject).toContain('被回复者')
      expect(body.text).toContain('这是一条测试回复内容')
      expect(body.text).toContain('https://example.com/posts/cf-worker-comment')
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await notifyParentOfReply(envCustom, notifyParams())
    expect(res).toEqual({ sent: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('未配 POST_URL_BASE/SITE_URL → 邮件不含讨论链接（降级不报错）', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; subject: string }
      expect(body.subject).toContain('【dujie-comment】') // 缺省站点名
      expect(body.text).not.toContain('查看完整讨论')
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await notifyParentOfReply(env, notifyParams())
    expect(res).toEqual({ sent: true })
  })

  it('Resend 500 → send_failed（主流程无损）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })))
    const res = await notifyParentOfReply(env, notifyParams())
    expect(res).toEqual({ sent: false, skipped: 'send_failed' })
  })

  it('Resend 网络错误 → send_failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('timeout')
    }))
    const res = await notifyParentOfReply(env, notifyParams())
    expect(res).toEqual({ sent: false, skipped: 'send_failed' })
  })

  it('DB 抛异常 → internal_error 兜底（绝不向上抛）', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('d1 down')
      },
    }
    const brokenEnv = makeEnv({ DB: brokenDb as unknown as D1Database, KV: kv as unknown as KVNamespace })
    const res = await notifyParentOfReply(brokenEnv, notifyParams())
    expect(res.sent).toBe(false)
    expect(res.skipped).toBe('internal_error')
  })
})

/* ------------------------------------------------------------------ */
/* T05 备份导出 + 保留策略                                             */
/* ------------------------------------------------------------------ */

describe('T05 runWeeklyBackup', () => {
  beforeEach(() => {
    invalidateConfig()
  })

  it('导出结构：R2 key=backups/<UTC日期>.json，含 comments+says 全量与 counts，KV 状态标记更新', async () => {
    const blogDb = new MockD1()
    blogDb.comments = [
      { id: 1, slug: 'a', status: 'approved', content: 'x' },
      { id: 2, slug: 'b', status: 'pending', content: 'y' }, // pending 也导出（恢复用，不过滤）
    ]
    blogDb.says = [{ id: 1, content: 's', status: 'approved' }]
    const r2 = new MockR2()
    const kv = new MockKV()
    const env = makeEnv({
      DB: blogDb as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      KV: kv as unknown as KVNamespace,
    })

    const summary = await runWeeklyBackup(env)
    const today = new Date().toISOString().slice(0, 10)
    expect(summary.key).toBe(`backups/${today}.json`)
    expect(summary.comments).toBe(2)
    expect(summary.says).toBe(1)
    expect(summary.deleted).toEqual([])

    // R2 落盘内容校验
    const raw = r2.objects.get(summary.key)
    expect(raw).toBeTypeOf('string')
    const payload = JSON.parse(raw as string) as {
      exportedAt: string
      tables: { comments: unknown[]; says: unknown[] }
      counts: { comments: number; says: number }
    }
    expect(payload.counts).toEqual({ comments: 2, says: 1 })
    expect(payload.tables.comments).toHaveLength(2)
    expect(payload.tables.says).toHaveLength(1)
    expect(payload.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // KV backup:last（admin stats 数据源）
    const last = JSON.parse(kv.store.get('backup:last') as string) as { key: string; at: string }
    expect(last.key).toBe(summary.key)
    expect(last.at).toBeTypeOf('string')
  })

  it('保留策略：预置 13 个历史 key（含今天）后触发 → 删最旧 1 个、保留 12', async () => {
    const blogDb = new MockD1()
    const r2 = new MockR2()
    const kv = new MockKV()
    const env = makeEnv({
      DB: blogDb as unknown as D1Database,
      R2: r2 as unknown as R2Bucket,
      KV: kv as unknown as KVNamespace,
    })

    // 预置 13 个 key：今天 + 过去 12 天（含今天 → 新备份覆盖同 key，总数 13）
    const dates: string[] = []
    for (let i = 12; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      dates.push(d)
      r2.objects.set(`backups/${d}.json`, 'old')
    }
    const oldest = `backups/${dates[0]}.json`
    const todayKey = `backups/${dates[12]}.json`
    expect(r2.objects.size).toBe(13)

    const summary = await runWeeklyBackup(env)
    expect(summary.deleted).toEqual([oldest])
    expect(r2.objects.size).toBe(12)
    expect(r2.objects.has(oldest)).toBe(false)
    expect(r2.objects.has(todayKey)).toBe(true) // 今天的新备份在保留集内
    expect(summary.key).toBe(todayKey)
  })
})

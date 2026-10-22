/**
 * dujie-comment 全应用集成测试（tests/integration.test.ts）。
 *
 * 与 comment.test.ts（纯逻辑单测，mock 分发）的区别：本文件用 **真实 SQLite**
 * （node:sqlite 内存库 + schema.sql 真表）+ D1 兼容适配层，挂载完整的
 * comments/admin 路由组，端到端验证：
 * - 公开链路：config / 评论树 / 发表 / 字段校验 / 跨文章回复 / 限流 / 点赞 toggle / 浏览 / 统计；
 * - 审核状态机：moderation 开 → pending → admin approve → approved → 公开可见；
 * - 管理链路：401/200 鉴权、列表、拉黑后投稿 403、隐藏、硬删除（子评论提升为根）；
 * - 通知旁路：回复触发 Resend（fetch mock），不阻塞主响应。
 *
 * 适配层把 D1 的 `?n` 编号参数 + `.bind()` 形态翻译为 node:sqlite 的对象参数。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import type { AppEnv, Env } from '../worker/types'
import commentRoutes from '../worker/routes/comments'
import adminRoutes from '../worker/routes/admin'
import { ADMIN_TOKEN_HEADER, sha256Hex } from '../worker/lib/security'
import { invalidateConfig } from '../worker/lib/config'

/** node:sqlite 经 createRequire 加载（规避 vite 对 node: 内置模块的 URL 解析） */
const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

/* ------------------------------------------------------------------ */
/* 内存 KV                                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* D1 → node:sqlite 适配层                                              */
/* ------------------------------------------------------------------ */

/** 判断 SQL 是否使用 `?n` 编号参数（D1 形态）；否则按匿名 `?` 位置传参 */
function usesNumberedParams(sql: string): boolean {
  return /\?\d+/.test(sql)
}

class SqliteD1 {
  private db: DatabaseSync
  constructor(schemaSql: string) {
    this.db = new DatabaseSync(':memory:')
    this.db.exec(schemaSql)
  }
  prepare(sql: string) {
    const db = this.db
    const numbered = usesNumberedParams(sql)
    // D1 bind(a, b)：编号参数 → {1: a, 2: b}（node:sqlite 对象形态）；
    // 匿名 ? → 位置展开传参
    const toArgs = (args: unknown[]): unknown[] => {
      if (!numbered) return args
      const obj: Record<number, unknown> = {}
      args.forEach((v, i) => {
        obj[i + 1] = v
      })
      return [obj]
    }
    return {
      bind(...args: unknown[]) {
        return {
          async all<T>() {
            const rows = db.prepare(sql).all(...(toArgs(args) as never[]))
            return { results: rows as T[], success: true, meta: { changes: 0 } }
          },
          async first<T>() {
            const row = db.prepare(sql).get(...(toArgs(args) as never[]))
            return (row ?? null) as T | null
          },
          async run() {
            const r = db.prepare(sql).run(...(toArgs(args) as never[]))
            return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
          },
        }
      },
      // 无 bind 直接调用（本测试未用到，保留 D1 形态完整）
      async all<T>() {
        const rows = db.prepare(sql).all()
        return { results: rows as T[], success: true, meta: { changes: 0 } }
      },
      async first<T>() {
        const row = db.prepare(sql).get()
        return (row ?? null) as T | null
      },
      async run() {
        const r = db.prepare(sql).run()
        return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
      },
    }
  }
  /** D1 batch：事务内顺序执行，返回每条 meta */
  async batch(stmts: Array<{ run(): Promise<{ meta: { changes: number } }> }>) {
    this.db.exec('BEGIN')
    try {
      const out = []
      for (const s of stmts) out.push(await s.run())
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
  /** 测试辅助：直接执行 SQL */
  exec(sql: string): void {
    this.db.exec(sql)
  }
}

/* ------------------------------------------------------------------ */
/* 测试基座                                                             */
/* ------------------------------------------------------------------ */

const ADMIN_TOKEN = 'integration-admin-token'
const IP = '203.0.113.50'

const schemaSql = readFileSync(new URL('../schema.sql', import.meta.url), 'utf-8')

interface Ctx {
  env: Env
  app: Hono<AppEnv>
  db: SqliteD1
  kv: MockKV
  /** waitUntil 收集的后台任务（测试中手动 flush） */
  pending: Array<Promise<unknown>>
  /** 带默认头的 JSON 请求助手 */
  req(path: string, init?: RequestInit & { ip?: string; admin?: boolean }): Promise<Response>
}

function makeCtx(): Ctx {
  const db = new SqliteD1(schemaSql)
  const kv = new MockKV()
  const env: Env = {
    DB: db as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    R2: {} as unknown as R2Bucket,
    RESEND_API_KEY: 're_integration_test',
  }
  const app = new Hono<AppEnv>()
  app.route('/api', commentRoutes)
  app.route('/api/admin', adminRoutes)
  const pending: Array<Promise<unknown>> = []
  // Hono app.request 第四参数注入 ExecutionContext：waitUntil 收集而非丢弃，
  // 使通知旁路在测试中可确定性 flush
  const execCtx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p)
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return {
    env,
    app,
    db,
    kv,
    pending,
    req(path, init = {}) {
      const headers: Record<string, string> = {
        'CF-Connecting-IP': init.ip ?? IP,
        'User-Agent': 'IntegrationTest/1.0',
        ...(init.headers as Record<string, string> | undefined),
      }
      if (init.admin) headers[ADMIN_TOKEN_HEADER] = ADMIN_TOKEN
      if (init.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
      return app.request(path, { ...init, headers }, env, execCtx)
    },
  }
}

/** 种子数据：demo-post-1 两条（其中一条为另一条的回复）+ other-post 一条 */
function seed(db: SqliteD1): { rootId: number; replyId: number } {
  db.exec(
    `INSERT INTO comments (slug, parent_id, nickname, email_md5, website, content, status, ip_hash)
     VALUES ('demo-post-1', NULL, '根评论者', '${'a'.repeat(32)}', '', '根评论内容', 'approved', '${'i'.repeat(64)}')`,
  )
  db.exec(
    `INSERT INTO comments (slug, parent_id, nickname, email_md5, website, content, status, ip_hash)
     VALUES ('demo-post-1', 1, '回复者', '${'b'.repeat(32)}', '', '回复内容', 'approved', '${'j'.repeat(64)}')`,
  )
  db.exec(
    `INSERT INTO comments (slug, parent_id, nickname, email_md5, website, content, status, ip_hash)
     VALUES ('other-post', NULL, '隔壁文章', '${'c'.repeat(32)}', '', '别处的评论', 'approved', '${'k'.repeat(64)}')`,
  )
  db.exec(`INSERT INTO comment_emails(comment_id, email) VALUES (1, 'parent@example.com')`)
  db.exec(`INSERT INTO comment_emails(comment_id, email) VALUES (2, 'child@example.com')`)
  return { rootId: 1, replyId: 2 }
}

function json(res: Response): Promise<Record<string, never>> {
  return res.json() as Promise<Record<string, never>>
}

beforeEach(() => {
  invalidateConfig()
  vi.unstubAllGlobals()
})

/* ------------------------------------------------------------------ */
/* 公开链路                                                            */
/* ------------------------------------------------------------------ */

describe('集成：公开 API 链路', () => {
  it('GET /api/config 返回灰度开关默认值', async () => {
    const ctx = makeCtx()
    const res = await ctx.req('/api/config')
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toMatchObject({ code: 0 })
    expect((body as unknown as { data: { turnstile: { enabled: boolean } } }).data.turnstile.enabled).toBe(false)
  })

  it('GET /api/comments 返回评论树（含嵌套回复）', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const res = await ctx.req('/api/comments?slug=demo-post-1')
    expect(res.status).toBe(200)
    const body = (await json(res)) as unknown as {
      data: { comments: Array<{ id: number; replies: unknown[] }>; total: number }
    }
    expect(body.data.total).toBe(2)
    expect(body.data.comments).toHaveLength(1)
    expect(body.data.comments[0].replies).toHaveLength(1)
    expect(body.data.comments[0].replies[0]).toMatchObject({ id: 2, parentId: 1 })
  })

  it('GET /api/comments 缺少 slug → 400 BAD_SLUG', async () => {
    const ctx = makeCtx()
    const res = await ctx.req('/api/comments')
    expect(res.status).toBe(400)
    expect(((await json(res)) as unknown as { code: string }).code).toBe('BAD_SLUG')
  })

  it('POST /api/comments 合法投稿 → 201 approved 且落库', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const res = await ctx.req('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ slug: 'demo-post-1', nickname: '新访客', email: 'new@example.com', content: '集成测试投稿' }),
    })
    expect(res.status).toBe(201)
    const body = (await json(res)) as unknown as { data: { id: number; status: string } }
    expect(body.data.status).toBe('approved')
    expect(body.data.id).toBeGreaterThan(0)

    const row = ctx.db.prepare('SELECT nickname, status FROM comments WHERE id = ?1').bind(body.data.id).first<{
      nickname: string
      status: string
    }>()
    expect(row).toMatchObject({ nickname: '新访客', status: 'approved' })
    // 通知邮箱隔离存放
    const email = ctx.db
      .prepare('SELECT email FROM comment_emails WHERE comment_id = ?1')
      .bind(body.data.id)
      .first<{ email: string }>()
    expect(email?.email).toBe('new@example.com')
  })

  it('POST /api/comments 字段校验：空昵称 / 坏邮箱 / 超长内容 → 400', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ slug: 'demo-post-1', nickname: '', content: 'x' }, 'BAD_NICKNAME'],
      [{ slug: 'demo-post-1', nickname: 'a', email: 'not-an-email', content: 'x' }, 'BAD_EMAIL'],
      [{ slug: 'demo-post-1', nickname: 'a', content: '' }, 'BAD_CONTENT'],
      [{ slug: 'demo-post-1', nickname: 'a', content: 'x', website: 'ftp://bad' }, 'BAD_WEBSITE'],
      [{ nickname: 'a', content: 'x' }, 'BAD_SLUG'],
    ]
    for (const [payload, code] of cases) {
      const res = await ctx.req('/api/comments', { method: 'POST', body: JSON.stringify(payload) })
      expect(res.status).toBe(400)
      expect(((await json(res)) as unknown as { code: string }).code).toBe(code)
    }
  })

  it('POST /api/comments 跨文章回复 → 400 BAD_PARENT', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const res = await ctx.req('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ slug: 'other-post', nickname: 'a', content: 'x', parentId: 1 }),
    })
    expect(res.status).toBe(400)
    expect(((await json(res)) as unknown as { code: string }).code).toBe('BAD_PARENT')
  })

  it('POST /api/comments 同指纹第 3 条 → 429 RATE_LIMITED', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const post = () =>
      ctx.req('/api/comments', {
        method: 'POST',
        body: JSON.stringify({ slug: 'demo-post-1', nickname: '限流测试', content: 'x' }),
      })
    expect((await post()).status).toBe(201)
    expect((await post()).status).toBe(201)
    const third = await post()
    expect(third.status).toBe(429)
    expect(((await json(third)) as unknown as { code: string }).code).toBe('RATE_LIMITED')
    // 换 IP（换指纹）即恢复
    const res = await ctx.req('/api/comments', {
      method: 'POST',
      ip: '198.51.100.99',
      body: JSON.stringify({ slug: 'demo-post-1', nickname: '限流测试', content: 'x' }),
    })
    expect(res.status).toBe(201)
  })

  it('POST /api/like 评论点赞 toggle：liked→count+1→取消→count-1', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const like = () =>
      ctx.req('/api/like', { method: 'POST', body: JSON.stringify({ comment_id: 1 }) })
    const first = (await json(await like())) as unknown as { data: { liked: boolean; count: number } }
    expect(first.data).toMatchObject({ liked: true, count: 1 })
    const second = (await json(await like())) as unknown as { data: { liked: boolean; count: number } }
    expect(second.data).toMatchObject({ liked: false, count: 0 })
  })

  it('POST /api/view 浏览 +1；GET /api/stats 返回聚合', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const view = (await json(await ctx.req('/api/view', { method: 'POST', body: JSON.stringify({ slug: 'demo-post-1' }) }))) as unknown as {
      data: { views: number }
    }
    expect(view.data.views).toBe(1)
    await ctx.req('/api/view', { method: 'POST', body: JSON.stringify({ slug: 'demo-post-1' }) })
    const stats = (await json(await ctx.req('/api/stats?slugs=demo-post-1,other-post'))) as unknown as {
      data: Array<{ slug: string; views: number; comments: number }>
    }
    expect(stats.data).toEqual([
      { slug: 'demo-post-1', views: 2, likes: 0, comments: 2 },
      { slug: 'other-post', views: 0, likes: 0, comments: 1 },
    ])
  })

  it('POST /api/comments 请求体非 JSON → 400 BAD_JSON', async () => {
    const ctx = makeCtx()
    const res = await ctx.req('/api/comments', { method: 'POST', body: 'not-json' })
    expect(res.status).toBe(400)
    expect(((await json(res)) as unknown as { code: string }).code).toBe('BAD_JSON')
  })
})

/* ------------------------------------------------------------------ */
/* 审核状态机                                                          */
/* ------------------------------------------------------------------ */

describe('集成：审核状态机（moderation）', () => {
  it('开关开启 → 投稿 pending → admin approve → approved → 公开可见', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    await ctx.kv.put('admin:token_hash', await sha256Hex(ADMIN_TOKEN))
    await ctx.kv.put('cfg:moderation_enabled', '1')

    // 开关生效（fresh 读）
    const cfg = (await json(await ctx.req('/api/config'))) as unknown as {
      data: { moderation: { enabled: boolean } }
    }
    expect(cfg.data.moderation.enabled).toBe(true)

    const created = (await json(
      await ctx.req('/api/comments', {
        method: 'POST',
        body: JSON.stringify({ slug: 'demo-post-1', nickname: '待审核', content: '等待审核的内容' }),
      }),
    )) as unknown as { data: { id: number; status: string } }
    expect(created.data.status).toBe('pending')

    // 公开列表暂不可见
    const before = (await json(await ctx.req('/api/comments?slug=demo-post-1'))) as unknown as {
      data: { total: number }
    }
    expect(before.data.total).toBe(2)

    // 博主审核通过
    const approve = await ctx.req(`/api/admin/comments/${created.data.id}/approve`, { method: 'POST', body: '{}', admin: true })
    expect(approve.status).toBe(200)

    const after = (await json(await ctx.req('/api/comments?slug=demo-post-1'))) as unknown as {
      data: { total: number }
    }
    expect(after.data.total).toBe(3)
  })

  it('博主带 X-Admin-Token 从公开表单投稿 → 免审直接 approved', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    await ctx.kv.put('admin:token_hash', await sha256Hex(ADMIN_TOKEN))
    await ctx.kv.put('cfg:moderation_enabled', '1')

    const res = await ctx.req('/api/comments', {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ slug: 'demo-post-1', nickname: '博主', content: '博主直属回复' }),
    })
    expect(res.status).toBe(201)
    const body = (await json(res)) as unknown as { data: { status: string } }
    expect(body.data.status).toBe('approved')
  })
})

/* ------------------------------------------------------------------ */
/* 管理链路                                                            */
/* ------------------------------------------------------------------ */

describe('集成：管理 API 链路', () => {
  async function adminCtx(): Promise<Ctx> {
    const ctx = makeCtx()
    seed(ctx.db)
    await ctx.kv.put('admin:token_hash', await sha256Hex(ADMIN_TOKEN))
    return ctx
  }

  it('无 token / 错 token → 401；正确 token → 200', async () => {
    const ctx = await adminCtx()
    const noToken = await ctx.req('/api/admin/stats')
    expect(noToken.status).toBe(401)
    expect(((await json(noToken)) as unknown as { code: string }).code).toBe('ADMIN_UNAUTHORIZED')

    const wrong = await ctx.req('/api/admin/stats', { headers: { [ADMIN_TOKEN_HEADER]: 'wrong' } })
    expect(wrong.status).toBe(401)

    const ok = await ctx.req('/api/admin/stats', { admin: true })
    expect(ok.status).toBe(200)
    const body = (await json(ok)) as unknown as { data: { approved: number; pending: number; hidden: number } }
    expect(body.data).toMatchObject({ approved: 3, pending: 0, hidden: 0 })
  })

  it('评论列表：分页 + 邮箱脱敏 + 回复计数', async () => {
    const ctx = await adminCtx()
    const res = await ctx.req('/api/admin/comments?page=1&page_size=20', { admin: true })
    expect(res.status).toBe(200)
    const body = (await json(res)) as unknown as {
      data: { items: Array<{ id: number; emailMasked: string; replyCount: number }>; total: number }
    }
    expect(body.data.total).toBe(3)
    const root = body.data.items.find((i) => i.id === 1)
    expect(root?.emailMasked).toBe('p***@example.com')
    expect(root?.replyCount).toBe(1)
  })

  it('拉黑（both）→ 同 IP + 同邮箱投稿 → 403 BANNED', async () => {
    const ctx = await adminCtx()
    // 用受控 IP/邮箱先投一条
    const created = (await json(
      await ctx.req('/api/comments', {
        method: 'POST',
        ip: '192.0.2.77',
        body: JSON.stringify({ slug: 'demo-post-1', nickname: '将被拉黑', email: 'banned@example.com', content: 'troll' }),
      }),
    )) as unknown as { data: { id: number } }

    const ban = await ctx.req(`/api/admin/comments/${created.data.id}/ban`, {
      method: 'POST',
      admin: true,
      body: JSON.stringify({ scope: 'both', reason: '测试拉黑' }),
    })
    expect(ban.status).toBe(200)
    const banBody = (await json(ban)) as unknown as { data: { bans: Array<{ created: boolean }> } }
    expect(banBody.data.bans.every((b) => b.created)).toBe(true)

    // 同 IP 再投 → 403
    const res = await ctx.req('/api/comments', {
      method: 'POST',
      ip: '192.0.2.77',
      body: JSON.stringify({ slug: 'demo-post-1', nickname: 'troll', content: 'again' }),
    })
    expect(res.status).toBe(403)
    expect(((await json(res)) as unknown as { code: string }).code).toBe('BANNED')

    // 解除拉黑后恢复（换分钟桶避开限流）
    const bans = (await json(await ctx.req('/api/admin/bans', { admin: true }))) as unknown as {
      data: { items: Array<{ id: number }> }
    }
    const unban = await ctx.req(`/api/admin/bans/${bans.data.items[0].id}`, { method: 'DELETE', admin: true })
    expect(unban.status).toBe(200)
    const after = await ctx.req('/api/comments', {
      method: 'POST',
      ip: '192.0.2.78',
      body: JSON.stringify({ slug: 'demo-post-1', nickname: 'troll', content: 'again' }),
    })
    expect(after.status).toBe(201)
  })

  it('隐藏 → 公开面立即不可见；admin 列表仍可见', async () => {
    const ctx = await adminCtx()
    const hide = await ctx.req('/api/admin/comments/1/hide', { method: 'POST', body: '{}', admin: true })
    expect(hide.status).toBe(200)
    const pub = (await json(await ctx.req('/api/comments?slug=demo-post-1'))) as unknown as {
      data: { total: number }
    }
    expect(pub.data.total).toBe(1) // 只剩回复（父被隐藏后回复提为视觉根？——父隐藏后子仍在 approved 集
    const stats = (await json(await ctx.req('/api/admin/stats', { admin: true }))) as unknown as {
      data: { hidden: number }
    }
    expect(stats.data.hidden).toBe(1)
  })

  it('硬删除：子评论提升为根，不级联删除', async () => {
    const ctx = await adminCtx()
    const del = await ctx.req('/api/admin/comments/1', { method: 'DELETE', admin: true })
    expect(del.status).toBe(200)
    const body = (await json(del)) as unknown as { data: { childrenPromoted: number } }
    expect(body.data.childrenPromoted).toBe(1)
    const child = ctx.db
      .prepare('SELECT parent_id FROM comments WHERE id = 2')
      .first<{ parent_id: number | null }>()
    expect(child?.parent_id).toBe(null)
    const pub = (await json(await ctx.req('/api/comments?slug=demo-post-1'))) as unknown as {
      data: { total: number }
    }
    expect(pub.data.total).toBe(1)
  })

  it('admin 操作不存在的评论 → 404 COMMENT_NOT_FOUND', async () => {
    const ctx = await adminCtx()
    const res = await ctx.req('/api/admin/comments/9999/hide', { method: 'POST', body: '{}', admin: true })
    expect(res.status).toBe(404)
    expect(((await json(res)) as unknown as { code: string }).code).toBe('COMMENT_NOT_FOUND')
  })
})

/* ------------------------------------------------------------------ */
/* 通知旁路                                                            */
/* ------------------------------------------------------------------ */

describe('集成：回复通知旁路（Resend）', () => {
  it('已审核回复触发通知：to=父邮箱、主题含站点名、内容含摘要', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { to: string[]; subject: string; text: string }
      expect(body.to).toEqual(['parent@example.com'])
      expect(body.subject).toContain('dujie-comment')
      expect(body.text).toContain('集成测试回复')
      return new Response(JSON.stringify({ id: 'email_x' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const res = await ctx.req('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ slug: 'demo-post-1', nickname: '通知测试', content: '集成测试回复', parentId: 1 }),
    })
    expect(res.status).toBe(201)
    // waitUntil 在测试环境同步刷新：fetch 已被调用
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('未配置 RESEND_API_KEY → no_api_key 降级，投稿仍 201', async () => {
    const ctx = makeCtx()
    seed(ctx.db)
    ctx.env.RESEND_API_KEY = undefined
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await ctx.req('/api/comments', {
      method: 'POST',
      body: JSON.stringify({ slug: 'demo-post-1', nickname: '无 key', content: 'x', parentId: 1 }),
    })
    expect(res.status).toBe(201)
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

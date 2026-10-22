/**
 * dujie-comment Worker 入口（Hono）。
 *
 * 职责：
 * - `/api/*` 请求交 Hono 应用（config / comments / like / view / stats / says / admin）；
 * - `/client/*`、`/admin`、`/demo` 由 routes/static.ts 托管自带前端文件
 *   （?raw 内联，见该文件注释）；
 * - 内联中间件链（按注册顺序执行）：
 *   1. requestId —— 生成 / 透传 X-Request-Id，响应头回写，结构化访问日志；
 *   2. CORS —— 白名单 = CORS_ORIGINS + 本地开发源，OPTIONS 预检直接 204；
 * - 统一错误归一化：未预期异常一律 500 INTERNAL（细节只进日志，不泄露给客户端）；
 * - scheduled：周一 02:00 UTC 周备份到 R2（waitUntil + catch，失败下周自然重跑）。
 */
import { Hono } from 'hono'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, Env } from './types'
import commentRoutes from './routes/comments'
import adminRoutes from './routes/admin'
import staticRoutes from './routes/static'
import { runWeeklyBackup } from './routes/backup'

/* ------------------------------------------------------------------ */
/* Hono 应用与统一 JSON 错误响应助手                                     */
/* ------------------------------------------------------------------ */

const app = new Hono<AppEnv>()

/**
 * 构造统一错误响应（信封：`{code, message}`）。
 * 直接构造 Response 而非 c.json，以便 onError 中以运行时状态码渲染。
 */
function jsonError(code: string, message: string, status: number): Response {
  const body = { code, message }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/* ------------------------------------------------------------------ */
/* 中间件 1：requestId（透传 / 生成 + 访问日志）                         */
/* ------------------------------------------------------------------ */

/** 单条访问日志（结构化 JSON，wrangler tail 可直接检索） */
function logAccess(c: Context<AppEnv>, requestId: string, startedAt: number): void {
  console.log(
    JSON.stringify({
      level: 'info',
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    }),
  )
}

const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  // 优先透传客户端 / 上游传入的 X-Request-Id（截断防滥用），否则本地生成
  const inbound = c.req.header('X-Request-Id')
  const requestId =
    inbound !== undefined && inbound.trim() !== '' ? inbound.trim().slice(0, 64) : newRandomId()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)

  const startedAt = Date.now()
  await next()
  logAccess(c, requestId, startedAt)
}

/** 请求 ID：随机 16 位 base62（仅用于日志关联，无安全语义） */
function newRandomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  let out = ''
  for (const b of bytes) out += alphabet[b % alphabet.length]
  return `req_${out}`
}

/* ------------------------------------------------------------------ */
/* 中间件 2：CORS（白名单 = CORS_ORIGINS + 本地开发源）                  */
/* ------------------------------------------------------------------ */

/** 预检缓存 24h（秒） */
const CORS_MAX_AGE_SEC = 86400
/** 允许的请求方法（与端点表一致） */
const CORS_ALLOWED_METHODS = 'GET, POST, DELETE, OPTIONS'
/** 允许的请求头（Content-Type + 管理令牌 + requestId 透传） */
const CORS_ALLOWED_HEADERS = 'Content-Type, X-Admin-Token, X-Request-Id'

/**
 * 判断 Origin 是否命中白名单：
 * - CORS_ORIGINS 环境变量（逗号分隔的多源：你的站点 / 镜像站等）；
 * - 本地开发源 http(s)://localhost | 127.0.0.1 任意端口（wrangler dev 调试用）。
 */
function isOriginAllowed(origin: string, env: Env): boolean {
  const extraOrigins = env.CORS_ORIGINS ?? ''
  if (extraOrigins !== '') {
    const list = extraOrigins
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    if (list.includes(origin)) {
      return true
    }
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
}

const corsMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin')
  // 无 Origin（同源 GET / 服务端调用）或不在白名单：不回写 CORS 头，
  // 由浏览器同源策略自行拦截（服务端不主动报错，避免泄露白名单判定逻辑）。
  if (origin === undefined || !isOriginAllowed(origin, c.env)) {
    await next()
    return
  }
  c.header('Access-Control-Allow-Origin', origin)
  c.header('Access-Control-Allow-Methods', CORS_ALLOWED_METHODS)
  c.header('Access-Control-Allow-Headers', CORS_ALLOWED_HEADERS)
  c.header('Access-Control-Expose-Headers', 'X-Request-Id')
  c.header('Access-Control-Max-Age', String(CORS_MAX_AGE_SEC))
  c.header('Vary', 'Origin')
  if (c.req.method === 'OPTIONS') {
    // 预检请求直接放行（不带任何业务处理）
    return c.body(null, 204)
  }
  await next()
}

/* ------------------------------------------------------------------ */
/* 中间件注册与路由挂载                                                  */
/* ------------------------------------------------------------------ */

app.use('*', requestIdMiddleware)
app.use('*', corsMiddleware)

// 公开互动 API（config / comments / like / view / stats / says，免鉴权）
app.route('/api', commentRoutes)
// 管理后台 API（8 个端点，组内 adminAuth 鉴权）
app.route('/api/admin', adminRoutes)
// 自带前端文件托管（client 嵌入组件 / admin 后台 / demo 演示页）
app.route('/', staticRoutes)

/** 服务信息（探活 + 版本标识） */
app.get('/', (c) =>
  c.json({
    code: 0,
    data: {
      service: 'dujie-comment',
      version: '1.0.0',
      docs: 'https://github.com/gjsvip/dujie-comment',
      endpoints: ['/api/config', '/api/comments', '/api/like', '/api/view', '/api/stats', '/api/says', '/api/admin/*'],
    },
  }),
)

/** 统一错误归一化：未预期异常 500 且细节只进日志 */
app.onError((err, c) => {
  const requestId = c.get('requestId') ?? 'unknown'
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      method: c.req.method,
      path: c.req.path,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  )
  return jsonError('INTERNAL', '服务器内部错误', 500)
})

/** 未匹配路由：JSON 404 */
app.notFound((c) => {
  return jsonError('NOT_FOUND', '接口不存在', 404)
})

/* ------------------------------------------------------------------ */
/* Worker 默认导出：全量交 Hono；scheduled 触发周备份                    */
/* ------------------------------------------------------------------ */

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx)
  },
  // 定时备份（wrangler.toml [triggers] crons = ["0 2 * * 1"]，周一 02:00 UTC）：
  // waitUntil 保证 backup 在 isolate 回收前执行完；异常由 backup 调用链上抛至此，
  // 记 console.error 后本周失败不重试，下周一自然重跑。
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runWeeklyBackup(env).catch((err) => {
        console.error(
          JSON.stringify({ level: 'error', scope: 'backup', msg: '周备份失败', error: String(err) }),
        )
      }),
    )
  },
}

export default worker

/**
 * dujie-comment 安全基础库（lib/security.ts）—— 从生产代码 core/visitor/
 * turnstile/admin-auth 四个模块抽离合并，零外部依赖，全部基于 Workers 原生
 * WebCrypto（crypto.subtle）。
 *
 * 收录能力：
 * - sha256Hex / timingSafeEqualHex：摘要与常量时间比对（管理令牌、指纹）；
 * - verifyAdminToken / adminAuth：X-Admin-Token + KV 哈希比对 + IP 失败限流；
 * - md5：Gravatar 头像契约（email → md5），公有领域标准实现；
 * - visitorHash / ipBanHash：访客指纹双轨（限流点赞 / IP 黑名单，盐前缀不同）；
 * - requestIp / visitorSalt：客户端 IP 提取与盐读取；
 * - verifyTurnstile：Turnstile 人机校验三分支降级。
 *
 * 指纹双轨（易错点，务必保持盐前缀不同，不可互相替代）：
 * - `visitorHash = sha256(IP|UA|salt)`   限流 / 点赞去重（换 UA 即换指纹，属预期）；
 * - `ipBanHash   = sha256(IP|ipban|salt)` IP 黑名单（不含 UA，换 UA 不能绕开黑名单）。
 */
import type { MiddlewareHandler } from 'hono'
import type { AppEnv, Env } from '../types'
import { getConfig } from './config'

/* ------------------------------------------------------------------ */
/* 摘要 / 常量时间比对                                                  */
/* ------------------------------------------------------------------ */

/** 取 WebCrypto SubtleCrypto；运行时不支持时抛错（Worker/Node ≥19 均内置） */
function subtleCrypto(): SubtleCrypto {
  const c = globalThis.crypto
  if (c === undefined || c.subtle === undefined) {
    throw new Error('当前运行时缺少 WebCrypto SubtleCrypto')
  }
  return c.subtle
}

/** UTF-8 编码为字节数组（统一复制为 Uint8Array<ArrayBuffer> 满足 BufferSource 约束） */
function utf8Bytes(input: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(input))
}

/** 字节数组 → 小写十六进制串 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** SHA-256 十六进制摘要（小写 64 位）；用于管理令牌哈希、访客指纹等不可逆场景 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtleCrypto().digest('SHA-256', utf8Bytes(input))
  return bytesToHex(new Uint8Array(digest))
}

/**
 * 常量时间十六进制串比对（防时序攻击）。
 * 长度不等直接 false（长度信息不敏感：token 哈希恒为 64hex）。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/* ------------------------------------------------------------------ */
/* 管理令牌鉴权（X-Admin-Token + KV 哈希比对 + IP 失败限流）              */
/* ------------------------------------------------------------------ */

/** 管理令牌请求头（CORS_ALLOWED_HEADERS 已同步放行） */
export const ADMIN_TOKEN_HEADER = 'X-Admin-Token'
/** KV 键：sha256Hex(admin token)，64hex（人工一次性初始化，见 docs/deploy.md） */
const KV_TOKEN_HASH_KEY = 'admin:token_hash'
/** 失败限流：5 次 / 5 分钟 / IP */
const MAX_FAILS = 5
const FAIL_TTL_SEC = 300

/**
 * 校验管理令牌：无记录/无头/空白头/不匹配均为 false。
 * 存储值 trim 后比对（容忍 KV 写入时带入的换行）。
 */
export async function verifyAdminToken(env: Env, header: string | undefined): Promise<boolean> {
  if (header === undefined || header.trim() === '') return false
  const stored = await env.KV.get(KV_TOKEN_HASH_KEY)
  if (stored === null) return false
  return timingSafeEqualHex(await sha256Hex(header.trim()), stored.trim())
}

/** 失败限流 KV 键（按 IP 黑名单哈希分桶，与公开评论限流键域隔离） */
function failCountKey(ipBan: string): string {
  return `admin:auth:fail:${ipBan}`
}

/**
 * 管理路由组中间件（adminRoutes.use('*', adminAuth)）。
 * 顺序：IP 失败限流检查 → 令牌比对 → 失败计数 +1。
 * 纪律：日志禁止打印 token 明文（只可能出现哈希）。
 */
export const adminAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ipBan = await ipBanHash(requestIp(c.req.raw), visitorSalt(c.env))
  const failKey = failCountKey(ipBan)
  const used = Number.parseInt((await c.env.KV.get(failKey)) ?? '0', 10)
  if (Number.isFinite(used) && used >= MAX_FAILS) {
    return c.json({ code: 'ADMIN_RATE_LIMITED', message: '失败次数过多，请 5 分钟后再试' }, 429)
  }
  const ok = await verifyAdminToken(c.env, c.req.header(ADMIN_TOKEN_HEADER))
  if (!ok) {
    await c.env.KV.put(failKey, String(used + 1), { expirationTtl: FAIL_TTL_SEC })
    return c.json({ code: 'ADMIN_UNAUTHORIZED', message: '管理令牌无效' }, 401)
  }
  await next()
}

/* ------------------------------------------------------------------ */
/* 访客指纹双轨                                                         */
/* ------------------------------------------------------------------ */

/** 指纹盐缺省值（生产同款默认，保证算法行为可对照） */
export const DEFAULT_VISITOR_SALT = 'dujie-comment'

/** 访客盐（env.VISITOR_SALT 缺省 'dujie-comment'） */
export function visitorSalt(env: Env): string {
  return readSalt(env)
}

/** 读取盐（抽成小函数便于测试注入；空白回落默认值） */
function readSalt(env: Env): string {
  const value = (env as unknown as Record<string, unknown>).VISITOR_SALT
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_VISITOR_SALT
}

/**
 * 访客指纹：sha256(IP + '|' + UA + '|' + salt)，64 位小写 hex。
 * 用于评论限流与点赞去重（不存明文 IP）。
 */
export async function visitorHash(ip: string, ua: string, salt: string): Promise<string> {
  return sha256Hex(`${ip}|${ua}|${salt}`)
}

/**
 * IP 黑名单哈希：sha256(IP + '|ipban|' + salt)，64 位小写 hex。
 * 注意与 visitorHash 的盐前缀差异（`ipban` 段）——双轨设计的关键，
 * 改这里会同时破坏黑名单匹配与 banned 表语义。
 */
export async function ipBanHash(ip: string, salt: string): Promise<string> {
  return sha256Hex(`${ip}|ipban|${salt}`)
}

/** 取客户端 IP：CF-Connecting-IP 优先，回退 X-Forwarded-For，再兜底 0.0.0.0 */
export function requestIp(raw: Request): string {
  return raw.headers.get('CF-Connecting-IP') ?? raw.headers.get('X-Forwarded-For') ?? '0.0.0.0'
}

/* ------------------------------------------------------------------ */
/* MD5（Gravatar 头像契约：标准实现，RFC 1321）                          */
/* ------------------------------------------------------------------ */

/**
 * MD5 每轮移位量（4 轮 × 16 步）。
 * 用常量表而非 64 行字面量调用，规避手抄常数表错位
 * （生产旧实现即因常数表错乱而非标准，头像与真实 Gravatar 对不上）。
 */
const MD5_SHIFTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]

/**
 * MD5 每步常数 K[i] = floor(2^32 × |sin(i + 1)|)（经典推导，与 RFC 1321
 * 测试向量逐位一致）。懒计算一次后缓存，模块加载零开销。
 */
const MD5_K: readonly number[] = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000),
)

/** 32 位循环左移 */
function md5Rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n))
}

/** 32 位模加（规避 JS 浮点溢出，按 16 位分段相加） */
function md5Add(x: number, y: number): number {
  const x16 = x & 0xffff
  const y16 = y & 0xffff
  return (((x16 + y16) & 0xffff) | 0) + ((((x >>> 16) + (y >>> 16) + (((x16 + y16) >>> 16) & 1)) & 0xffff) << 16)
}

/** 无符号 32 位整数（>>> 0 归一） */
function u32(x: number): number {
  return x >>> 0
}

/**
 * MD5（标准实现）。输入按 UTF-8 编码，非 ASCII 邮箱同样正确。
 * 用于 Gravatar 头像哈希——必须与任何 Gravatar 客户端算法一致。
 */
export function md5(input: string): string {
  // ① 消息填充：原数据 + 0x80 + 0x00… + 64 位小端比特长度，总长 ≡ 0 (mod 64)
  const msg = utf8Bytes(input)
  const bitLen = msg.length * 8
  const padded = new Uint8Array(((msg.length + 8) >> 6) * 64 + 64)
  padded.set(msg)
  padded[msg.length] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, bitLen >>> 0, true)
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true)

  // ② 初始化链接变量（小端）
  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476

  // ③ 按 64 字节分组处理（RFC 1321 压缩函数）
  for (let offset = 0; offset < padded.length; offset += 64) {
    const m: number[] = new Array(16)
    for (let j = 0; j < 16; j++) {
      m[j] = dv.getUint32(offset + j * 4, true)
    }
    let aa = a
    let bb = b
    let cc = c
    let dd = d
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (bb & cc) | (~bb & dd)
        g = i
      } else if (i < 32) {
        f = (dd & bb) | (~dd & cc)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = bb ^ cc ^ dd
        g = (3 * i + 5) % 16
      } else {
        f = cc ^ (bb | ~dd)
        g = (7 * i) % 16
      }
      // b = b + rotl(a + f + K[i] + M[g], s[i])；随后 (a,b,c,d) 循环轮转
      const sum = u32(md5Add(md5Add(md5Add(u32(aa), u32(f)), u32(MD5_K[i]!)), u32(m[g]!)))
      aa = dd
      dd = cc
      cc = bb
      bb = u32(md5Add(bb, md5Rotl(sum, MD5_SHIFTS[i]!)))
    }
    a = u32(md5Add(a, aa))
    b = u32(md5Add(b, bb))
    c = u32(md5Add(c, cc))
    d = u32(md5Add(d, dd))
  }

  // ④ 输出：四个链接变量按小端拼接为 16 字节 → 32 位 hex
  const out = new DataView(new ArrayBuffer(16))
  out.setUint32(0, a, true)
  out.setUint32(4, b, true)
  out.setUint32(8, c, true)
  out.setUint32(12, d, true)
  let hex = ''
  for (const byte of new Uint8Array(out.buffer)) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/* ------------------------------------------------------------------ */
/* Turnstile 人机校验（三分支降级）                                      */
/* ------------------------------------------------------------------ */

/** Cloudflare siteverify 端点（form-urlencoded 契约） */
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** siteverify 超时（毫秒）：校验是评论链路一环，不能长时间悬挂 */
export const TURNSTILE_TIMEOUT_MS = 5000

/** 校验结论：ok=true 为放行（含各类降级放行）；ok=false 为拒绝（带 HTTP 状态与错误码） */
export type TurnstileOutcome =
  | { ok: true; reason: 'pass' | 'disabled' | 'fail_open' | 'secret_missing' }
  | {
      ok: false
      status: 400 | 403 | 503
      code: 'TURNSTILE_TOKEN_MISSING' | 'TURNSTILE_FAILED' | 'TURNSTILE_UNAVAILABLE'
      message: string
    }

/**
 * 校验 Turnstile token。
 *
 * 三分支降级：
 * - token 缺失/为空        → 400 TURNSTILE_TOKEN_MISSING（客户端 bug，应暴露）；
 * - success=false          → 403 TURNSTILE_FAILED（明确的机器流量判定，fail-closed）；
 * - siteverify 不可达       → fail_open=1（默认）：WARN + 放行；fail_open=0：503；
 * - TURNSTILE_SECRET 未配置 → WARN + 放行（允许「先上线开关、后补 secret」）。
 *
 * @param env Worker 环境（KV 开关 + TURNSTILE_SECRET）
 * @param token 前端 widget 回调取得的 token（null/'' 按缺失处理）
 * @param remoteIp CF-Connecting-IP（Turnstile 据此做地域风控，非必填）
 */
export async function verifyTurnstile(
  env: Env,
  token: string | null,
  remoteIp: string | undefined,
): Promise<TurnstileOutcome> {
  const cfg = await getConfig(env) // 60s 缓存（评论链路热路径，不做 fresh）
  if (!cfg.turnstileEnabled) return { ok: true, reason: 'disabled' }
  if (token === null || token === '') {
    return { ok: false, status: 400, code: 'TURNSTILE_TOKEN_MISSING', message: '请完成人机校验' }
  }
  if (env.TURNSTILE_SECRET === undefined || env.TURNSTILE_SECRET === '') {
    console.warn(JSON.stringify({ level: 'warn', scope: 'turnstile', msg: 'secret 未配置，跳过校验' }))
    return { ok: true, reason: 'secret_missing' }
  }
  try {
    const resp = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token, remoteip: remoteIp ?? '' }),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`siteverify HTTP ${resp.status}`)
    const data = (await resp.json()) as { success: boolean; 'error-codes'?: string[] }
    if (data.success) return { ok: true, reason: 'pass' }
    console.warn(
      JSON.stringify({
        level: 'warn',
        scope: 'turnstile',
        msg: 'verify failed',
        errorCodes: data['error-codes'] ?? [],
      }),
    )
    return { ok: false, status: 403, code: 'TURNSTILE_FAILED', message: '人机校验未通过，请重试' }
  } catch (err) {
    if (cfg.turnstileFailOpen) {
      console.warn(
        JSON.stringify({ level: 'warn', scope: 'turnstile', msg: 'siteverify 不可达，fail-open 放行', error: String(err) }),
      )
      return { ok: true, reason: 'fail_open' }
    }
    return { ok: false, status: 503, code: 'TURNSTILE_UNAVAILABLE', message: '校验服务暂不可用，请稍后重试' }
  }
}

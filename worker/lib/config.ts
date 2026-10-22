/**
 * dujie-comment 配置中心（lib/config.ts）—— 灰度开关唯一数据源。
 *
 * 数据流：前端 `GET /api/config`（fresh 读）→ 本模块（KV 读 + 单 isolate
 * 内存缓存 60s）→ `cfg:*` KV 键。管理操作/开关切换最长 60s 全网生效；
 * config 端点与 admin stats 为 fresh 读，可见即时值。
 *
 * 降级：KV 异常时按默认值降级并打 WARN 日志，绝不向上抛
 * （配置读失败不应影响评论主流程）。
 */
import type { Env } from '../types'

/** KV 开关键（前缀即域，共享约定：冲突即 bug） */
export const CONFIG_KEYS = {
  turnstileEnabled: 'cfg:turnstile_enabled',
  turnstileSiteKey: 'cfg:turnstile_site_key',
  turnstileFailOpen: 'cfg:turnstile_fail_open',
  moderationEnabled: 'cfg:moderation_enabled',
  notifyEnabled: 'cfg:notify_enabled',
} as const

/** 单 isolate 内存缓存 TTL（毫秒）：KV 最终一致，60s 收敛 */
const CONFIG_CACHE_TTL_MS = 60_000

/** 运行期配置（getConfig 返回值） */
export interface CommentConfig {
  /** Turnstile 校验与前端 widget 渲染总开关（默认 false） */
  turnstileEnabled: boolean
  /** Turnstile 站点密钥（KV 优先，回退 wrangler var TURNSTILE_SITE_KEY） */
  turnstileSiteKey: string
  /** Turnstile 服务不可达时放行（默认 true） */
  turnstileFailOpen: boolean
  /** 审核队列开关：开启后访客提交进 pending（默认 false） */
  moderationEnabled: boolean
  /** 回复邮件通知总闸（默认 true） */
  notifyEnabled: boolean
}

interface CacheEntry {
  config: CommentConfig
  at: number
}

/** 模块级缓存：Worker 单 isolate 内共享 */
let cache: CacheEntry | null = null

/**
 * 读取 [vars] 字符串配置（wrangler.toml；Env 绑定类型已声明为可选 string，
 * 缺省/空白回落 fallback）。
 */
export function readEnvString(env: Env, key: string, fallback: string): string {
  const bag = env as unknown as Record<string, unknown>
  const value = bag[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/** KV 单键读取（异常降级为 null + WARN，不抛出） */
async function kvGet(env: Env, key: string): Promise<string | null> {
  try {
    return await env.KV.get(key)
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', scope: 'config', msg: 'KV 读取失败，按默认值降级', key, error: String(err) }),
    )
    return null
  }
}

/** KV 开关值解析：'1' 为真，其余（含缺失）按默认值 */
function flagOf(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback
  return raw.trim() === '1'
}

/** 并发读全部开关键（单次 isolate 缓存内只发 5 个 KV 读） */
async function loadConfig(env: Env): Promise<CommentConfig> {
  const [turnstileEnabledRaw, siteKeyRaw, failOpenRaw, moderationRaw, notifyRaw] = await Promise.all([
    kvGet(env, CONFIG_KEYS.turnstileEnabled),
    kvGet(env, CONFIG_KEYS.turnstileSiteKey),
    kvGet(env, CONFIG_KEYS.turnstileFailOpen),
    kvGet(env, CONFIG_KEYS.moderationEnabled),
    kvGet(env, CONFIG_KEYS.notifyEnabled),
  ])
  return {
    turnstileEnabled: flagOf(turnstileEnabledRaw, false),
    // 站点密钥：KV 优先（免部署轮换），回退 var（可入 git 的公开值）
    turnstileSiteKey:
      siteKeyRaw !== null && siteKeyRaw.trim() !== ''
        ? siteKeyRaw.trim()
        : readEnvString(env, 'TURNSTILE_SITE_KEY', ''),
    turnstileFailOpen: flagOf(failOpenRaw, true),
    moderationEnabled: flagOf(moderationRaw, false),
    notifyEnabled: flagOf(notifyRaw, true),
  }
}

/**
 * 读取运行期配置（60s 内存缓存；`{ fresh: true }` 绕过缓存直读 KV）。
 *
 * @param env Worker 环境（KV 绑定）
 * @param opts.fresh 管理页/config 端点传 true，保证看到即时开关值
 */
export async function getConfig(env: Env, opts: { fresh?: boolean } = {}): Promise<CommentConfig> {
  const now = Date.now()
  if (opts.fresh !== true && cache !== null && now - cache.at < CONFIG_CACHE_TTL_MS) {
    return cache.config
  }
  const config = await loadConfig(env)
  cache = { config, at: now }
  return config
}

/** 失效内存缓存（KV 写入后如需立即生效可调用；预留备用） */
export function invalidateConfig(): void {
  cache = null
}

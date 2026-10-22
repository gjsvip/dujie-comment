/**
 * dujie-comment 周备份（routes/backup.ts）—— cron 周一 02:00 UTC
 * （北京时间周一 10:00）全量导出 comments + says 到 R2。
 *
 * 保留策略：常量 BACKUP_KEEP = 12（≈3 个月，每周一份）；R2 key 字典序即
 * 时间序（ISO 日期），倒序后删除第 13 个及更旧。
 *
 * 失败处理：异常向上抛到 scheduled handler（index.ts try/catch + console.error），
 * 本周失败不重试，下周一自然重跑。
 */
import type { Env } from '../types'

/** R2 Key 前缀 */
export const R2_BACKUP_PREFIX = 'backups/'
/** 保留份数（≈3 个月） */
export const BACKUP_KEEP = 12
/** KV 状态标记键（admin stats 的 lastBackupAt 数据源） */
export const BACKUP_LAST_KEY = 'backup:last'
/** R2 list 单次拉取上限（保留策略只需最近 BACKUP_KEEP+1 个，100 足够） */
const BACKUP_LIST_LIMIT = 100

/** 备份摘要（scheduled 日志与返回值） */
export interface BackupSummary {
  key: string
  deleted: string[]
  comments: number
  says: number
}

/**
 * 执行一次周备份（由 index.ts scheduled handler 经 waitUntil 调用）。
 *
 * 数据范围：comments + says 全量（含 pending/hidden——备份用于恢复，
 * 不做状态过滤）。成功后写 KV `backup:last`。
 */
export async function runWeeklyBackup(env: Env): Promise<BackupSummary> {
  const comments = await env.DB.prepare('SELECT * FROM comments ORDER BY id').all()
  const says = await env.DB.prepare('SELECT * FROM says ORDER BY id').all()
  const date = new Date().toISOString().slice(0, 10) // UTC 日期
  const key = `${R2_BACKUP_PREFIX}${date}.json`
  const commentRows = comments.results ?? []
  const sayRows = says.results ?? []
  const counts = { comments: commentRows.length, says: sayRows.length }
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      tables: { comments: commentRows, says: sayRows },
      counts,
    },
    null,
    2,
  )
  await env.R2.put(key, payload, { httpMetadata: { contentType: 'application/json' } })

  // 保留策略：字典序（ISO 日期即时间序）倒序，删第 13 个及更旧
  const listed = await env.R2.list({ prefix: R2_BACKUP_PREFIX, limit: BACKUP_LIST_LIMIT })
  const stale = (listed.objects ?? []).map((o) => o.key).sort().reverse().slice(BACKUP_KEEP)
  for (const k of stale) {
    await env.R2.delete(k)
  }

  // 状态标记（admin stats 展示 lastBackupAt）
  await env.KV.put(BACKUP_LAST_KEY, JSON.stringify({ key, at: new Date().toISOString(), ...counts }))
  console.log(
    JSON.stringify({ level: 'info', scope: 'backup', msg: '周备份完成', key, ...counts, deleted: stale.length }),
  )
  return { key, deleted: stale, ...counts }
}

#!/usr/bin/env node
/**
 * GitHub 推送（scripts/push-to-github.mjs）—— 经 Git Data API
 * （blob → tree → commit → ref）把仓库推送到 gjsvip/dujie-comment。
 *
 * 为什么不用 git push：沙箱到 github.com 的 git 协议不稳定；
 * 本通道走 HTTPS REST API，确定可达。
 *
 * 用法：GH_TOKEN=<token> node scripts/push-to-github.mjs
 * 行为：仓库不存在则创建（公开 MIT）；已存在则基于 main 最新 ref 追加提交（幂等可重跑）。
 * 忽略：node_modules / .git / .wrangler / dist / .DS_Store。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const TOKEN = process.env.GH_TOKEN
const OWNER = 'gjsvip'
const REPO = 'dujie-comment'
const ROOT = new URL('..', import.meta.url).pathname
const IGNORE_DIRS = new Set(['node_modules', '.git', '.wrangler', 'dist'])
const IGNORE_FILES = new Set(['.DS_Store'])

if (!TOKEN) {
  console.error('缺少环境变量 GH_TOKEN')
  process.exit(1)
}

/** GitHub REST 调用（统一注入认证头） */
async function gh(path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })
}

/** 递归收集待推送文件（跳过忽略目录；.github 等点目录保留） */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      out.push(...(await walk(full)))
    } else if (!IGNORE_FILES.has(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function fail(message, extra) {
  console.error(message)
  if (extra) console.error(extra)
  process.exit(1)
}

// 1. 确保仓库存在（公开）
const repoRes = await gh(`/repos/${OWNER}/${REPO}`)
if (repoRes.status === 404) {
  const created = await gh('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO,
      private: false,
      description:
        'dujie-comment（渡劫评论）—— Cloudflare Workers + D1 零成本评论系统：fork → wrangler deploy 两条命令上线，自带管理后台与嵌入组件',
      has_issues: true,
      has_wiki: false,
      license_template: 'mit',
    }),
  })
  if (!created.ok) fail('创建仓库失败', `${created.status} ${await created.text()}`)
  console.log(`仓库已创建: ${OWNER}/${REPO} (public, MIT)`)
} else if (!repoRes.ok) {
  fail('读取仓库失败', `${repoRes.status} ${await repoRes.text()}`)
}

// 2. 文件 → blobs（base64，文本/二进制通吃）
const files = await walk(ROOT)
const tree = []
for (const file of files) {
  const path = relative(ROOT, file)
  const content = await readFile(file)
  const blobRes = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  if (!blobRes.ok) fail(`blob 失败: ${path}`, `${blobRes.status} ${await blobRes.text()}`)
  const { sha } = await blobRes.json()
  tree.push({ path, mode: '100644', type: 'blob', sha })
  console.log('blob', path)
}

// 3. tree
const treeRes = await gh(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree }),
})
if (!treeRes.ok) fail('tree 失败', `${treeRes.status} ${await treeRes.text()}`)
const treeSha = (await treeRes.json()).sha

// 4. 现有 main ref（决定 commit 的 parent）
const refRes = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/main`)
let parentSha
if (refRes.ok) {
  parentSha = (await refRes.json()).object.sha
} else if (refRes.status !== 404) {
  fail('ref 读取失败', `${refRes.status} ${await refRes.text()}`)
}

// 5. commit
const commitBody = {
  message:
    'dujie-comment v1.0：Workers + D1 零成本评论系统（Hono，自带后台/嵌入组件/周备份/隐私隔离）',
  tree: treeSha,
}
if (parentSha) commitBody.parents = [parentSha]
const commitRes = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  body: JSON.stringify(commitBody),
})
if (!commitRes.ok) fail('commit 失败', `${commitRes.status} ${await commitRes.text()}`)
const commitSha = (await commitRes.json()).sha

// 6. 创建 / 更新 ref（force 容忍历史分叉）
if (parentSha) {
  const patched = await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitSha, force: true }),
  })
  if (!patched.ok) fail('ref 更新失败', `${patched.status} ${await patched.text()}`)
} else {
  const createdRef = await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commitSha }),
  })
  if (!createdRef.ok) fail('ref 创建失败', `${createdRef.status} ${await createdRef.text()}`)
}

console.log(`推送完成: https://github.com/${OWNER}/${REPO} (commit ${commitSha.slice(0, 7)})`)

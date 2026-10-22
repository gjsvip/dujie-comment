/**
 * 静态资源托管（routes/static.ts）—— 让 Worker 直接托管自带前端文件，
 * 部署后无需再找静态 hosting：`<script src="https://<worker>/client/dujie-comment.js">`
 * 即用，管理后台与演示页开箱可达。
 *
 * 实现方式（零构建、零额外绑定）：
 * 通过 wrangler.toml 的 `[[rules]] type = "Text"`（官方文本模块机制）把
 * client/admin/demo 的源文件作为字符串内联进 bundle——
 * 仓库里这些源文件就是唯一事实来源，无同步步骤、无重复拷贝。
 * 类型声明见 worker/raw.d.ts（ ambient wildcard modules ）。
 */
import { Hono } from 'hono'
import clientJs from '../../client/dujie-comment.js'
import clientCss from '../../client/dujie-comment.css'
import adminHtml from '../../admin/index.html'
import demoHtml from '../../demo/index.html'

const staticRoutes = new Hono()

/** 嵌入组件 JS（公开，可被任意页面 <script src> 引用） */
staticRoutes.get('/client/dujie-comment.js', (c) => {
  c.header('Cache-Control', 'public, max-age=600')
  return c.text(clientJs)
})

/** 嵌入组件 CSS（暗/亮双主题，CSS 变量驱动） */
staticRoutes.get('/client/dujie-comment.css', (c) => {
  c.header('Cache-Control', 'public, max-age=600')
  return c.text(clientCss)
})

/** 管理后台（token 模式，API base 页面顶部可改） */
staticRoutes.get('/admin', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.html(adminHtml)
})

/** 在线演示页（挂载嵌入组件，数据来自演示 D1） */
staticRoutes.get('/demo', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.html(demoHtml)
})

export default staticRoutes

/**
 * 文本模块导入的类型声明（wrangler `[[rules]] type = "Text"` 机制）。
 *
 * worker/routes/static.ts 以 `import x from '../../client/dujie-comment.js'`
 * 这类相对路径导入源文件，wrangler 打包时把文件文本作为默认导出字符串内联。
 * TypeScript 不理解该机制，在此用通配符 ambient module 声明兜底
 * （相对路径解析失败时命中通配符模式）。
 */
declare module '*.html' {
  const content: string
  export default content
}

declare module '*dujie-comment.js' {
  const content: string
  export default content
}

declare module '*dujie-comment.css' {
  const content: string
  export default content
}

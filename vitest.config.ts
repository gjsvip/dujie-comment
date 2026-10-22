import { defineConfig } from 'vitest/config'

/**
 * Vitest 配置：只跑 tests/ 下的单测（node 环境，全部 mock KV/D1/R2/fetch，不触网）。
 * 注意 tests 不 import worker/index.ts——入口含 `?raw` 静态资源导入，
 * 单测只需覆盖 lib/ 与 routes/ 的纯逻辑。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})

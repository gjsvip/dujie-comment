# 部署指南：fork → 三条命令 → 上线

本指南面向从零开始的陌生用户。全程约 10 分钟，除域名外零费用。

## 0. 前置条件

- 一个 Cloudflare 账号（免费计划即可）
- 本地有 Node.js ≥ 18 与 npm

## 1. Fork 本仓库

点击 GitHub 右上角 **Fork**，然后克隆到本地：

```bash
git clone https://github.com/<你的用户名>/dujie-comment.git
cd dujie-comment
npm install
```

## 2. 创建三样 Cloudflare 资源

在仓库目录下依次执行（wrangler 会打印资源 ID，稍后要抄进 `wrangler.toml`）：

```bash
# ① D1 数据库（评论数据）
npx wrangler d1 create dujie-comment-db

# ② KV 命名空间（配置开关 / 限流计数 / 管理令牌哈希 / 备份状态）
npx wrangler kv namespace create dujie-comment-kv

# ③ R2 存储桶（周备份）
npx wrangler r2 bucket create dujie-comment-backup
```

## 3. 修改 wrangler.toml

把执行结果抄进配置（同时把 `account_id` 改成你的：CF 官网 → Workers & Pages 右侧可见）：

```toml
account_id = "你的 CF 账号 ID"

[[d1_databases]]
binding = "DB"
database_name = "dujie-comment-db"
database_id = "第①步拿到的 uuid"
# 以下 preview_* 是 `wrangler dev` 本地调试的必需项（缺了 dev 启动即报错）。
# 简单起见可指向同一份资源（dev 直接操作真实数据）；
# 讲究隔离可另建预览资源：wrangler kv namespace create <name> --preview
preview_database_id = "第①步拿到的 uuid"

[[kv_namespaces]]
binding = "KV"
id = "第②步拿到的 id"
preview_id = "第②步拿到的 id"

[[r2_buckets]]
binding = "R2"
bucket_name = "dujie-comment-backup"
preview_bucket_name = "dujie-comment-backup"

[vars]
# 改成你将要嵌入选区的站点域名（逗号分隔可多个；localhost 恒允许调试）
CORS_ORIGINS = "https://your-blog.example.com"
SITE_NAME = "你的站点名"
```

## 4. 初始化数据库

```bash
npx wrangler d1 execute DB --file=schema.sql --remote
```

## 5. 设置管理令牌

生成一个随机令牌并计算其 SHA-256（只存哈希，不明文落库）：

```bash
# 生成令牌（自己保存好明文，后台登录用）
TOKEN=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
echo "你的管理令牌: $TOKEN"

# 计算 SHA-256 并写入 KV
HASH=$(printf '%s' "$TOKEN" | sha256sum | awk '{print $1}')
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<account_id>/storage/kv/namespaces/<kv_id>/values/admin:token_hash" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  -H "Content-Type: text/plain" \
  --data "$HASH"
```

> `CF_API_TOKEN` 在 CF 官网 → My Profile → API Tokens 创建，
> 需要 **Workers KV Storage:Edit** 权限（D1 初始化同理可用 REST API，
> 见 schema.sql 顶部注释）。

## 6. 部署

```bash
npx wrangler deploy
```

部署成功后你会得到 `https://dujie-comment.<你的子域>.workers.dev`。
该 Worker 同时托管三样东西，开箱即用：

| 路径 | 内容 |
| --- | --- |
| `/api/*` | 评论 API（契约见 [docs/api.md](api.md)） |
| `/admin` | 评论管理后台（token 模式，API 地址页面顶部可改） |
| `/client/dujie-comment.js` + `.css` | 嵌入组件 |
| `/demo` | 在线演示页 |

## 7. 嵌入你的站点（两行代码）

在文章模板的 `</body>` 前加入：

```html
<link rel="stylesheet" href="https://dujie-comment.<你的子域>.workers.dev/client/dujie-comment.css">
<div data-dujie-comment
     data-api="https://dujie-comment.<你的子域>.workers.dev"
     data-slug="文章唯一标识"
     data-author="博主昵称1,博主昵称2"
     data-post-stats="1"></div>
<script src="https://dujie-comment.<你的子域>.workers.dev/client/dujie-comment.js" defer></script>
```

- `data-slug` 可省略：组件会自动从 URL（`?slug=` 或 `/posts/xxx` 路径）推导；
- `data-author`：命中的昵称在评论旁显示「博主」徽章；
- `data-post-stats="1"`：额外显示文章浏览/点赞芯片并自动 +1 浏览；
- 主题：组件默认暗色，跟随系统偏好亮色；宿主页 `<html data-theme="light">` 可强制亮色。

## 8. 可选配置

| 能力 | 配置方式 | 说明 |
| --- | --- | --- |
| Turnstile 人机校验 | `wrangler secret put TURNSTILE_SECRET` + `wrangler.toml` 填 `TURNSTILE_SITE_KEY` | 然后在 KV 置 `cfg:turnstile_enabled=1` 开生效 |
| 回复邮件通知 | `wrangler secret put RESEND_API_KEY`（[Resend](https://resend.com) 免费 3000 封/月） | 缺省不发信，评论不受影响 |
| 审核队列 | KV `cfg:moderation_enabled=1` | 开启后访客评论进 pending，后台审核后展示 |
| 指纹盐 | `wrangler.toml` `VISITOR_SALT` | 仅新部署时设置；改动会使历史限流/点赞指纹失效 |
| 自定义域名 | `wrangler.toml` 加 `routes = [{ pattern = "comment.your-domain.com/*" }]` | 需要令牌含 DNS 编辑权 |

KV 开关一键设置示例（开审核队列）：

```bash
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/<account_id>/storage/kv/namespaces/<kv_id>/values/cfg:moderation_enabled" \
  -H "Authorization: Bearer <CF_API_TOKEN>" \
  --data "1"
```

## 9. 日常运维

- **管理后台**：打开 `https://<你的 worker>/admin`，输入第 5 步的令牌；
- **周备份**：cron 每周一 02:00 UTC 自动导出全量到 R2（保留 12 份），后台首页可见上次备份时间；
- **本地调试**：`npx wrangler dev`（localhost 来源恒允许跨域）；
- **跑测试**：`npm test`（Vitest，全 mock 不触网）。

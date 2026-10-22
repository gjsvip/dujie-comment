# API 契约

Base URL：`https://<your-worker>.workers.dev`。所有响应为 JSON，
统一信封：成功 `{ "code": 0, "data": ... }`；失败 `{ "code": "<错误码>", "message": "人类可读信息" }`（HTTP 状态码见各端点）。

管理端点为 `/api/admin/*`，全部需要请求头 `X-Admin-Token: <你的管理令牌>`。

---

## 公开端点

### GET /api/config

前端灰度开关唯一数据源（fresh 读 KV）。页面加载时调用一次即可。

```json
{
  "code": 0,
  "data": {
    "turnstile": { "enabled": false, "siteKey": "", "failOpen": true },
    "moderation": { "enabled": false },
    "notify": { "enabled": true }
  }
}
```

### GET /api/comments?slug=\<slug\>

返回指定文章的**已审核**评论树（`status='approved'`）。

```json
{
  "code": 0,
  "data": {
    "comments": [
      {
        "id": 1,
        "parentId": null,
        "nickname": "访客",
        "avatar": "https://gravatar.com/avatar/<md5>?d=identicon&s=80",
        "website": "",
        "content": "评论内容",
        "createdAt": "2026-10-22 10:00:00",
        "likes": 3,
        "replies": [
          { "id": 2, "parentId": 1, "nickname": "另一人", "replies": [] }
        ]
      }
    ],
    "total": 2
  }
}
```

### POST /api/comments

发表评论 / 回复。同指纹限流 **2 条/分钟**（超限 429 `RATE_LIMITED`）。

请求体：

| 字段 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `slug` | string | 是 | 1-100 字符，文章标识 |
| `nickname` | string | 是 | 1-20 字符 |
| `email` | string | 否 | 格式合法；仅用于通知与 Gravatar，**不返回前端** |
| `website` | string | 否 | http(s) 链接，≤200 字符 |
| `content` | string | 是 | 1-500 字符 |
| `parentId` | number | 否 | 回复目标；必须指向**同文章已审核**评论 |
| `turnstileToken` | string | 条件 | Turnstile 开关开启时必填 |

```json
{ "slug": "my-post", "nickname": "访客", "email": "a@b.com", "content": "写得好", "parentId": null }
```

成功 `201`：

```json
{ "code": 0, "data": { "id": 12, "status": "approved" } }
```

`status` 为 `approved`（直接展示）或 `pending`（开了审核队列，待博主审核）。

**链路顺序（顺序即防线）**：字段校验 → 博主身份（X-Admin-Token 可选）→ 限流 → Turnstile → 黑名单 → 父评论校验 → 审核状态 → 写入 → 回复通知（异步）。

### POST /api/like

文章 / 评论点赞 toggle（同指纹重复调用 = 取消）。请求体三选一形态：

```json
{ "slug": "my-post" }              // 文章点赞
{ "comment_id": 12 }               // 评论点赞
{ "type": "comment", "id": "12" }  // 兼容形态
```

```json
{ "code": 0, "data": { "liked": true, "count": 4, "likes": 4 } }
```

### POST /api/view

文章浏览量 +1：`{ "slug": "my-post" }` → `{ "code": 0, "data": { "views": 42 } }`

### GET /api/stats?slugs=a,b,c

批量统计（≤50 个 slug），返回数组：

```json
{ "code": 0, "data": [{ "slug": "a", "views": 42, "likes": 4, "comments": 2 }] }
```

### GET /api/says

说说列表（已审核，≤50 条）：`{ "code": 0, "data": [{ "id": 1, "content": "...", "images": [], "createdAt": "..." }] }`

---

## 管理端点（X-Admin-Token）

失败限流：同 IP 连续 5 次失败 → 429 `ADMIN_RATE_LIMITED`（5 分钟锁）。

### GET /api/admin/comments

评论列表。查询参数：`page`（默认 1）、`page_size`（1-100，默认 20）、
`slug`、`status`（approved/pending/hidden）、`q`（昵称/内容模糊搜索）。

### POST /api/admin/comments/:id/approve

审核通过（幂等）。被审核项是回复时异步通知父评论作者，响应 `notified` 标识。

### POST /api/admin/comments/:id/hide

软删除，公开面立即不可见（幂等）。

### DELETE /api/admin/comments/:id

硬删除；其下**回复提升为根评论**（不级联删枝），返回 `childrenPromoted`。

### POST /api/admin/comments/:id/ban

拉黑。请求体 `{ "scope": "email|ip|both", "reason": "可选原因" }`（幂等，INSERT OR IGNORE）。
拉黑不自动隐藏该评论。

### GET /api/admin/bans

黑名单列表（分页同 comments）。`banValueMasked` 为脱敏值（前 8 位）。

### DELETE /api/admin/bans/:id

解除拉黑。

### GET /api/admin/stats

管理驾驶舱：

```json
{ "code": 0, "data": { "approved": 10, "pending": 1, "hidden": 2, "bans": 0, "lastBackupAt": "2026-10-20T02:00:00.000Z" } }
```

---

## 错误码表

| 错误码 | HTTP | 场景 |
| --- | --- | --- |
| `BAD_JSON` | 400 | 请求体不是合法 JSON |
| `BAD_SLUG` / `BAD_NICKNAME` / `BAD_EMAIL` / `BAD_WEBSITE` / `BAD_CONTENT` | 400 | 字段校验失败 |
| `BAD_TARGET` | 400 | 点赞目标不合法或评论不存在 |
| `BAD_PARENT` | 400 | 回复目标不存在或未审核 |
| `BAD_PAGE` / `BAD_ID` / `BAD_STATUS` / `BAD_SCOPE` | 400 | 管理端点参数非法 |
| `RATE_LIMITED` | 429 | 评论超过 2 条/分钟/指纹 |
| `TURNSTILE_TOKEN_MISSING` | 400 | 开关开启但未带 token |
| `TURNSTILE_FAILED` | 403 | 人机校验未通过 |
| `TURNSTILE_UNAVAILABLE` | 503 | 校验服务不可达且 fail_open=0 |
| `BANNED` | 403 | 命中黑名单（email/ip） |
| `ADMIN_UNAUTHORIZED` | 401 | 管理令牌无效 |
| `ADMIN_RATE_LIMITED` | 429 | 管理端点失败次数超限 |
| `COMMENT_NOT_FOUND` / `BAN_NOT_FOUND` / `NO_IP` | 404 | 目标不存在 |
| `NOT_FOUND` | 404 | 路由不存在 |
| `INTERNAL` | 500 | 服务端未预期异常（细节只进日志） |

---

## 隐私与数据契约

- 评论表只存 `email_md5`（Gravatar 头像用）；**明文邮箱**单独存 `comment_emails`，仅用于回复通知，不进任何公开查询；
- 不存明文 IP：`ip_hash = sha256(IP|ipban|salt)`，仅用于黑名单与限流；
- 管理列表邮箱脱敏展示（`a***@b.com`），哈希脱敏（前 8 位）。

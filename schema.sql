-- dujie-comment 数据库 schema（D1 / SQLite）
-- 初始化：wrangler d1 execute DB --file=schema.sql --remote
-- 或 CF REST API：POST /accounts/{acc}/d1/database/{db_id}/query（逐条执行）
-- 幂等：全部 CREATE IF NOT EXISTS，重复执行安全。

-- 评论表（树形回复，parent_id 自引用；status: approved/pending/hidden）
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,                -- 文章标识（页面唯一 key，如 my-post-1）
  parent_id INTEGER DEFAULT NULL,    -- 被回复的评论 id；NULL = 根评论
  nickname TEXT NOT NULL,
  email_md5 TEXT NOT NULL,           -- 邮箱 md5（Gravatar 头像）；空邮箱为派生稳定哈希
  website TEXT DEFAULT '',
  content TEXT NOT NULL,
  status TEXT DEFAULT 'approved',    -- approved=公开 / pending=待审核 / hidden=隐藏
  ip_hash TEXT DEFAULT '',           -- IP 黑名单哈希（不存明文 IP）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(slug, status, created_at);

-- 点赞表（文章 + 评论，voter_hash 指纹去重，重复插入=取消）
CREATE TABLE IF NOT EXISTS likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,         -- 'post' | 'comment'
  target_id TEXT NOT NULL,           -- post=slug；comment=评论 id（TEXT）
  voter_hash TEXT NOT NULL,          -- 访客指纹 sha256(IP|UA|salt)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_unique ON likes(target_type, target_id, voter_hash);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);

-- 浏览量表（每篇文章一行，UPSERT 累加）
CREATE TABLE IF NOT EXISTS views (
  slug TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 说说表（短动态，images 为 JSON 数组字符串）
CREATE TABLE IF NOT EXISTS says (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  images TEXT DEFAULT '',
  status TEXT DEFAULT 'approved',
  created_at TEXT DEFAULT (datetime('now'))
);

-- 黑名单表（email_md5 / ip_hash 双维度；UNIQUE + INSERT OR IGNORE 天然幂等，解黑 = DELETE）
CREATE TABLE IF NOT EXISTS banned (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ban_type TEXT NOT NULL,            -- 'email_md5' | 'ip_hash'
  ban_value TEXT NOT NULL,           -- email_md5(32hex) 或 ip_hash(64hex)
  reason TEXT DEFAULT '',            -- 拉黑原因（管理员填写，可空）
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_banned_unique ON banned(ban_type, ban_value);
CREATE INDEX IF NOT EXISTS idx_banned_type ON banned(ban_type);

-- 回复通知邮箱表（明文邮箱隔离存放，可独立 purge，不进任何公开查询）
CREATE TABLE IF NOT EXISTS comment_emails (
  comment_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 管理列表索引：按 status 分页（created_at DESC, id DESC）与回复数统计/通知查父
CREATE INDEX IF NOT EXISTS idx_comments_status_created ON comments(status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

-- NEON DRIFT · D1 表结构
-- 执行：npx wrangler d1 execute neon-drift-scores --remote --file=./schema.sql
-- 说明：API 首次请求也会用 CREATE TABLE IF NOT EXISTS 懒建表，
--       但建议先执行本文件，确保索引在写入高峰前就位。

CREATE TABLE IF NOT EXISTS scores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT    NOT NULL UNIQUE,   -- 每局唯一，用于幂等去重
  name        TEXT    NOT NULL,
  score       INTEGER NOT NULL,
  seconds     REAL    NOT NULL,          -- 存活秒数
  wave        INTEGER NOT NULL,
  kills       INTEGER NOT NULL,
  level       INTEGER NOT NULL,
  combo       INTEGER NOT NULL DEFAULT 0,
  mode        TEXT    NOT NULL,          -- standard | quick
  difficulty  TEXT    NOT NULL,          -- casual | standard | hard
  rank        TEXT    NOT NULL,          -- D/C/B/A/S
  ver         TEXT    NOT NULL DEFAULT '',
  ip_hash     TEXT    NOT NULL DEFAULT '',  -- 仅摘要，不存明文 IP
  created_at  INTEGER NOT NULL          -- Unix 秒
);

CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores(score DESC, seconds ASC, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_scores_ip   ON scores(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_scores_name ON scores(name, score DESC);

-- 可选：查看前 20 名
-- SELECT name, score, wave, mode, difficulty,
--        datetime(created_at, 'unixepoch') AS played_at
--   FROM scores ORDER BY score DESC LIMIT 20;

-- 可选：清理 90 天前的记录（如想控制表体积，定期手动执行）
-- DELETE FROM scores WHERE created_at < strftime('%s','now') - 90*86400;

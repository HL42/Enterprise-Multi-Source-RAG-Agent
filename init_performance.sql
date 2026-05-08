-- ============================================================
-- 性能优化 + 对话持久化
-- 在 Supabase SQL Editor 中执行（幂等，可重复运行）
-- ============================================================

-- ----------------------------------------
-- 1. pgvector IVFFlat 索引（加速语义搜索）
--    数据量 > 100 条后生效；lists=4 适合千级数据
-- ----------------------------------------
CREATE INDEX IF NOT EXISTS idx_policies_embedding
  ON company_policies
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 4);

-- ----------------------------------------
-- 2. chat_history — 多轮对话持久化表
-- ----------------------------------------
CREATE TABLE IF NOT EXISTS chat_history (
  id         TEXT PRIMARY KEY,               -- chat ID (UUID)
  messages   JSONB NOT NULL DEFAULT '[]',    -- UIMessage[] 序列化
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 允许 service_role / authenticated 读写（RLS 兼容）
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;

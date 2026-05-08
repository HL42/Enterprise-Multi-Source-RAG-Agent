-- ============================================================
-- 向量搜索存储函数
-- 在 Supabase SQL Editor 中执行此脚本
-- ============================================================

-- pgvector 余弦相似度搜索：输入 384 维 query embedding，返回 Top K 条最相似的政策文本
CREATE OR REPLACE FUNCTION search_policies (
  query_embedding vector(384),
  match_count integer DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  title varchar,
  content text,
  category varchar,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    cp.id,
    cp.title,
    cp.content,
    cp.category,
    1 - (cp.embedding <=> query_embedding) AS similarity
  FROM company_policies cp
  WHERE cp.embedding IS NOT NULL
  ORDER BY cp.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- 授权：允许 anon 和 authenticated 角色通过 Supabase REST API (supabase.rpc) 调用此函数
GRANT EXECUTE ON FUNCTION search_policies TO anon, authenticated;

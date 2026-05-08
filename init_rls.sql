-- ============================================================
-- Row Level Security (RLS) — 企业级数据访问基线
-- 适用环境: Supabase (PostgreSQL 15)
-- 执行方式: Supabase Dashboard → SQL Editor → 粘贴并运行
-- 可重复执行（幂等）
-- ============================================================

-- ============================================================
-- 设计说明
-- ============================================================
-- 后端 API Route 使用 service_role key，会完全绕过 RLS，
-- 所以启用 RLS 不影响现有功能。
--
-- RLS 的价值在于：
--   1. anon / authenticated 角色无法绕过 API 直接读写业务表
--   2. 即便将来接入前端直连（如 Supabase Realtime），数据仍有保护
--   3. 满足企业合规 Principle of Least Privilege
--
-- 当前策略：Enable RLS + 无 client-facing policy = 拒绝所有非 service_role 访问

-- ============================================================
-- 1. 员工表 (employees)
-- ============================================================
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;

-- 无显式 policy → anon/authenticated 拒绝全部操作
-- service_role (后端) 不受 RLS 限制，正常读写

-- ============================================================
-- 2. IT 工单表 (it_tickets)
-- ============================================================
ALTER TABLE it_tickets ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. 公司规章制度向量表 (company_policies)
-- ============================================================
ALTER TABLE company_policies ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. 收紧 search_policies 函数权限
-- ============================================================
-- init_vector_search.sql 中将 EXECUTE 授予了 anon 和 authenticated。
-- anon 本就无法读取 company_policies（因为 RLS），调用无实际意义，
-- 但撤销权限是更明确的防御姿势（defense in depth）。
-- authenticated 保留以备将来实名用户场景。
REVOKE EXECUTE ON FUNCTION search_policies(vector(384), integer) FROM anon;

-- ============================================================
-- 验证查询（可选，执行后确认 RLS 已启用）
-- ============================================================
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public'
--   AND tablename IN ('employees', 'it_tickets', 'company_policies');
--
-- 期望结果：rowsecurity = true (所有三行)

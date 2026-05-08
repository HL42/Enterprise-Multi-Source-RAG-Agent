# AI Review Prompt: Phase 2-4 Hardening

把下面这段直接发给另一个 AI/Codex。它的设计目标是：少贴代码、少耗 token，但让 AI 精准读取相关文件并产出可执行改动。

```text
你是资深 Next.js + Vercel AI SDK + Supabase 代码审查/修复助手。请在当前仓库中只读取必要文件，完成 Phase 2-4 的健壮性、UX、企业安全检查与修复。

项目背景：
- Next.js 14 App Router + React 18 + Tailwind
- Vercel AI SDK v6 + @ai-sdk/deepseek
- Supabase + pgvector，用 service_role key 仅在服务端访问
- 入口：聊天 UI 调 /api/chat，route 中 streamText 调 DeepSeek，并有两个 tool：
  - search_company_policy：embedding + supabase.rpc("search_policies")
  - query_employee_data：查 employees / it_tickets

优先读取这些文件，不要读取 .env.local 的值：
- package.json
- app/api/chat/route.ts
- app/page.tsx
- app/components/ChatInput.tsx
- app/components/ChatMessage.tsx
- app/components/LoadingBubble.tsx
- app/components/ToolInvocationBadge.tsx
- app/lib/env.ts
- app/lib/supabase.ts
- app/lib/embeddings.ts
- app/lib/tool-helpers.ts
- app/lib/messages.ts
- init_database.sql
- init_vector_search.sql

任务：
1. Phase 2 容错处理
   - DeepSeek API timeout / 429 / 5xx / 网络失败时，API 不能静默崩溃；前端显示友好的错误提示。
   - search_company_policy 或 query_employee_data 查不到数据时，tool 返回明确的 no_data 上下文，让 Agent 基于事实回答“未找到”，不能 hallucinate。
   - 保留现有 withToolErrorHandling 风格，避免每个 tool 内散落重复 try/catch。

2. Phase 3 性能与 UX
   - 检查 SSE/useChat 流式渲染是否会闪烁、重复 loading、空 assistant 气泡、自动滚动过度。
   - 在等待首字节 TTFB 时提供清晰 loading/disabled 状态；输入框等待期间禁用或显示生成中状态。
   - 不要大改 UI 风格，只做必要、低风险的 UX hardening。

3. Phase 4 企业安全
   - 检查 service_role key 是否只在服务端模块/API/脚本使用，不能进入 client bundle。
   - 检查 env 命名是否会误把敏感 key 暴露给客户端。
   - 为 employees、it_tickets、company_policies、search_policies 生成基础 RLS SQL；如果项目 SQL 缺失，请新增或更新一个安全 SQL 文件。
   - 注意：service_role 会绕过 RLS，但企业项目仍需要 RLS baseline。

输出/改动要求：
- 先给简短审查结论：发现的问题、要改哪些文件。
- 然后直接实施修复。
- 新增/修改 SQL 时要可重复执行（idempotent），包含 ALTER TABLE ENABLE ROW LEVEL SECURITY 和基础 policy。
- 不要打印或读取 .env.local 中的真实密钥。
- 不要引入大型依赖。
- 最后运行可用的本地验证：npm run build 或至少 npx tsc --noEmit；若失败，说明失败原因和剩余风险。
```

## 更省 token 的用法

如果是在同一个代码仓库里的 Codex/Claude Code/Cursor Agent，直接贴上面代码块即可。不要额外粘贴源码。

如果是在普通网页聊天 AI，才需要额外贴关键文件，顺序建议：

1. `app/api/chat/route.ts`
2. `app/page.tsx`
3. `app/components/ChatInput.tsx`
4. `app/lib/tool-helpers.ts`
5. `app/lib/env.ts`
6. `app/lib/supabase.ts`
7. `init_database.sql`
8. `init_vector_search.sql`

不要贴 `.env.local`。

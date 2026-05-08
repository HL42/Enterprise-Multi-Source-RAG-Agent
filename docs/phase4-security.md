# Phase 4 复盘：Enterprise Security Hardening

---

## 审查结论（发现的问题 3 个）

### 问题 1 — `env.ts` / `supabase.ts` 缺乏 client bundle 隔离

`SUPABASE_SERVICE_ROLE_KEY` 存储在 `app/lib/env.ts`。目前代码只有 API Route 会 import 它，不会进入 client bundle。但**没有任何编译期保护**——如果开发者在某个 Client Component 里误写了：

```ts
import { supabase } from "@/app/lib/supabase"; // ← 危险
```

Next.js 不会在 build 时报错，`SUPABASE_SERVICE_ROLE_KEY` 的引用就进入了浏览器包。浏览器里 `process.env.SUPABASE_SERVICE_ROLE_KEY` 会是 `undefined`（Next.js 只把 `NEXT_PUBLIC_*` 内联到 client bundle），但这还是把敏感模块代码暴露了，且容易引起混淆。

### 问题 2 — `NEXT_PUBLIC_SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 同住一个模块

`env.ts` 把一个公开 env（`NEXT_PUBLIC_SUPABASE_URL`）和一个私密 env（`SUPABASE_SERVICE_ROLE_KEY`）放在同一个对象里。开发者看到 `NEXT_PUBLIC_*` 可能误以为这个模块可以在客户端使用。没有 `server-only` 守卫，这个"合理假设"可能导致 key 泄露。

（注：Supabase URL 本身不是敏感信息，它就是项目地址，公开没问题。敏感的是 `service_role` key。）

### 问题 3 — 三张业务表和 `search_policies` 函数没有 RLS 策略

`init_database.sql` 建表时没有 `ENABLE ROW LEVEL SECURITY`。`init_vector_search.sql` 中把 `search_policies` 函数的 EXECUTE 权限授予了 `anon` 和 `authenticated` 两个角色。

后果：
- 如果将来有人直接用 `anon` key 访问 Supabase（比如从浏览器直连），能看到 `employees` 里所有人的手机号、邮箱。
- `anon` 可以直接调用 `search_policies`（虽然 RLS 启用后会被拦下，但在 RLS 未启用时这是可执行的）。

---

## 修了什么

### Fix 1 & 2 — `import "server-only"` 编译期守卫

在 `app/lib/env.ts` 和 `app/lib/supabase.ts` 顶部各添加一行：

```ts
import "server-only";
```

**效果**：如果有 Client Component 直接或间接 import 这两个模块，`next build` 会立刻失败并给出清晰报错：

```
Error: This module cannot be imported from a Client Component module.
It should only be used from a Server Component.
```

这是 Next.js 官方推荐的服务端模块隔离方式。我们安装了 `server-only` 包（178 字节，只有一行 `throw new Error`），非常轻量。

**为什么不用运行时检查（`typeof window !== "undefined"`）**：运行时检查只在浏览器执行时才发现问题，已经太晚了——key 可能已经进了 bundle。编译期检查在 `npm run build` 阶段就拦住了问题，零运行时成本。

**Guard 覆盖范围**：
- `env.ts` 加 `server-only` → 所有 import `env.ts` 的模块（包括 `supabase.ts`）自动受保护
- `supabase.ts` 单独加，是双重保护，也让 `supabase.ts` 的 import 路径即使不走 `env.ts` 也安全

**哪些模块没加**：
- `tool-helpers.ts` — 只有 `ToolError` class 和 HOF，无敏感数据，未来可能有合法的 client-side error 工具复用场景
- `embeddings.ts` — 依赖 `onnxruntime-node`（Native Addon），client bundle 打包时已经会 build 失败，`server-only` 是冗余保护，不加也可

### Fix 3 — `init_rls.sql`（新文件）

新建 `init_rls.sql`，可重复执行，包含：

```sql
-- 三张业务表均启用 RLS
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE it_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_policies ENABLE ROW LEVEL SECURITY;

-- 无显式 policy → anon/authenticated 被拒绝所有操作
-- service_role（后端 API）绕过 RLS，不受影响

-- 撤销 anon 对 search_policies 函数的执行权限
REVOKE EXECUTE ON FUNCTION search_policies(vector(384), integer) FROM anon;
```

**为什么不写任何 client policy**：

本项目的设计原则是**所有数据访问均经由 Next.js API Route（service_role key）**，没有客户端直连 Supabase 的场景。在这个架构下，最安全的 RLS 策略就是"不开放任何 client policy"：

```
┌─────────────┐      service_role key      ┌──────────────┐
│  Browser    │ ──► /api/chat (server) ──► │  Supabase    │
│  (anon)     │                            │  (bypasses   │
│  NO direct  │                            │   RLS)       │
│  Supabase   │                            └──────────────┘
│  access     │
└─────────────┘
```

RLS 的"无 policy = 拒绝全部"在这个架构下是 defense in depth，而不是功能限制。

**`REVOKE EXECUTE FROM anon` 的意义**：`init_vector_search.sql` 中的 `GRANT EXECUTE ... TO anon` 是为了让 PostgREST 能代表 anon 角色调用函数（supabase-js `rpc()` 的工作原理）。但我们的调用方是 service_role，不需要 anon 的 EXECUTE 权。RLS 启用后 anon 即使能调用函数，也会被底层的 `company_policies` 表 RLS 拦住——但撤销权限本身是更明确的防御姿势。

---

## 关键决策取舍

### 决策：为什么 `server-only` 加在 `env.ts` 而不是 `supabase.ts` 就够了？

从 import 链看，`supabase.ts` → `env.ts`，只要 `env.ts` 有守卫，import `supabase.ts` 就会传播守卫。但我们**两个都加**，原因：

1. **显式优于隐式**：阅读 `supabase.ts` 代码的人，直接在第一行看到 `import "server-only"`，无需追踪 `env.ts` 才能知道"这个模块是 server-only 的"。
2. **防止重构断链**：如果将来 `supabase.ts` 改为从其他地方获取配置（不再 import `env.ts`），守卫不会静默失效。

### 决策：RLS 为什么不建 `authenticated` 的 SELECT policy？

"已登录用户可以查询自己的工单"是一个合理的未来需求。但现在：
1. 项目没有实现用户认证（没有 `auth.users` 关联）
2. 企业 HR 数据（员工手机、邮箱）比工单更敏感，不应轻易开放
3. 在没有明确需求之前提前写 policy 反而增加攻击面

正确姿势：等认证体系建立后，在 `init_rls.sql` 中追加如下类型的 policy：

```sql
-- 示例：员工只能查自己的工单
CREATE POLICY "employee_own_tickets"
  ON it_tickets FOR SELECT
  TO authenticated
  USING (employee_id = (
    SELECT id FROM employees WHERE email = auth.email()
  ));
```

---

## 改动文件

| 文件 | 改动内容 |
|---|---|
| `app/lib/env.ts` | 顶部加 `import "server-only"` |
| `app/lib/supabase.ts` | 顶部加 `import "server-only"` |
| `init_rls.sql` | 新建：3 张表 RLS + revoke anon from search_policies |
| `package.json` / `node_modules` | 安装 `server-only` 包 |

## 验证

```bash
$ npx next build
✓ Compiled successfully
✓ Generating static pages (5/5)
```

Build 通过。正常的 server-side import 路径（API Route → supabase.ts）工作正常，`server-only` 守卫在 client-side import 时才触发 build error。

---

## 遗留的安全建议（超出本次 Code Review 范围）

| 建议 | 说明 |
|---|---|
| 生产环境下删除 `init_database.sql` 中的硬编码测试数据 | 员工姓名、邮箱、手机应从安全的 seed 管道注入，不应留在 git 仓库 |
| Supabase Dashboard 开启 "Leaked Password Protection" | Supabase Auth 选项，防止弱密码 |
| API Route 加 Rate Limiting | 使用 Vercel Edge Config 或 `@upstash/ratelimit`，防止 DeepSeek 费用爆表 |
| 增加 `Content-Security-Policy` header | `next.config.js` 里配置，限制 XSS 攻击向量 |

# 项目优化复盘

---

## 做了什么

本次优化覆盖 4 个模块，共修改 8 个文件，新增 2 个文件。

### 模块 1：数据库与离线脚本

**ingest.ts 完全重写**

| 优化前 | 优化后 |
|---|---|
| 硬编码一条 1265 字符的报销制度 | 从 Supabase 拉取所有 `embedding IS NULL` 行，逐条向量化回写 |
| 依赖 `app/lib/supabase.ts` + `app/lib/env.ts` | 独立读取 `process.env`，零耦合 |

为什么这么做：原来 `init_database.sql` 里插入的 5 条政策（考勤、IT设备、数据安全、年假调休）的 `embedding` 一直是 NULL，RAG 搜索只会匹配到硬编码的报销制度。现在重跑 `npm run ingest` 会把所有无 embedding 的行都向量化，知识库真正覆盖全部政策域。

**init_performance.sql (新增)**

两段 SQL：
- `CREATE INDEX ... USING ivfflat` — pgvector 的 IVFFlat 倒排索引。全表扫描在数据量破百后延迟可到几百毫秒，有了索引后降到 10ms 以内。`lists=4` 适合千级数据量。
- `chat_history` 表 — 为将来服务端对话持久化预留（当前前端用 localStorage）。

---

### 模块 2：Agent 路由与工具层

**System Prompt 关键词提炼规则**

新增了一条强制规则：调用 `search_company_policy` 前，必须把口语问题提炼为 ≤20 字的搜索关键词。并给了三个示例。

为什么这么做：`all-MiniLM-L6-v2` 是在英文语料上训练的，对中文自然语言的语义建模不如对关键词精确。用户说"俺想问下出差住店能给几个钱"直接当 query 传进去，和知识库里的"出差住宿标准：一线城市不超过 500 元/晚"做余弦相似度匹配，效果远不如提炼后的"出差住宿报销标准"。

**Zod 运行时校验替代硬断言**

```typescript
// 优化前
const rows = data as PolicySearchRow[];
const emp = employees[0] as EmployeeRow;

// 优化后
const rows = z.array(PolicySearchRow).parse(data);
const emp = EmployeeRow.parse(employees[0]);
```

为什么这么做：Supabase 返回的 JSON 类型是 `any`。如果 DBA 改了列名或类型（比如 `hire_date` 从 `string` 变成 `Date`），`as` 断言不会报错，代码会在后续逻辑中悄然崩溃。Zod `parse` 在类型不匹配时立刻抛 `ZodError`，`withToolErrorHandling` 捕获后转成 `{ error: "工具执行异常: ..." }` 喂回模型，整个流程不会崩。

**query_employee_data 增强**

三个改进：
1. 新增 `email` 可选参数 — 用 `eq("email", email)` 精确匹配，比 `ilike` 快且不会歧义
2. 员工查询 `limit(5)` — 防止极端情况返回全表
3. 多人匹配检测 — 当 `ilike` 返回 >1 条时，抛 `ToolError` 列出所有人名让模型追问用户

---

### 模块 3：Embedding 超时降级

**embeddings.ts 加入 25 秒超时**

```typescript
loadingPromise = Promise.race([
  loadingPromise,
  new Promise((_, reject) =>
    setTimeout(() => reject(new EmbeddingTimeoutError()), 25_000),
  ),
]);
```

为什么这么做：Render 部署后，第一次请求触发 ONNX 模型下载（~80MB），如果网络慢或磁盘 I/O 阻塞，会导致整个 HTTP 请求挂起。现在超时后 `withToolErrorHandling` 返回一条友好降级消息："政策搜索服务正在初始化中，请稍后再试。在此期间，你可以问我员工数据或 IT 工单相关的问题。"——Agent 不会崩溃，用户知道发生了什么。

---

### 模块 4：前端体验与工程配置

**localStorage 对话持久化**

刷新页面后从 `localStorage` 恢复历史消息。实现上用了 `hydrated` 状态避免 SSR/CSR 水合不匹配。

为什么不用 Supabase `chat_history` 表：当前 `useChat` 不支持直接从外部数据源注入历史消息到上下文（需要额外 API 设计），`localStorage` 是无依赖的最小可用方案。服务端持久化留给后续迭代。

**Next.js 15 兼容**

`next.config.js` 新增 `serverExternalPackages: ["@xenova/transformers", "onnxruntime-node"]`。这是 Next.js 15 的标准写法，替代了 14 的 `experimental.serverComponentsExternalPackages`。14.x 遇到不认识的 key 会自动忽略，所以向后兼容。

---

## 变更文件清单

| 文件 | 变更类型 |
|---|---|
| `scripts/ingest.ts` | 重写 — 从 Supabase 拉取 + 解耦 |
| `init_performance.sql` | 新增 — pgvector 索引 + chat_history 表 |
| `app/api/chat/route.ts` | 重写 — Zod 校验 + email + 多人匹配 + System Prompt 优化 |
| `app/lib/embeddings.ts` | 修改 — 加入 25s 超时 + EmbeddingTimeoutError |
| `app/lib/tool-helpers.ts` | 修改 — 超时降级消息 |
| `app/page.tsx` | 修改 — localStorage 对话持久化 |
| `next.config.js` | 修改 — Next.js 15 兼容 |
| `docs/optimization-review.md` | 新增 — 本文档 |

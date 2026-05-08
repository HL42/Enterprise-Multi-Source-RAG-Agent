# Phase 1 复盘：Architecture & Clean Code 全面优化

---

## 本 Phase 交付了什么

Phase 1 的目标不是"加新功能"，而是给前 4 个 Phase 沉淀下来的 ~400 行代码做一次架构整理。具体做了三件事：

### 1. 收紧了 TypeScript 类型，并意外发现一个隐藏 Bug

把整个 codebase 里的 6 处 `any` 全部消掉。过程中发现了一个**之前一直被 `any` 类型遮蔽的运行期 Bug**：`app/api/chat/route.ts` 的 `onStepFinish` 日志输出里用了 `tc.args` 和 `tr.result`，但 Vercel AI SDK v6 把这两个字段重命名成了 `input` 和 `output`。在 `: any` 的庇护下，`JSON.stringify(undefined)` 默默打印了 "undefined"，**所有工具调用的日志参数都是空的**——而我们之前根本没意识到。

### 2. 把 123 行的 `page.tsx` 拆成了 6 个组件 + 1 个 helper

新建 `app/components/` 目录，按职责拆出 `ChatHeader`、`EmptyState`、`ChatMessage`、`LoadingBubble`、`ChatInput` 五个 presentational 组件。同时新写了一个 `ToolInvocationBadge` 组件——这是**新增的用户可见能力**：之前后端有 `onStepFinish` 日志能看到 Agent 在调哪个工具，但前端用户对此一无所知。Badge 让"🔧 搜索公司制度 · 进行中…"这样的状态实时显示在消息流里，让 Agent 的 reasoning 过程对用户透明。

### 3. 提取了 3 处重复逻辑

| 抽出 | 原本散落在哪 | 新位置 |
|---|---|---|
| 环境变量校验 | `app/lib/supabase.ts:4-5`、`scripts/ingest.ts:20-21` 各自 `process.env.X!` | `app/lib/env.ts`（fail-fast，模块加载即校验） |
| Supabase 客户端 | `app/lib/supabase.ts` + `scripts/ingest.ts:188` 各 `createClient()` 一次 | `getSupabaseAdmin()` 单例工厂 |
| Tool 错误处理 boilerplate | `route.ts` 两个 tool body 里 4 处 try/catch + console.error + return 模板 | `app/lib/tool-helpers.ts` 的 `withToolErrorHandling` HOF + `ToolError` class |

---

## 一、扫描发现的问题清单

按照 Phase 1 三个子项的口径，扫描整库发现的问题：

### 1.1 TypeScript Strictness（6 处 `any`）

| # | 文件:行 | 现状 | 后果 |
|---|---|---|---|
| 1 | `app/api/chat/route.ts:42` | `event.toolCalls.forEach((tc: any) => …)` | 丢失 `StepResult<TOOLS>` 的精确类型推断 |
| 2 | `app/api/chat/route.ts:43` | `JSON.stringify(tc.args)` | **🐛 Bug：v6 字段叫 `input`，不是 `args`，日志一直在打印 `undefined`** |
| 3 | `app/api/chat/route.ts:47-48` | `(tr: any) … tr.result` | **🐛 同样的 Bug：v6 字段叫 `output`，不是 `result`** |
| 4 | `app/api/chat/route.ts:81` | `(data ?? []).map((row: any) => …)` | Supabase RPC 返回结构无类型，schema 改字段编译器不报错 |
| 5 | `app/api/chat/route.ts:86, 167` | `catch (e: any)` | 不符合 TS strict 推荐做法（`unknown` 才安全） |
| 6 | `app/lib/embeddings.ts:3-4` | `extractor: any`、`Promise<any>` | `extractor(text, opts)` 的返回值类型推断退化 |

### 1.2 Component Refactoring

`app/page.tsx` 一个文件 **123 行**，混合了：状态、effect、JSX 头部、空状态、消息渲染、loading 占位、输入框。问题：

- 渲染逻辑里硬塞了 `getMessageText` 工具函数（L26-31）——和 React 组件无关的纯 helper。
- 完全没渲染 tool 调用过程——后端拼命 log，前端用户什么都看不到，体验不"企业级"。
- 不存在 `app/components/` 目录，所有 UI 元素无法被复用或单独测试。

### 1.3 DRY 重复

| 重复点 | 出现位置 |
|---|---|
| `createClient(...)` 调用 | `app/lib/supabase.ts:3-6`、`scripts/ingest.ts:188` |
| `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")` | `app/lib/embeddings.ts:11`、`scripts/ingest.ts:148` |
| `process.env.X!` 非空断言 | `app/lib/supabase.ts:4-5`、`scripts/ingest.ts:20-21` |
| Tool 错误模板 `console.error + return {error}` | `route.ts:75-78, 86-88, 117-119, 149-151, 167-169` |

---

## 二、改了什么、为什么

### 1.1 TypeScript Strictness — 从 `any` 到精确类型

**新建 `app/lib/env.ts`**：集中管理 `NEXT_PUBLIC_SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`，模块加载时 fail-fast。

```ts
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`[env] 必需的环境变量缺失: ${name}\n…`);
  }
  return value;
}

export const env = {
  SUPABASE_URL: required("NEXT_PUBLIC_SUPABASE_URL"),
  SUPABASE_SERVICE_ROLE_KEY: required("SUPABASE_SERVICE_ROLE_KEY"),
} as const;
```

**为什么**：原来散落各处的 `process.env.X!` 在缺失时不会立刻崩溃——`!` 只是 TS 层面的非空断言，运行期返回 `undefined`，要等到第一次请求才报错。现在改为 import 即校验，部署时漏配立刻可见。

**route.ts 的 `any` 全部消除**：

- 移除 `tc: any` / `tr: any` → SDK 从 `tools: { … }` 自动推断出 `TypedToolCall<typeof tools>`，`tc.toolName` 现在是字面量联合 `"search_company_policy" | "query_employee_data"`。
- 修正 v6 字段名：`tc.args` → `tc.input`，`tr.result` → `tr.output`。**这就是消 `any` 的最大价值——不消，永远发现不了。**
- 为 Supabase 返回数据手写 3 个接口：`PolicySearchRow`、`EmployeeRow`、`TicketRow`，用 `as Type[] | null` 在 RPC/select 边界做一次精确转换。
- `catch (e: any)` 全部移除——错误处理统一收拢到 `withToolErrorHandling` 内部，那里用了 `e instanceof Error` 的窄化模式。

**`embeddings.ts` 的 pipeline 类型**：

```ts
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

let extractor: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;
```

`@xenova/transformers` 已经导出了 `FeatureExtractionPipeline` 类型（在 `pipelines.d.ts:629`），原来的 `any` 是纯粹的偷懒。

### 1.2 Component Refactoring — 拆 `page.tsx`

新建 `app/components/` 目录，从 `page.tsx` 抽出 6 个组件 + 1 个 helper：

```
app/
├── components/
│   ├── ChatHeader.tsx          # 顶部品牌区
│   ├── EmptyState.tsx          # 空对话欢迎语
│   ├── ChatMessage.tsx         # 单条消息：text + tool badges
│   ├── ToolInvocationBadge.tsx # 工具调用状态徽章 (新功能)
│   ├── LoadingBubble.tsx       # 三点跳动 loader
│   └── ChatInput.tsx           # 受控输入框
└── lib/
    └── messages.ts             # getMessageText / getToolParts / TOOL_LABELS
```

`page.tsx` 从 123 行降到 **51 行**，只保留状态管理 + 组合：

```tsx
export default function ChatPage() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState("");
  const isLoading = status === "submitted" || status === "streaming";
  …
  return (
    <div className="…">
      <ChatHeader />
      <section className="…">
        {messages.length === 0 && <EmptyState />}
        {messages.map((m) => <ChatMessage key={m.id} message={m} />)}
        {isLoading && <LoadingBubble />}
      </section>
      <ChatInput value={input} onChange={setInput} onSubmit={handleSend} disabled={isLoading} />
    </div>
  );
}
```

**关于 `ToolInvocationBadge`（这是 Phase 1 唯一一个新增功能）**：

复用 SDK 自带的 `isToolUIPart` type guard 从 `message.parts` 里筛出工具相关 part，按 state 渲染不同状态：

| state | 显示 |
|---|---|
| `input-streaming` / `input-available` | 🔧 搜索公司制度 · 进行中… (灰色) |
| `output-available` | ✅ 搜索公司制度 · 完成 (绿色) |
| `output-error` | ❌ 搜索公司制度 · 失败 (红色，附 errorText) |

**为什么加这个**：Agentic 应用最大的"黑盒"焦虑就是用户不知道 Agent 在干什么。前面已经有 `onStepFinish` 在服务端 log，但用户看不见。Badge 把"我现在去查数据库了"显式呈现，是 enterprise demo 里非常关键的信任信号。

**关于 `getMessageText` 的改写**：

原版手写了一个类型守卫：

```ts
m.parts.filter((p): p is { type: "text"; text: string } => p.type === "text")
```

新版直接用 SDK 导出的 `isTextUIPart`：

```ts
import { isTextUIPart } from "ai";
m.parts.filter(isTextUIPart)
```

少维护一个守卫，且未来 SDK 给 `TextUIPart` 加新字段（如已有的 `state?: "streaming" | "done"`）我们自动获益。

### 1.3 DRY 重构

**`app/lib/tool-helpers.ts`** 里的 HOF + 自定义 Error class：

```ts
export class ToolError extends Error {
  constructor(public readonly userMessage: string) { super(userMessage); }
}

export async function withToolErrorHandling<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError) {
      console.warn(`   ⚠️ [tool:${toolName}]`, e.userMessage);
      return { error: e.userMessage };
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error(`   ❌ [tool:${toolName}] 异常:`, message);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return { error: `工具执行异常: ${message}` };
  }
}
```

**两层错误的语义区分**：
- `ToolError` — **业务上预期**的失败（找不到员工、查询无结果），用 `console.warn` 打印，不是 bug；
- 其他 `Error` — **未预期**的异常（DB 挂了、SDK bug），用 `console.error` 打印 stack，需要排查。

之前所有 tool 的 `execute` 都是这个模板（带颜色和重复字符串）：

```ts
try {
  // ... 业务
  if (error) {
    console.error("   ❌ RPC 失败:", error.message, error.details);
    return { error: `搜索失败: ${error.message}` };
  }
  // ...
} catch (e: any) {
  console.error("   ❌ 异常:", e.message);
  return { error: `工具执行异常: ${e.message}` };
}
```

现在 tool body 只关心 happy path，错误用 `throw` 表达：

```ts
execute: ({ employeeName, queryType }) =>
  withToolErrorHandling("query_employee", async () => {
    const { data: employees, error } = await supabase.from("employees")...;
    if (error) throw new Error(`员工查询失败: ${error.message}`);
    if (!employees?.length) {
      throw new ToolError(`未找到员工「${employeeName}」，请确认姓名是否正确`);
    }
    // happy path 直接 return
  }),
```

**`getSupabaseAdmin()` 单例工厂**：

```ts
let cached: SupabaseClient | null = null;
export function getSupabaseAdmin(): SupabaseClient {
  if (!cached) {
    cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return cached;
}
export const supabase = getSupabaseAdmin(); // 兼容现有 import 写法
```

`scripts/ingest.ts` 改为 `import { getSupabaseAdmin } from "../app/lib/supabase"`，删掉自己的 `createClient` 调用。

**`scripts/ingest.ts` 复用 `getEmbedding`**：

之前脚本自己 `pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")` 又初始化一次。现在直接 `import { getEmbedding } from "../app/lib/embeddings"`，循环里调一次就行——共享 `embeddings.ts` 的 lazy-singleton，模型只下载/加载一次。

---

## 三、关键决策的取舍

### 决策 1：`unknown` vs `any` 在 catch 块里

**选了 `unknown`（实际通过 HOF 内部用 `instanceof Error` 窄化）。**

```ts
} catch (e) {            // 默认就是 unknown
  if (e instanceof ToolError) { ... }
  const message = e instanceof Error ? e.message : String(e);
  ...
}
```

**为什么不直接 `e: any`**：`any` 让 `e.foo.bar.baz` 这种 typo 不会被 TS 拦下。`unknown` 强迫每次 access property 前先窄化，是 TS strict mode 的标准模式。代价是多写一行 `instanceof Error`，收益是任何错误属性访问都被静态检查。

### 决策 2：Supabase 行类型选择手写 interface 而不是用 `database.types.ts`

**选了手写 interface。**

理由：项目还没引入 `npx supabase gen types`，且 schema 只有 3 张表，手写成本极低。生成的类型文件随 schema 变化会有大量噪音 diff，对于 demo 阶段是 over-engineering。

**何时切换**：当表数量超过 ~10、或字段开始频繁演进，再切到 `gen types`。这个决策应该在 Phase 5/6 重新评估。

### 决策 3：env.ts 集中校验 vs 各文件自己校验

**选了集中校验，且模块加载时 eager 执行（不是函数式 lazy）。**

```ts
export const env = {
  SUPABASE_URL: required("NEXT_PUBLIC_SUPABASE_URL"),  // ← import 时就执行
  ...
};
```

这意味着任何 import `env.ts` 的模块加载时如果环境变量缺失就立刻抛错。**激进但正确**：晚一秒发现 = 多一倍的人工时间排查"为什么 supabase 调用返回了奇怪的 401"。

**已知风险**：如果某个 client 组件不小心 import 了 env.ts，会在浏览器上炸（`SUPABASE_SERVICE_ROLE_KEY` 在客户端 bundle 里就是 `undefined`）。这其实是个**好的 fail-safe**——它会暴露出"你不该把 service role key 暴露给客户端"的错误，恰好对接 Phase 4 的安全审查。

### 决策 4：`ToolError` vs 直接 return error envelope

**选了 throw `ToolError`，由 HOF 统一转成 `{error: string}`。**

业务上"找不到员工"和"DB 挂了"在 LLM 看来都是 `{error: ...}` 的格式（这样模型能给用户友好回复，而不是把错误当数据），所以最终 envelope 是一样的。但对**人**——开发者读日志、运维做告警——两者完全不同：

- 找不到员工是 user 输入问题，频繁出现也正常 → `console.warn`
- DB 挂了是 infra 问题，出现一次就该告警 → `console.error` + stack

`ToolError` 是这个区分的载体。控制权回到 tool body：业务条件用 `throw new ToolError(...)`，未预期的 throw 自动落到第二个分支。

---

## 四、验证

```bash
$ npx tsc --noEmit
exit=0   # 0 个类型错误

$ npx next build
✓ Compiled successfully
✓ Generating static pages (5/5)

Route (app)                              Size     First Load JS
┌ ○ /                                    55 kB           142 kB
└ ƒ /api/chat                            0 B                0 B
```

类型检查 0 错误，production build 成功。前端 chunk 比 Phase 4 略大（多了 `ToolInvocationBadge` 和 6 个组件文件），但因为是同一份 React tree、Next.js 还能 tree-shake 掉未使用的 export，这个增量是合理的。

---

## 五、文件改动清单

### 新增（6 个文件）

```
app/lib/env.ts                          # 环境变量集中校验
app/lib/tool-helpers.ts                 # ToolError + withToolErrorHandling
app/lib/messages.ts                     # getMessageText / getToolParts / TOOL_LABELS
app/components/ChatHeader.tsx
app/components/EmptyState.tsx
app/components/ChatMessage.tsx
app/components/ToolInvocationBadge.tsx  # ← 唯一新功能
app/components/LoadingBubble.tsx
app/components/ChatInput.tsx
```

### 修改（4 个文件）

```
app/lib/supabase.ts          # 改用 env.ts，导出 getSupabaseAdmin 工厂
app/lib/embeddings.ts        # 类型化 extractor，提取 getExtractor()
app/api/chat/route.ts        # 消除全部 any，使用 HOF 和 ToolError，修正 input/output 字段
app/page.tsx                 # 123 行 → 51 行，组合 6 个子组件
scripts/ingest.ts            # 复用 supabase.ts 和 embeddings.ts，删除重复初始化
```

### 未改

- `app/layout.tsx` —— 只有 16 行，无需拆分
- `init_database.sql` / `init_vector_search.sql` —— SQL 不在 Phase 1 范围（Phase 4 会加 RLS）
- `tsconfig.json` —— 已经 `strict: true`，没需要调整

---

## 六、Phase 1 之外被发现、留给后续 Phase 的问题

下面这些问题在 Phase 1 扫描中被注意到，但不属于"架构与代码整洁度"，已留作下一阶段处理：

| 问题 | 应归入 |
|---|---|
| 没有 timeout/rate-limit 处理（DeepSeek 429） | Phase 2 |
| `search_company_policy` 返回 0 条时 LLM 可能编造（仅返回 `[]`） | Phase 2 |
| 没有 toast 给用户展示错误 | Phase 2 / 3 |
| 模型加载阶段（首次 ~80MB 下载）UI 无 TTFB feedback | Phase 3 |
| `SUPABASE_SERVICE_ROLE_KEY` 在 server-only 路径上但缺 `"server-only"` 守卫 | Phase 4 |
| 三张表都没有 RLS policies | Phase 4 |

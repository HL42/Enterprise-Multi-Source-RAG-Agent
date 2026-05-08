# Phase 2 复盘：Error Handling & Edge Cases

---

## 发现的问题（3 个）

### 问题 1 — `POST /api/chat`：`req.json()` 无保护

`route.ts` 直接 `await req.json()` 而没有 try/catch。如果客户端发来格式错误的请求体（例如空 body），会抛出未捕获的异常，Next.js 会把它转成 500 并返回 HTML 错误页。`useChat` 拿到非 JSON 响应时会让 `error` 变成奇怪的解析错误，用户看到一个莫名其妙的提示。

### 问题 2 — DeepSeek 429 / 5xx / 网络失败：错误静默吞噬

`streamText()` 调用没有 `onError` 回调。DeepSeek 返回 429 / 5xx 或网络中断时，错误会经 SSE 流传给 `useChat`，把 `error` 状态设为 `Error`。但 `page.tsx` 从来没有读取 `useChat` 的 `error` 字段——用户看到的是：Loading 气泡消失，没有任何提示，聊天界面"冻住"。

这是 UX 上最关键的缺失：用户以为 AI 在思考，其实 API 已经失败了。

### 问题 3 — Tool 0 行时 LLM 可能 Hallucinate

| Tool | 0 行时原来的返回 | 风险 |
|---|---|---|
| `search_company_policy` | `{ found: 0, policies: [] }` — 实际上是裸 `[]` | 模型看到空数组可能说"根据公司政策…"然后凭空编造 |
| `query_employee_data` (tickets) | `{ total: 0, tickets: [] }` | 模型可能不确定是"没工单"还是"查询出错" |

Vercel AI SDK 把 tool 返回值直接注入模型上下文。空数组是合法值，模型无法分辨"找到 0 条"和"工具出了问题"的区别。需要明确的文字指令告诉模型"找不到、请如实告知"。

---

## 修了什么

### Fix 1 — `req.json()` 加 try/catch

```ts
let messages: UIMessage[];
try {
  const body = await req.json();
  messages = (body as { messages: UIMessage[] }).messages ?? [];
} catch {
  return Response.json({ error: "请求格式错误" }, { status: 400 });
}
```

格式错误的请求立刻返回 400，不会引发未捕获异常。

### Fix 2 — `streamText` 加 `onError` 服务端日志

```ts
onError: (event) => {
  console.error("[streamText] 模型错误:", event.error);
},
```

DeepSeek 429 / 5xx / 网络错误发生时，服务端 console 会打印记录，便于生产排查。错误通过 SSE 传到 `useChat`，再由前端 UI 展示。

### Fix 3 — 前端消费 `useChat.error`

`page.tsx` 新增错误 banner：

```tsx
const { messages, sendMessage, status, error, clearError } = useChat();

{error && (
  <div className="… border-red-500/30 bg-red-500/10 … text-red-300">
    <span>⚠️</span>
    <span>
      {error.message.includes("429")
        ? "请求过于频繁，请稍后再试。"
        : "AI 服务暂时不可用，请稍后重试。"}
    </span>
    <button onClick={clearError}>✕</button>
  </div>
)}
```

- 429 场景给用户"稍后再试"的明确指引，而不是通用报错
- ✕ 按钮调 `clearError()`，让用户可以重新尝试提问而不用刷页面

### Fix 4 — `search_company_policy` 0 条时返回显式指令

```ts
if (rows.length === 0) {
  return {
    found: 0,
    message: "知识库中未检索到相关政策内容…请勿编造政策，直接告知用户无相关记录。",
    policies: [],
  };
}
return { found: rows.length, policies: rows.map(...) };
```

**为什么用 `message` 字段而不只是空数组**：模型看到 `[]` 不知道是 "没数据" 还是 "系统错误"。把指令直接写进 tool 返回值是 Agentic 系统的最佳实践——比写在 system prompt 里更精准，因为它只在这次工具调用后的推理步骤生效。

### Fix 5 — `query_employee_data` tickets 0 条时加 message

```ts
message:
  ticketRows.length === 0
    ? `${employee.name} 目前没有任何 IT 工单记录，请如实告知用户。`
    : undefined,
```

员工存在但没工单是正常业务场景（不是错误）。`message` 字段把这个事实明确给模型，避免模型猜测"也许没查到"。

---

## 关键设计决策

### 决策：为什么把"请勿编造"写进 tool 返回而不是 system prompt？

System prompt 设置了全局约束（"禁止编造数据"），但全局约束会被 step-level 的上下文覆盖。Agentic 框架里，每次工具调用的结果作为 assistant 消息追加到 context 里，**紧随结果后的那一步推理**是最容易出现 hallucination 的节点。

把"请如实告知"写在 tool 结果里 = 这条指令和空数据结果同时出现在模型的当前推理上下文里，距离最近、最有效。

### 决策：error banner 放在 LoadingBubble 下方，而不是 toast

Toast 需要引入状态管理或第三方库，不符合"不引入大型依赖"的要求。内联 banner 在流式聊天界面里更自然——它出现在消息流的末尾，用户视线自然落在那里，且不会遮挡内容。

---

## 改动文件

| 文件 | 改动内容 |
|---|---|
| `app/api/chat/route.ts` | req.json guard + onError + search 0 行 message + tickets 0 行 message |
| `app/page.tsx` | useChat 解构 error/clearError + 内联错误 banner |

## 验证

```bash
$ npx next build
✓ Compiled successfully
✓ Generating static pages (5/5)
```

0 类型错误，production build 通过。

---

## 遗留问题（留 Phase 3 / 4）

| 问题 | 归入 Phase |
|---|---|
| 首次 TTFB 等待期（embedding 模型加载 ~80MB）无 loading 反馈 | Phase 3 |
| 输入框在模型加载阶段 disabled 但无状态文字说明 | Phase 3 |
| 消息列表 auto-scroll 在高频更新时可能抖动 | Phase 3 |
| `SUPABASE_SERVICE_ROLE_KEY` 缺 server-only 守卫 | Phase 4 |
| 三张表无 RLS policies | Phase 4 |

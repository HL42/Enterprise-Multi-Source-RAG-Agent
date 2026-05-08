# Phase 3 复盘：Performance & UX Hardening

---

## 发现的问题（3 个）

### 问题 1 — 自动滚动抖动（scroll jitter）

`page.tsx` 的滚动逻辑：

```tsx
useEffect(() => {
  bottomRef.current?.scrollIntoView({ behavior: "smooth" });
}, [messages]);
```

`messages` 数组在 `status === "streaming"` 阶段每隔几十毫秒就更新一次（每个 token 都触发）。每次更新都启动一次 `smooth` 滚动动画。多个动画同时存在时，浏览器会把它们叠加执行，产生"滚动一截停下来、再滚一截停下来"的抖动感。在快速模型（DeepSeek Turbo）下尤为明显。

### 问题 2 — 流式文字与跳点 Loader 同时出现（视觉冗余）

```tsx
{isLoading && <LoadingBubble />}
```

`isLoading = status === "submitted" || status === "streaming"`——只要 streaming 还未结束，跳点就一直渲染。结果是：

```
[assistant] 根据公司报销制度，差旅住宿标准为...  ← 正在流式输出
[· · ·]                                        ← 同时出现
```

当用户已经能看到 AI 的文字时，额外的"等待"动画反而制造困惑，让人不确定这是新内容、还是 AI 还在思考什么额外的东西。

### 问题 3 — 发送按钮无 TTFB 反馈

按钮一直显示"发送"，即使用户点击后请求已发出、界面正在等待。用户无法分辨是"我的点击没有生效"还是"AI 正在处理"——这是导致重复点击的经典根因。

---

## 修了什么

### Fix 1 — 区分"新消息"与"内容更新"的滚动行为

```tsx
const prevMsgCountRef = useRef(0);

useEffect(() => {
  const isNewMessage = messages.length !== prevMsgCountRef.current;
  prevMsgCountRef.current = messages.length;
  bottomRef.current?.scrollIntoView({
    behavior: isNewMessage ? "smooth" : "instant",
  });
}, [messages]);
```

| 触发时机 | 消息数量变化 | 滚动行为 |
|---|---|---|
| 用户发送消息 | +1 | `smooth`（流畅过渡） |
| AI 第一条消息出现 | +1 | `smooth` |
| Streaming 中文字增量更新 | 0（同一条消息内容变化） | `instant`（无动画，立刻到底） |

**为什么 `"instant"` 而不是不滚动**：不滚动的话，streaming 时用户需要手动拖滚动条才能看到最新内容，体验更差。`"instant"` 保证用户始终看到最新 token，同时不产生动画竞争。

**`"instant"` 浏览器兼容性**：Chrome 85+、Firefox 36+、Safari 15.4+ 均支持，Next.js 企业项目目标浏览器范围内。

### Fix 2 — `showLoader`：智能隐藏冗余跳点

```tsx
const lastMsg = messages.at(-1);
const showLoader =
  isLoading &&
  !(lastMsg?.role === "assistant" && getMessageText(lastMsg).length > 0);
```

逻辑：当最后一条消息是 assistant 且已有可见文字时，跳点隐藏。其余情况保持显示：

| 场景 | `showLoader` | 说明 |
|---|---|---|
| 用户刚发送，等待响应 | ✅ 显示 | 还没有 assistant 消息 |
| Agent 在做 tool call（无文字） | ✅ 显示 | 有 assistant 消息但 text 为空 |
| AI 开始流式输出文字 | ❌ 隐藏 | 文字本身就是反馈，跳点冗余 |
| 等待状态结束 | ❌ 隐藏 | `isLoading === false` |

### Fix 3 — 按钮文案动态反映状态

```tsx
<button disabled={disabled || !value.trim()} ...>
  {disabled ? "生成中…" : "发送"}
</button>
```

| 状态 | 按钮显示 | 含义 |
|---|---|---|
| 空输入 | 发送（disabled） | 无内容可发 |
| 有输入、空闲 | **发送** | 可点击 |
| 等待 AI（disabled） | **生成中…** | 已收到请求，正在处理 |

---

## 决策：为什么不加 debounce 而是用 `behavior: "instant"`？

Debounce 的方案（e.g. 100ms 防抖）有两个问题：
1. 在快速 streaming 时，100ms 内有大量更新，用户会看到界面"卡顿感"（每次 debounce 到期才跳一下）
2. 需要 `clearTimeout` + `setTimeout` 的 cleanup，增加了组件复杂度

`behavior: "instant"` 每次更新同步执行，浏览器内部用高效的 DOM 位置计算，不产生动画线程竞争，也不增加代码复杂度。对于需要实时跟随的 streaming 场景，这是更合适的选择。

---

## 改动文件

| 文件 | 改动内容 |
|---|---|
| `app/page.tsx` | 引入 `getMessageText`；`prevMsgCountRef` 区分滚动行为；`showLoader` 逻辑替换 `isLoading` |
| `app/components/ChatInput.tsx` | 按钮文案：`disabled ? "生成中…" : "发送"` |

## 验证

```bash
$ npx next build
✓ Compiled successfully
✓ Generating static pages (5/5)
```

---

## 遗留问题（留 Phase 4）

| 问题 | 归入 Phase |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` 无 `server-only` 守卫 | Phase 4 |
| 三张表无 RLS policies | Phase 4 |
| `search_policies` 函数 GRANT 授权范围（目前授权给 `anon` 和 `authenticated`） | Phase 4 |

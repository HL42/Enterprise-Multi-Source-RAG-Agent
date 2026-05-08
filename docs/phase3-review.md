# Phase 3 复盘：流式输出 (SSE) 与前端聊天界面

---

## 本 Phase 交付了什么

Phase 3 的目标是把之前搭好的数据库和知识库，用一条可交互的聊天界面串起来。具体做了四件事：

### 1. 从零搭建了 Next.js 14 App Router 项目骨架

之前项目只有 `scripts/ingest.ts` 和一个裸的 `package.json`。Phase 3 补充了完整的前端基础设施：

| 文件 | 作用 |
|---|---|
| `next.config.js` | Next.js 入口配置 |
| `tailwind.config.js` + `postcss.config.js` | Tailwind CSS v4 构建管线 |
| `app/globals.css` | Tailwind 指令注入 |
| `app/layout.tsx` | 根布局：中文 lang、暗色背景、全局字体平滑 |
| `tsconfig.json` | 从纯 Node 脚本配置切换为 Next.js 配置（`jsx: "preserve"`, `moduleResolution: "bundler"`） |
| `package.json` | 新增 `dev` / `build` / `start` / `ingest` 四个脚本 |
| `.env.local` | 集中管理 `DEEPSEEK_API_KEY` 和 Supabase 连接信息 |

### 2. 写了一个极简但完整的聊天界面 `app/page.tsx`

设计决策：

- **暗色主题** — `bg-zinc-950` 打底，用户气泡白底黑字、AI 气泡半透明灰底，视觉上区分角色
- **三段式布局** — 顶部 Header（品牌标识）/ 中间消息区（`flex-1 overflow-y-auto`）/ 底部输入栏（`shrink-0`），高度始终占满视口（`h-dvh`）
- **空态引导** — 没有消息时显示欢迎语和示例问题提示，让首次使用者知道该做什么
- **生成中动画** — 三个带 `animate-bounce` 的小圆点，不同 `animation-delay` 制造波浪效果
- **自动滚到底部** — `useRef` + `scrollIntoView({ behavior: "smooth" })`，每次新消息到达时平滑滚动
- **发送按钮 disabled 逻辑** — 两种状态：`isLoading` 时和输入为空时，按钮灰显不可点击

### 3. 写了一条极简的 API 路由 `app/api/chat/route.ts`

只有 11 行代码。这恰好体现了 Vercel AI SDK 的价值——它把"接 DeepSeek API + 处理 SSE 流 + 序列化响应"这个复杂流程压缩到了一次函数调用：

```typescript
const result = streamText({ model: deepseek("deepseek-chat"), messages });
return result.toDataStreamResponse();
```

- `streamText()` 返回的是一个 `StreamTextResult` 对象，内部已经封装了 SSE 协议的连接管理、chunk 拆分、错误重试
- `toDataStreamResponse()` 自动设置 HTTP 响应头（`Content-Type: text/event-stream` 等），Next.js 和浏览器就都知道"这是一条流"
- `export const runtime = "edge"` 告诉 Vercel/Next.js 把这条路由部署到 Edge Runtime，冷启动更快

### 4. 产出了这份复盘文档

下面详细解释两个关键概念：SSE 是什么、为什么流式输出是 2026 年 AI 产品的标配。

---

## 一、什么是 SSE (Server-Sent Events)？它在这个代码里体现在哪里？

### 一个比喻

假设你在看一场足球比赛的直播：
- **WebSocket** 是双向对讲机——你和主播都能说话，连接始终开着
- **SSE** 是单向直播流——主播一直在说，你只需要听，偶尔发一条弹幕就行
- **普通 HTTP 请求** 是去图书馆借书——去一次，拿一本，回家，结束

AI 聊天的场景天然是 SSE 的形态：用户发一句话（一个普通 POST 请求），AI 开始生成，内容一点一点推回来（服务器→浏览器的单向流）。中途不需要用户再说话。

### SSE 的底层协议

在 HTTP 层面，SSE 极其简单。服务端只要设置一个特殊的响应头：

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

然后响应体按这种格式不断地写：

```
data: {"type":"text-delta","textDelta":"你好"}

data: {"type":"text-delta","textDelta":"，"}

data: {"type":"text-delta","textDelta":"我是"}

data: {"type":"text-delta","textDelta":"企业助手"}

data: [DONE]
```

浏览器端的 `EventSource` API 会解析这些 chunk，每收到一个 `data:` 行就触发一次回调。**注意，HTTP 连接始终是那一条**，数据是"流"过来的，不是反复发起新请求。

### 在这个项目里，SSE 体现在哪里？

**服务端（`app/api/chat/route.ts`）：**

`streamText().toDataStreamResponse()` 这行代码内部做的事情是：

1. 调 DeepSeek API，带上 `stream: true` 参数
2. DeepSeek 开始逐个 token 返回 chunk
3. Vercel AI SDK 的 `streamText` 把每个 token 包装成 SSE 格式的 `data:` 行
4. `toDataStreamResponse()` 设置 `Content-Type: text/event-stream` 并返回 `Response` 对象

对于浏览器来说，它收到的就是一个标准的 SSE 流。

**客户端（`app/page.tsx`）：**

`useChat()` hook 内部做的事情是：

1. 用户提交表单时，`handleSubmit` 发一个普通 `fetch('/api/chat', { method: 'POST', body: ... })` 请求
2. **关键**：`fetch` 拿到响应后，不是等 `response.json()` 一次性解析
3. 而是读取 `response.body` —— 一个 `ReadableStream`
4. 用 `response.body.getReader()` 逐块读取 SSE 事件
5. 每读到一个 `text-delta` chunk，追加到当前 message 的 content 末尾，触发 React 重渲染

这就是为什么"流"的感觉是逐字出现的——React 每收到一个 token 就重渲染一次消息气泡。

### 一条消息的完整旅程

```
用户在输入框打"张伟的工单有哪些"，按回车
       ↓
page.tsx: handleSubmit → fetch POST /api/chat
       ↓
route.ts: 收到 { messages: [...] }
       ↓
route.ts: streamText({ model: deepseek("deepseek-chat"), messages })
       ↓
Vercel AI SDK 调 DeepSeek API (stream: true)
       ↓
DeepSeek 开始生成: token1="张" → token2="伟" → token3="目前" → ...
       ↓
每个 token 经 SSE 数据帧传回浏览器
       ↓
useChat 的 ReadableStream reader 逐个消费 token
       ↓
React state 更新 → 用户屏幕上一个一个字往外蹦
       ↓
DeepSeek 生成完毕 → stream 关闭 → isLoading 变 false
```

---

## 二、为什么在 2026 年的 AI 开发中，流式输出是绝对标准？

### 一句话：AI 生成文本的速度赶不上人类的期望，流式输出用"正在发生"的错觉填补了这段等待时间。

### 展开说

**1. LLM 的生成延迟是物理瓶颈，优化不了**

DeepSeek-V3 生成 100 个 token 大约需要 2-4 秒（取决于负载和 prompt 长度）。这不是网络问题，是 Transformer 的逐 token 自回归解码机制决定的——GPU 算力再翻一倍，也只能把这个时间压缩到 1-2 秒，不可能做到瞬时。

这就意味着：**如果你的产品等全部文字生成完再一次返回，用户永远要等 3 秒以上。** 这在体验上是不可接受的——用户第 1.5 秒就会开始怀疑"是不是卡住了"。

**2. 流式输出把"等待"变成了"观看"**

心理学上有一个现象：**已知的等待比未知的等待短。** 进度条就是一个经典案例——用户看到进度条在动，即使总时间没变短，焦虑感也会下降。

AI 的流式输出就是天然的"进度条"——用户看到文字一个一个字往外跳，注意力被内容本身吸引，不会意识到"正在等"。反而是非流式的"转圈 3 秒然后弹出一大段"会让人感到突兀。

**3. 用户可以在中途打断**

这一点在工程上很重要但常被忽视。GPT-4 或 DeepSeek 生成长回答时，前 50 个 token 往往已经包含了完整结论，后面的 200 个 token 全是展开说明。如果用户看了前两句话已经得到答案，就可以直接问下一个问题——流式输出让用户能在第一句话出现的瞬间就开始阅读和判断，不用等所有文字生成完毕。

如果配合 `stop()` 函数（`useChat` 返回了这个方法），用户甚至可以点击"停止生成"按钮来中止当前回答，这在非流式模式下是不可能做到的。

**4. 2026 年，不支持流式的 AI 产品会被视为"坏了"**

这已经是行业共识。OpenAI ChatGPT、DeepSeek Chat、Claude.ai、Gemini——所有主流产品的 Web 端都使用流式输出。用户习惯了这个模式后，遇到非流式的 AI 产品第一反应不是"这个产品设计不同"，而是"是不是网络有问题"。

对于你这个企业支持智能体来说更是如此——员工打开这个页面，期待的就是一个类 ChatGPT 的体验。如果问完问题要盯着转圈 3 秒，开箱体验直接毁了。

### Vercel AI SDK 在这个问题上的价值

没有 AI SDK 时，你需要手写：
- `fetch` + `response.body.getReader()` 的 ReadableStream 消费逻辑
- SSE `data:` 行的文本解析
- token chunk 的累积和状态管理
- 错误处理和断线重连
- React 状态更新的防抖/节流

大约 200-300 行代码，而且边界 case 很多。`useChat` 一行 hook + `streamText` 一行函数调用，把这些全部封装了。11 行的 API route + 干净的组件代码，就是 Vercel AI SDK 对流式输出的最佳实践封装。

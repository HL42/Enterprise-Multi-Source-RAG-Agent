# 企业内部支持智能体 — Project Overview

---

## 一句话描述

一个面向企业 HR/IT 场景的 RAG 智能体，能主动查询数据库和知识库来回答员工问题。前端用类 ChatGPT 流式界面，后端用 DeepSeek + Agentic Tool Calling，向量化全部在本地完成，不依赖外部 Embedding API。

---

## 核心功能

| 功能 | 说明 |
|---|---|
| **规章制度语义检索 (RAG)** | 用户问报销标准、年假政策等 → Agent 调 `search_company_policy` 工具 → 本地 embedding 向量化问题 → Supabase pgvector 余弦相似度搜索 Top 3 → 结果喂回 DeepSeek 生成回答 |
| **员工数据精确查询 (SQL)** | 用户问员工信息或 IT 工单 → Agent 调 `query_employee_data` 工具 → Supabase 关系型表精确查询 → 结果整理成可读回复 |
| **流式输出 (SSE)** | 所有回答逐 token 渲染到前端，不是一次性返回 |
| **Agentic 工具路由** | 大模型根据 tool description 自主判断该调哪个工具，无需 if-else 规则 |
| **本地 Embedding** | `@xenova/transformers` + `all-MiniLM-L6-v2` 在 Node.js 本地完成向量化，零 API 费用、数据不出本机 |
| **错误降级** | 前端展示 API 错误提示（429 / 服务不可用）；Tool 执行异常通过 `ToolError` 回传模型，不崩溃整个流程 |

---

## 技术栈

| 层 | 技术 |
|---|---|
| **前端框架** | Next.js 14 (App Router) |
| **语言** | TypeScript |
| **样式** | Tailwind CSS v3 |
| **AI 编排** | Vercel AI SDK v6 |
| **大模型** | DeepSeek (deepseek-chat) |
| **向量化 (Embedding)** | @xenova/transformers (本地 ONNX 推理, all-MiniLM-L6-v2) |
| **数据库** | Supabase (PostgreSQL + pgvector) |
| **参数校验** | Zod |

---

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│  浏览器 (localhost:3000)                                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │  app/page.tsx  (useChat hook)                      │  │
│  │  ┌─────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐ │  │
│  │  │ChatHeader│ │ChatMessage│ │EmptySt.│ │ChatInput│ │  │
│  │  └─────────┘ └──────────┘ └────────┘ └─────────┘ │  │
│  └───────────────────────────────────────────────────┘  │
│                          │ POST /api/chat                │
└──────────────────────────┼──────────────────────────────┘
                           │ SSE (text/event-stream)
┌──────────────────────────┼──────────────────────────────┐
│  Next.js API Route (runtime: nodejs)                     │
│  app/api/chat/route.ts                                   │
│                                                          │
│  streamText({                                            │
│    model: deepseek("deepseek-chat"),                     │
│    stopWhen: stepCountIs(5),                             │
│    tools: {                                              │
│      search_company_policy  ←──→ app/lib/embeddings.ts   │
│      query_employee_data    ←──→ app/lib/supabase.ts     │
│    }                                                     │
│  })                                                      │
└──────────────┬────────────────────┬──────────────────────┘
               │                    │
     ┌─────────▼────────┐  ┌───────▼──────────┐
     │  @xenova/         │  │  Supabase         │
     │  transformers     │  │  (PostgreSQL)      │
     │  (本地 ONNX 推理)  │  │                   │
     │                   │  │  ┌─ employees      │
     │  all-MiniLM-L6-v2 │  │  ├─ it_tickets     │
     │  384 维向量输出    │  │  └─ company_policies│
     └───────────────────┘  │     (pgvector)      │
                            └─────────────────────┘
```

---

## 关键数据流

### RAG 链路（用户问政策）
```
用户输入 "出差住宿能报销多少？"
  → useChat → POST /api/chat
  → streamText → DeepSeek 识别意图
  → Tool: search_company_policy({ query: "出差住宿能报销多少？" })
  → getEmbedding(query) → 384 维向量
  → supabase.rpc("search_policies", { query_embedding, match_count: 3 })
  → pgvector <=> 余弦距离排序 → Top 3 政策块
  → 结果喂回 DeepSeek → 基于真实政策生成回答
  → 流式 SSE → 前端逐 token 渲染
```

### SQL 查询链路（用户问工单）
```
用户输入 "张伟的 IT 工单有哪些？"
  → useChat → POST /api/chat
  → streamText → DeepSeek 识别意图
  → Tool: query_employee_data({ employeeName: "张伟", queryType: "tickets" })
  → supabase.from("employees").select().ilike("name", "%张伟%")
  → 拿到 employee.id
  → supabase.from("it_tickets").select().eq("employee_id", id)
  → 结果喂回 DeepSeek → 整理成表格回答
  → 流式 SSE → 前端逐 token 渲染
```

---

## 项目文件结构

```
Rag Agent/
├── app/
│   ├── api/chat/route.ts        # 核心：Agent 路由，Tool 定义
│   ├── components/
│   │   ├── ChatHeader.tsx       # 顶部品牌栏
│   │   ├── ChatMessage.tsx      # 消息气泡（含 tool 标记）
│   │   ├── ChatInput.tsx        # 底部输入框 + 发送按钮
│   │   ├── EmptyState.tsx       # 未对话时的引导页
│   │   ├── LoadingBubble.tsx    # 生成中的跳点动画
│   │   └── ToolInvocationBadge.tsx
│   ├── lib/
│   │   ├── embeddings.ts        # Embedding 模型懒加载单例
│   │   ├── env.ts               # 环境变量集中管理（懒校验）
│   │   ├── messages.ts          # UIMessage 文本提取工具
│   │   ├── supabase.ts          # 服务端 Supabase 客户端
│   │   └── tool-helpers.ts      # Tool 统一错误处理封装
│   ├── layout.tsx               # 根布局
│   ├── page.tsx                 # 聊天主页面
│   └── globals.css              # Tailwind 入口
├── scripts/
│   └── ingest.ts                # 知识库向量化入库脚本
├── docs/                        # 各 Phase 复盘文档
├── init_database.sql            # 数据库建表 + 测试数据
├── init_vector_search.sql       # pgvector RPC 搜索函数
├── init_rls.sql                 # Row Level Security 配置
├── next.config.js               # webpack externals (onnxruntime-node)
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
└── .env.local                   # API Key + Supabase 连接
```

---

## 数据库表

| 表 | 类型 | 用途 |
|---|---|---|
| `employees` | 关系型 | 员工信息（姓名、部门、职位、邮箱） |
| `it_tickets` | 关系型 | IT 工单（标题、分类、状态、优先级） |
| `company_policies` | 向量型 | 公司规章制度（content 文本 + embedding 384 维向量） |

---

## 运行方式

```bash
# 1. 配置 .env.local（DeepSeek Key + Supabase URL/Key）

# 2. 数据库初始化（Supabase SQL Editor 各执行一次）
#   - init_database.sql      建表 + 测试数据
#   - init_vector_search.sql 创建搜索函数
#   - init_rls.sql           启用 RLS（可选）

# 3. 向量化知识库入库
npm run ingest

# 4. 启动开发服务
npm run dev
# 浏览器打开 http://localhost:3000
```

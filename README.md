# 企业内部支持智能体 (Enterprise HR/IT Support Agent)

An Agentic RAG application that answers employee questions by autonomously querying both a vector knowledge base (company policies) and relational databases (employee records, IT tickets). Built with Next.js 14, DeepSeek, Vercel AI SDK v6, and Supabase pgvector — all embedding runs locally at zero API cost.

## Features

- **🔍 RAG Semantic Search** — Asks about reimbursement standards, leave policies, etc. → Agent calls `search_company_policy` → local embedding → pgvector cosine similarity → Top‑3 policy chunks → streams a grounded answer
- **📋 Structured Data Query** — "What tickets does Zhang Wei have?" → Agent calls `query_employee_data` → SQL on Supabase → returns real rows
- **⚡ Streaming (SSE)** — Every response renders token‑by‑token, ChatGPT‑style
- **🧠 Agentic Tool Routing** — The LLM decides which tool to call based on descriptions; no hand‑written if‑else
- **💰 Free Local Embedding** — `@xenova/transformers` runs `all-MiniLM-L6-v2` via ONNX Runtime in‑process; zero external API cost, data never leaves the machine
- **🛡️ Error Degradation** — Tool failures become user‑friendly messages instead of crashing the whole flow

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript |
| Styling | Tailwind CSS v3 |
| AI Orchestration | Vercel AI SDK v6 |
| LLM | DeepSeek (`deepseek-chat`) |
| Embedding | @xenova/transformers (all‑MiniLM‑L6‑v2, ONNX, local) |
| Database | Supabase (PostgreSQL + pgvector) |
| Validation | Zod |

## Architecture

```
Browser (localhost:3000)
  │
  │  app/page.tsx  ── useChat() hook
  │  POST /api/chat  (SSE stream)
  ▼
┌─────────────────────────────────────────┐
│  app/api/chat/route.ts                  │
│  streamText({                           │
│    model: deepseek("deepseek-chat"),    │
│    stopWhen: stepCountIs(5),            │
│    tools: {                             │
│      search_company_policy ──► pgvector  │
│      query_employee_data  ──► SQL       │
│    }                                    │
│  })                                     │
└──────┬────────────────────┬─────────────┘
       │                    │
  ┌────▼────────┐   ┌──────▼──────┐
  │ @xenova/    │   │  Supabase    │
  │ transformers│   │  PostgreSQL  │
  │ (ONNX, CPU) │   │  + pgvector  │
  └─────────────┘   └─────────────┘
```

### RAG Flow (policy question)

```
User: "出差住宿能报销多少？"
  → DeepSeek decides: search_company_policy
  → getEmbedding("出差住宿能报销多少？") → 384‑d vector
  → supabase.rpc("search_policies", { query_embedding, match_count: 3 })
  → pgvector <=> cosine distance → Top 3 chunks
  → Results fed back to DeepSeek → final answer streamed to UI
```

### SQL Flow (ticket question)

```
User: "张伟的 IT 工单有哪些？"
  → DeepSeek decides: query_employee_data
  → employees SELECT → employee.id
  → it_tickets SELECT WHERE employee_id = id
  → Results fed back to DeepSeek → table formatted in Chinese
```

## Database

| Table | Type | Purpose |
|---|---|---|
| `employees` | Relational | Name, department, position, email, phone |
| `it_tickets` | Relational | Title, category, status, priority, FK→employees |
| `company_policies` | Vector | Title, content text, 384‑d embedding (pgvector) |

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd rag-agent
npm install
```

### 2. Environment Variables

Copy `.env.local` and fill in your keys:

```bash
# .env.local
DEEPSEEK_API_KEY=sk-your-deepseek-api-key

NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # service_role key (bypasses RLS)
```

### 3. Supabase Setup

Open your Supabase project → **SQL Editor** and run these scripts in order:

1. **`init_database.sql`** — Creates tables + seeds 5 employees, 5 tickets, 5 policy texts
2. **`init_vector_search.sql`** — Creates the `search_policies` RPC function for pgvector search

> **Note:** Your `SUPABASE_SERVICE_ROLE_KEY` must be the **service_role** key (JWT with `"role":"service_role"`), not the anon key. Find it in Supabase Dashboard → Project Settings → API.

### 4. Run the Ingestion Script

This chunks the policy document, generates embeddings locally, and stores them in Supabase:

```bash
npm run ingest
```

> First run downloads `all-MiniLM-L6-v2` (~80 MB) and caches it locally. Subsequent runs are instant.

### 5. Start Dev Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Available Scripts

```bash
npm run dev      # Start Next.js dev server
npm run build    # Production build
npm run start    # Start production server
npm run ingest   # Vectorize policies and write to Supabase
```

## Project Structure

```
rag-agent/
├── app/
│   ├── api/chat/route.ts          # Agent route — tools, streaming, DeepSeek
│   ├── components/
│   │   ├── ChatHeader.tsx         # Brand header bar
│   │   ├── ChatMessage.tsx        # Message bubble (user / assistant)
│   │   ├── ChatInput.tsx          # Input bar + send button
│   │   ├── EmptyState.tsx         # Welcome screen
│   │   └── LoadingBubble.tsx      # Animated typing indicator
│   ├── lib/
│   │   ├── embeddings.ts          # Embedding model lazy singleton
│   │   ├── env.ts                 # Centralized env with lazy validation
│   │   ├── messages.ts            # UIMessage text extraction helper
│   │   ├── supabase.ts            # Server-side Supabase client
│   │   └── tool-helpers.ts        # Unified error handling for tools
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
├── scripts/
│   └── ingest.ts                  # CLI: chunk → embed → store policies
├── docs/                          # Phase review & decision docs
├── init_database.sql              # DB schema + seed data
├── init_vector_search.sql         # pgvector RPC function
├── init_rls.sql                   # Row Level Security config
├── next.config.js
├── tailwind.config.js
├── tsconfig.json
└── .env.local
```

## License

MIT

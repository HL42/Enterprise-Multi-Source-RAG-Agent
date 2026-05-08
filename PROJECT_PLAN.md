# Enterprise HR/IT Support Agent (企业内部支持智能体)

## 1. 项目定位

一个能够处理多源异构数据（PDF 规章 + SQL 数据库）的企业级 RAG Agent。展示 Agentic Tool Calling (智能体工具调用) 和流式输出 (Streaming) 能力。

## 2. 技术栈

- **前端/框架**: Next.js 14 (App Router), TypeScript, Tailwind CSS, shadcn/ui
- **AI 编排**: Vercel AI SDK (@ai-sdk/deepseek)
- **大模型**: DeepSeek API (意图路由与生成)
- **向量化 (Embedding)**: @xenova/transformers (本地免费运行, 不使用外部 API)
- **数据库**: Supabase (PostgreSQL + pgvector)

## 3. 核心功能库

- **Tool 1 (RAG)**: 检索 `company_policies` 向量表（模拟员工手册）。
- **Tool 2 (SQL)**: 查询 `employees` 和 `it_tickets` 关系型表（模拟系统数据）。

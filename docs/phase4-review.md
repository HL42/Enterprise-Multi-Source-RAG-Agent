# Phase 4 复盘：Agentic Tool Calling — 从聊天机器人到智能体

---

## 本 Phase 交付了什么

Phase 4 是项目的分水岭——把 Phase 3 的"你说一句我回一句"聊天机器人，升级成了能主动查数据库、搜知识库的智能体。具体做了五件事：

### 1. 创建了两个基础设施模块

| 文件 | 职责 |
|---|---|
| `app/lib/supabase.ts` | 服务端 Supabase 客户端单例（service_role key，可读写） |
| `app/lib/embeddings.ts` | Embedding 模型懒加载单例，带并发保护（`loadingPromise` 防止多个请求同时触发下载） |

`embeddings.ts` 的关键设计：第一次调用 `getEmbedding()` 时下载并加载 ONNX 模型（~80MB），后续调用复用同一实例。用 `loadingPromise` 做并发门控——如果第二个请求在模型加载期间到达，它复用第一个请求的 Promise 而不是再启动一次下载。

### 2. 重写了 `app/api/chat/route.ts`：从 11 行到 150 行

核心变化：

| 对比维度 | Phase 3 (简单聊天) | Phase 4 (Agent) |
|---|---|---|
| 代码行数 | 11 行 | ~150 行 |
| Runtime | `edge` | `nodejs`（@xenova 需原生模块） |
| System Prompt | 无 | 完整角色设定 + 工具使用指南 |
| Tool 定义 | 无 | 2 个 tool，含 zod schema + execute |
| 数据流 | 用户 → DeepSeek | 用户 → DeepSeek → Tool → Supabase → DeepSeek → 用户 |

### 3. 实现了 search_company_policy 工具

完整的 RAG 检索链路：
```
用户提问 "出差去上海住宿能报多少"
       ↓
DeepSeek 识别意图 → 调用 search_company_policy({ query: "出差去上海住宿能报多少" })
       ↓
execute() 触发:
  ① getEmbedding(query) → 384 维向量
  ② supabase.rpc("search_policies", { query_embedding, match_count: 3 })
  ③ pgvector 执行 <=> 余弦距离排序 → Top 3
       ↓
返回 [{ title, content, similarity }, ...] → 喂回 DeepSeek
       ↓
DeepSeek 基于检索到的政策文本生成准确回答
```

### 4. 实现了 query_employee_data 工具

精确查询链路：
```
用户提问 "张伟的 IT 工单有哪些"
       ↓
DeepSeek 识别意图 → 调用 query_employee_data({ employeeName: "张伟", queryType: "tickets" })
       ↓
execute() 触发:
  ① supabase.from("employees").select().ilike("name", "%张伟%") → 得到 employee.id
  ② supabase.from("it_tickets").select().eq("employee_id", id)
  ③ 按 created_at 倒序排列
       ↓
返回 { employee, tickets[], total } → 喂回 DeepSeek
       ↓
DeepSeek 将原始 JSON 整理成可读的工单列表
```

### 5. 创建了 `init_vector_search.sql`

在 Supabase SQL Editor 中执行此脚本，创建 `search_policies` 存储函数——将 `<=>`（余弦距离运算符）封装为可直接通过 `supabase.rpc()` 调用的函数。

---

## 一、大模型是如何知道"何时该调 RAG，何时该调 SQL"的？

### 一句话：工具描述（Tool Description）就是函数的"招聘启事"，大模型看描述自行判断该调用谁。

### 底层机制：Function Calling 是模型的原生能力

DeepSeek（以及 GPT-4、Claude 等所有支持 Function Calling 的模型）在训练时就被喂了大量"带函数定义的对话"数据。推理时，它的工作流程是：

```
用户消息 + System Prompt + 历史对话 + 工具清单（含 description + 参数 schema）
       ↓
   [DeepSeek 的每一层 Transformer 处理]
       ↓
两个决策并行输出:
  A. 文本回复（如 "让我帮你查一下..."）
  B. 工具调用 (tool_call: { name: "search_company_policy", arguments: { query: "..." } })
```

这里的**工具清单**就是关键。我们传给 `streamText` 的 `tools` 对象会被 AI SDK 自动转换为 OpenAI-compatible 的 Function Calling 格式发送给 DeepSeek API。模型看到的是：

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search_company_policy",
        "description": "在《公司报销管理制度》等内部规章制度中做语义搜索。当用户询问报销标准、考勤规则、年假政策、出差住宿标准等政策类问题时，调用此工具。",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string",
              "description": "用户的原始问题，将直接用做语义搜索的查询文本"
            }
          },
          "required": ["query"]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "query_employee_data",
        "description": "查询员工个人信息或 IT 工单。当用户询问某位员工属于哪个部门、职位、或有哪些 IT 工单时，调用此工具。",
        "parameters": {
          "type": "object",
          "properties": {
            "employeeName": { "type": "string", "description": "员工中文姓名，例如：张伟、李娜" },
            "queryType": { "type": "string", "enum": ["info", "tickets"], "description": "查询类型..." }
          },
          "required": ["employeeName", "queryType"]
        }
      }
    }
  ]
}
```

模型看到这些后，通过语义匹配做决策：

| 用户输入 | 模型匹配到的 key phrase | 调用的工具 |
|---|---|---|
| "出差住宿能报销多少？" | "出差住宿标准" 命中 search_company_policy 的 description | `search_company_policy` |
| "年假能跨年累积吗？" | "年假政策" 命中 search_company_policy 的 description | `search_company_policy` |
| "张伟是哪个部门的？" | "员工"+"部门" 命中 query_employee_data | `query_employee_data({ queryType: "info" })` |
| "李娜有哪些 IT 工单？" | "员工"+"IT 工单" 命中 query_employee_data | `query_employee_data({ queryType: "tickets" })` |
| "今天天气怎么样？" | 和所有工具都不相关 | 不调工具，直接回复 |

**这不是 if-else 字符串匹配，而是 Transformer 的语义理解——模型真的"读懂了" tool description 的含义。**

### System Prompt 也在辅助决策

我们写的 System Prompt 明确列出了每个工具的适用场景和示例关键词，这进一步降低了模型选错工具的概率。在实践中，System Prompt + Tool Description 双重引导是 Function Calling 成功率的关键。

---

## 二、Agentic Workflow 与传统 if-else 的工程差距

### 传统 if-else 做法是什么样的

假设不用 LLM Function Calling，要实现"自动判断查政策还是查员工"，代码大概长这样：

```python
def route(user_input: str):
    if any(kw in user_input for kw in ["报销", "考勤", "年假", "出差", "政策", "制度", "规定"]):
        return search_policy(user_input)
    elif any(kw in user_input for kw in ["工单", "部门", "职位", "电话", "邮箱"]):
        return query_employee(user_input)
    elif "张伟" in user_input or "李娜" in user_input or "王磊" in user_input:
        return query_employee(user_input)
    else:
        return chat(user_input)
```

这有几个致命问题：

**① 关键词列表永远不完整。** 用户说"我想知道公司对笔记本外带有什么要求"，关键词里没有"外带"也没有"笔记本"，直接掉进 else 分支给了一个聊天回复。

**② 员工名单硬编码。** 新增 100 个员工，代码需要更新 100 次。

**③ 意图交叉时无法处理。** "张伟的年假还剩几天？"——既有"张伟"（员工名）又有"年假"（政策）。if-else 只能选一个分支，但正确答案是先查员工信息再查年假政策，甚至需要两步工具调用。

**④ 规则越加越多，代码腐烂。** 3 个关键词变 30 个，变 300 个。维护这个 if-else 的成本很快超过重写。

### Agentic Workflow 的优势

**① 语义理解替代关键词匹配。** 模型真正理解"笔记本外带"是 IT 设备使用规范的一部分，即使这些词不在 description 里，它也能正确路由到 `search_company_policy`。

**② 工具和意图解耦。** 新增一个工具（比如"查会议室预定"）只需在 `tools` 对象里加一条定义，不用改任何路由逻辑。模型会自动学会何时调用它。

**③ 支持多步推理。** 当用户说"张伟提交的紧急工单有哪些？去年假报销标准是多少？"，模型可以：
- 第一轮：调 `query_employee_data({ employeeName: "张伟", queryType: "tickets" })`
- 拿到结果后，自动发起第二轮：`search_company_policy({ query: "年假报销标准" })`
- 最后把两个结果整合成一条回复

这在 AI SDK v6 里是原生支持的——`streamText` 会自动处理 tool call → execute → feed result back → check if another tool call → generate final response 这个循环。工程师不需要写任何循环逻辑。

**④ 多语言、多表达方式天然支持。** 用户用"俺想问问出差住店能给多少钱"这种口语化表达，模型一样理解。if-else 的规则列表在这种输入面前直接失能。

### 一句话总结

传统 if-else 是程序员在代码里枚举世界状态的穷举法。Agentic Tool Calling 是让 LLM 自己决定"我现在需要什么信息、应该调用什么工具"——这从"状态机"思维升级到了"认知决策"思维。代码从几百行的意图路由变成两个 tool 定义，维护成本降低两个数量级。

import {
  streamText,
  tool,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from "ai";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import { supabase } from "@/app/lib/supabase";
import { getEmbedding } from "@/app/lib/embeddings";
import { ToolError, withToolErrorHandling } from "@/app/lib/tool-helpers";

// 必须用 Node.js Runtime：@xenova/transformers 依赖 onnxruntime-node 原生模块
export const runtime = "nodejs";
// Agentic Workflow 含工具调用往返，给足时长
export const maxDuration = 60;

// ---------- Supabase 行类型（手动维护，避免 any）----------
interface PolicySearchRow {
  id: string;
  title: string;
  content: string;
  category: string;
  similarity: number;
}

interface EmployeeRow {
  id: string;
  name: string;
  department: string;
  position: string;
  email: string;
  phone: string | null;
  hire_date: string;
}

interface TicketRow {
  id: string;
  title: string;
  category: string;
  status: string;
  priority: string;
  created_at: string;
}

const SYSTEM_PROMPT = `你是"企业内部支持智能体"，负责回答员工的 HR 和 IT 相关问题。

你有两个工具可用，请根据用户问题的类型选择调用：

1. **search_company_policy** — 当用户询问公司规章制度、报销标准、考勤政策、年假规则等政策类问题时调用。这个工具会在知识库中做语义搜索。
2. **query_employee_data** — 查询员工个人信息或 IT 工单。支持三种模式：
   - queryType: "info" — 查员工个人信息（部门、职位等），此时 employeeName 必填
   - queryType: "tickets" — 查某位员工的所有 IT 工单，此时 employeeName 必填
   - queryType: "all_tickets" — 查全公司所有 IT 工单列表，此时无需传 employeeName（传空字符串即可）

规则：
- 如果用户问的是规章制度，调 search_company_policy，然后把检索到的政策内容整理成清晰的中文回答。
- 如果用户问的是某位员工的个人数据或工单，调 query_employee_data，然后把查询结果整理成表格或列表。
- 如果用户问的是"所有工单""全公司工单""有哪些人在提工单"这类全局问题，调 query_employee_data 的 all_tickets 模式。
- 如果用户的问题和上述都无关（比如闲聊），直接友好回复，不要调工具。
- 禁止编造数据，所有回答必须基于工具返回的真实数据。`;

export async function POST(req: Request) {
  let messages: UIMessage[];
  try {
    const body = await req.json();
    messages = (body as { messages: UIMessage[] }).messages ?? [];
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }

  // useChat 发来 UIMessage（parts 数组），streamText 需要 ModelMessage（content 字符串）
  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: deepseek("deepseek-chat"),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    stopWhen: stepCountIs(5), // 默认 stepCountIs(1)，工具调用后不续推；此处允许最多 5 轮
    onError: (event) => {
      // 模型调用失败（429 / 5xx / 网络中断）：打印服务端日志，错误会经 SSE 传到前端
      console.error("[streamText] 模型错误:", event.error);
    },
    onStepFinish: (event) => {
      console.log(`\n📡 [stream step]`);
      console.log(`   文本: "${event.text}"`);
      event.toolCalls.forEach((tc) =>
        console.log(
          `   🔨 工具调用: ${tc.toolName}(${JSON.stringify(tc.input)})`,
        ),
      );
      event.toolResults.forEach((tr) =>
        console.log(
          `   📦 工具结果: ${JSON.stringify(tr.output).slice(0, 200)}...`,
        ),
      );
      if (event.finishReason) {
        console.log(`   🏁 结束原因: ${event.finishReason}`);
      }
    },
    tools: {
      search_company_policy: tool({
        description:
          "在《公司报销管理制度》等内部规章制度中做语义搜索。当用户询问报销标准、考勤规则、年假政策、出差住宿标准等政策类问题时，调用此工具。",
        inputSchema: z.object({
          query: z
            .string()
            .describe("用户的原始问题，将直接用做语义搜索的查询文本"),
        }),
        execute: ({ query }) =>
          withToolErrorHandling("search_policy", async () => {
            console.log(`\n🔧 [tool:search_policy] 被调用, query="${query}"`);
            const embedding = await getEmbedding(query);
            console.log(`   embedding 维度: ${embedding.length}`);

            const { data, error } = await supabase.rpc("search_policies", {
              query_embedding: embedding,
              match_count: 3,
            });

            if (error) {
              throw new Error(`RPC 失败: ${error.message}`);
            }

            const rows = (data as PolicySearchRow[] | null) ?? [];
            console.log(`   ✅ 命中 ${rows.length} 条`);

            if (rows.length === 0) {
              return {
                found: 0,
                message:
                  "知识库中未检索到相关政策内容，请换一种提问方式，或该政策可能尚未录入系统。请勿编造政策，直接告知用户无相关记录。",
                policies: [],
              };
            }

            return {
              found: rows.length,
              policies: rows.map((row) => ({
                title: row.title,
                content: row.content,
                similarity: row.similarity,
              })),
            };
          }),
      }),

      query_employee_data: tool({
        description:
          "查询员工个人信息或 IT 工单。当用户询问某位员工属于哪个部门、职位、或有哪些 IT 工单时，调用此工具。",
        inputSchema: z.object({
          employeeName: z.string().describe("员工中文姓名，例如：张伟、李娜"),
          queryType: z
            .enum(["info", "tickets", "all_tickets"])
            .describe("查询类型：info 查人事信息，tickets 查某员工工单，all_tickets 查全公司所有工单"),
        }),
        execute: ({ employeeName, queryType }) =>
          withToolErrorHandling("query_employee", async () => {
            console.log(
              `\n🔧 [tool:query_employee] 被调用, name="${employeeName}", type=${queryType}`,
            );

            // all_tickets：查全公司所有工单，不需要查员工
            if (queryType === "all_tickets") {
              const { data: allTickets, error: allErr } = await supabase
                .from("it_tickets")
                .select("id, title, category, status, priority, created_at, employee_id")
                .order("created_at", { ascending: false });

              if (allErr) throw new Error(`全公司工单查询失败: ${allErr.message}`);

              const rows = (allTickets as (TicketRow & { employee_id: string })[] | null) ?? [];
              console.log(`   ✅ 返回全公司 ${rows.length} 条工单`);

              // 关联查员工姓名
              const empIds = [...new Set(rows.map((t) => t.employee_id))];
              const { data: empMap } = await supabase
                .from("employees")
                .select("id, name")
                .in("id", empIds);
              const nameById = new Map((empMap ?? []).map((e: any) => [e.id, e.name]));

              return {
                type: "all_tickets" as const,
                total: rows.length,
                tickets: rows.map((t) => ({
                  title: t.title,
                  category: t.category,
                  status: t.status,
                  priority: t.priority,
                  employeeName: nameById.get(t.employee_id) ?? "未知",
                  createdAt: t.created_at,
                })),
              };
            }

            const { data: employees, error: empError } = await supabase
              .from("employees")
              .select("id, name, department, position, email, phone, hire_date")
              .ilike("name", `%${employeeName}%`)
              .limit(1);

            if (empError) {
              throw new Error(`员工查询失败: ${empError.message}`);
            }

            if (!employees || employees.length === 0) {
              throw new ToolError(
                `未找到员工「${employeeName}」，请确认姓名是否正确`,
              );
            }

            const employee = employees[0] as EmployeeRow;
            console.log(
              `   找到: ${employee.name} (${employee.department} ${employee.position})`,
            );

            if (queryType === "info") {
              return {
                type: "employee_info" as const,
                employee: {
                  name: employee.name,
                  department: employee.department,
                  position: employee.position,
                  email: employee.email,
                  phone: employee.phone,
                  hireDate: employee.hire_date,
                },
              };
            }

            const { data: tickets, error: ticketError } = await supabase
              .from("it_tickets")
              .select("id, title, category, status, priority, created_at")
              .eq("employee_id", employee.id)
              .order("created_at", { ascending: false });

            if (ticketError) {
              throw new Error(`工单查询失败: ${ticketError.message}`);
            }

            const ticketRows = (tickets as TicketRow[] | null) ?? [];
            console.log(`   ✅ 返回 ${ticketRows.length} 条工单`);
            return {
              type: "tickets" as const,
              employee: {
                name: employee.name,
                department: employee.department,
              },
              tickets: ticketRows.map((t) => ({
                title: t.title,
                category: t.category,
                status: t.status,
                priority: t.priority,
                createdAt: t.created_at,
              })),
              total: ticketRows.length,
              message:
                ticketRows.length === 0
                  ? `${employee.name} 目前没有任何 IT 工单记录，请如实告知用户。`
                  : undefined,
            };
          }),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}

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

export const runtime = "nodejs";
export const maxDuration = 60;

// ---------- Zod 校验：替代硬断言，Schema 变动时精准报错 ----------

const PolicySearchRow = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  category: z.string(),
  similarity: z.number(),
});

const EmployeeRow = z.object({
  id: z.string(),
  name: z.string(),
  department: z.string(),
  position: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  hire_date: z.string(),
});

const TicketRow = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  status: z.string(),
  priority: z.string(),
  created_at: z.string(),
  employee_id: z.string().optional(),
});

const SYSTEM_PROMPT = `你是"企业内部支持智能体"，负责回答员工的 HR 和 IT 相关问题。

你有两个工具可用，请根据用户问题的类型选择调用：

1. **search_company_policy** — 当用户询问公司规章制度、报销标准、考勤政策、年假规则等政策类问题时调用。
   重要：调用前必须将用户的自然语言问题提炼为简洁的搜索关键词（≤20 字），再赋给 query 参数。例如：
   - 用户说"俺想问下出差住店能给多少钱" → query="出差住宿报销标准"
   - 用户说"笔记本丢了要怎么处理" → query="IT设备丢失处理流程"
   - 用户说"一年能有几天带薪假啊" → query="年假天数制度"

2. **query_employee_data** — 查询员工信息或 IT 工单。支持三种模式：
   - queryType: "info" — 查员工个人信息。可通过 employeeName 或 email 定位员工
   - queryType: "tickets" — 查某位员工的 IT 工单。可通过 employeeName 或 email 定位员工
   - queryType: "all_tickets" — 查全公司所有 IT 工单列表

规则：
- 用户问规章制度 → 提炼关键词 → 调 search_company_policy → 整理成清晰的中文回答
- 用户问员工数据/工单 → 调 query_employee_data → 整理成表格或列表
- 用户问所有工单 → 调 query_employee_data(all_tickets)
- 闲聊问题 → 直接友好回复，不调工具
- 禁止编造数据，所有回答必须基于工具返回的真实数据`;

export async function POST(req: Request) {
  let messages: UIMessage[];
  try {
    const body = await req.json();
    messages = (body as { messages: UIMessage[] }).messages ?? [];
  } catch {
    return Response.json({ error: "请求格式错误" }, { status: 400 });
  }

  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: deepseek("deepseek-chat"),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    stopWhen: stepCountIs(5),
    onError: (event) => console.error("[streamText] 模型错误:", event.error),
    onStepFinish: (event) => {
      console.log(`\n📡 [stream step] 文本: "${event.text?.slice(0, 80)}"`);
      event.toolCalls.forEach((tc) =>
        console.log(`   🔨 ${tc.toolName}(${JSON.stringify(tc.input)})`),
      );
      if (event.finishReason) console.log(`   🏁 ${event.finishReason}`);
    },
    tools: {
      search_company_policy: tool({
        description:
          "在内部规章制度知识库中做语义搜索。调用前必须将用户的自然语言问题提炼为简洁的搜索关键词。",
        inputSchema: z.object({
          query: z
            .string()
            .describe("提炼后的搜索关键词，≤20 字，直接用于语义匹配"),
        }),
        execute: ({ query }) =>
          withToolErrorHandling("search_policy", async () => {
            console.log(`\n🔧 [tool:search_policy] query="${query}"`);
            const embedding = await getEmbedding(query);

            const { data, error } = await supabase.rpc("search_policies", {
              query_embedding: embedding,
              match_count: 3,
            });

            if (error) throw new Error(`RPC 失败: ${error.message}`);

            const rows = z.array(PolicySearchRow).parse(data ?? []);
            console.log(`   ✅ 命中 ${rows.length} 条`);

            if (rows.length === 0) {
              return {
                found: 0,
                message: "知识库中未检索到相关政策内容。请勿编造政策，直接告知用户无相关记录。",
                policies: [],
              };
            }

            return {
              found: rows.length,
              policies: rows.map((r) => ({
                title: r.title,
                content: r.content,
                similarity: r.similarity,
              })),
            };
          }),
      }),

      query_employee_data: tool({
        description:
          "查询员工个人信息或 IT 工单。支持按姓名或邮箱定位员工。",
        inputSchema: z.object({
          employeeName: z
            .string()
            .optional()
            .describe("员工中文姓名，例如：张伟。与 email 至少传一个（all_tickets 除外）"),
          email: z
            .string()
            .optional()
            .describe("员工邮箱，精确匹配。与 employeeName 至少传一个（all_tickets 除外）"),
          queryType: z
            .enum(["info", "tickets", "all_tickets"])
            .describe("info/人事, tickets/某员工工单, all_tickets/全公司工单"),
        }),
        execute: ({ employeeName, email, queryType }) =>
          withToolErrorHandling("query_employee", async () => {
            const label = employeeName ?? email ?? "全公司";
            console.log(`\n🔧 [tool:query_employee] ${label} type=${queryType}`);

            // ---- all_tickets ----
            if (queryType === "all_tickets") {
              const { data, error } = await supabase
                .from("it_tickets")
                .select("id, title, category, status, priority, created_at, employee_id")
                .order("created_at", { ascending: false });

              if (error) throw new Error(`查询失败: ${error.message}`);

              const rows = z.array(TicketRow).parse(data ?? []);
              console.log(`   ✅ 全公司 ${rows.length} 条工单`);

              const empIds = [...new Set(rows.map((t) => t.employee_id).filter(Boolean))];
              const { data: empData } = await supabase
                .from("employees")
                .select("id, name")
                .in("id", empIds);
              const nameById = new Map((empData ?? []).map((e: any) => [e.id, e.name]));

              return {
                type: "all_tickets" as const,
                total: rows.length,
                tickets: rows.map((t) => ({
                  title: t.title,
                  category: t.category,
                  status: t.status,
                  priority: t.priority,
                  employeeName: nameById.get(t.employee_id!) ?? "未知",
                  createdAt: t.created_at,
                })),
              };
            }

            // ---- info / tickets：按姓名或邮箱查员工 ----
            if (!employeeName && !email) {
              throw new ToolError("请提供员工姓名或邮箱以便查询。");
            }

            let query = supabase
              .from("employees")
              .select("id, name, department, position, email, phone, hire_date")
              .limit(5); // 最多返回 5 条，超过则提示歧义

            if (email) {
              query = query.eq("email", email);
            }
            if (employeeName) {
              query = query.ilike("name", `%${employeeName}%`);
            }

            const { data: employees, error: empError } = await query;

            if (empError) throw new Error(`员工查询失败: ${empError.message}`);

            if (!employees || employees.length === 0) {
              throw new ToolError(
                `未找到匹配的员工。请确认姓名或邮箱是否正确。`,
              );
            }

            if (employees.length > 1) {
              const names = employees.map((e: any) => `${e.name} (${e.department} ${e.position})`).join("、");
              throw new ToolError(
                `找到 ${employees.length} 位匹配的员工：${names}。请让用户选择具体的员工姓名或提供邮箱。`,
              );
            }

            const emp = EmployeeRow.parse(employees[0]);
            console.log(`   找到: ${emp.name} (${emp.department})`);

            if (queryType === "info") {
              return {
                type: "employee_info" as const,
                employee: {
                  name: emp.name,
                  department: emp.department,
                  position: emp.position,
                  email: emp.email,
                  phone: emp.phone,
                  hireDate: emp.hire_date,
                },
              };
            }

            // tickets
            const { data: tickets, error: tErr } = await supabase
              .from("it_tickets")
              .select("id, title, category, status, priority, created_at")
              .eq("employee_id", emp.id)
              .order("created_at", { ascending: false });

            if (tErr) throw new Error(`工单查询失败: ${tErr.message}`);

            const ticketRows = z.array(TicketRow).parse(tickets ?? []);
            console.log(`   ✅ ${ticketRows.length} 条工单`);

            return {
              type: "tickets" as const,
              employee: { name: emp.name, department: emp.department },
              tickets: ticketRows.map((t) => ({
                title: t.title,
                category: t.category,
                status: t.status,
                priority: t.priority,
                createdAt: t.created_at,
              })),
              total: ticketRows.length,
            };
          }),
      }),
    },
  });

  return result.toUIMessageStreamResponse();
}

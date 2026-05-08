/**
 * Vercel AI SDK Tool 执行的统一错误处理封装。
 *
 * 设计目标：
 * 1. 让 tool body 只关心 happy path，try/catch 不再散落到每个 tool。
 * 2. 用户可见的错误（如"找不到员工"）通过抛 ToolError 表达，HOF 会原样返回给模型。
 * 3. 未预期的异常（数据库挂了、SDK bug 等）统一兜底为「工具执行异常」并打印 stack。
 */

export class ToolError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "ToolError";
  }
}

export type ToolErrorEnvelope = { error: string };

export async function withToolErrorHandling<T>(
  toolName: string,
  fn: () => Promise<T>,
): Promise<T | ToolErrorEnvelope> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError) {
      console.warn(`   ⚠️ [tool:${toolName}]`, e.userMessage);
      return { error: e.userMessage };
    }
    const message = e instanceof Error ? e.message : String(e);
    if (message === "EMBEDDING_TIMEOUT") {
      console.warn(`   ⏱️ [tool:${toolName}] Embedding 模型加载超时`);
      return {
        error:
          "政策搜索服务正在初始化中，请稍后再试。在此期间，你可以问我员工数据或 IT 工单相关的问题。",
      };
    }
    console.error(`   ❌ [tool:${toolName}] 异常:`, message);
    if (e instanceof Error && e.stack) console.error(e.stack);
    return { error: `工具执行异常: ${message}` };
  }
}

import { isTextUIPart, isToolUIPart, type UIMessage } from "ai";

/**
 * 把 UIMessage.parts 里的 text 子项拼接成完整字符串。
 * Vercel AI SDK v6 把消息按 part 切分，文本可能分散在多个 TextUIPart 中。
 */
export function getMessageText(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((p) => p.text)
    .join("");
}

/**
 * 取出消息中的所有 tool 相关 part（含 static 和 dynamic）。
 * 用于在 UI 中渲染"工具调用"提示气泡。
 */
export function getToolParts(message: UIMessage) {
  return message.parts.filter(isToolUIPart);
}

/**
 * 工具内部 ID → 用户可见的中文名映射。
 * 出现在 ToolInvocationBadge 上。
 */
export const TOOL_LABELS: Record<string, string> = {
  search_company_policy: "搜索公司制度",
  query_employee_data: "查询员工数据",
};

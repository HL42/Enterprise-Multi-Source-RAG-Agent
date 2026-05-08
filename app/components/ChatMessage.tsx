import type { UIMessage } from "ai";
import { getMessageText, getToolParts } from "@/app/lib/messages";
import { ToolInvocationBadge } from "./ToolInvocationBadge";

interface ChatMessageProps {
  message: UIMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const text = getMessageText(message);
  const toolParts = getToolParts(message);

  // 完全空消息（既无 text 又无 tool 调用）：不渲染。
  if (!text && toolParts.length === 0) return null;

  const isUser = message.role === "user";

  return (
    <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
      {/* 工具调用气泡：仅 assistant 端可能出现 */}
      {!isUser && toolParts.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {toolParts.map((part) => (
            <ToolInvocationBadge
              key={part.toolCallId ?? `${part.type}-${part.state}`}
              type={part.type}
              state={part.state}
              toolName={"toolName" in part ? part.toolName : undefined}
              errorText={
                "errorText" in part && typeof part.errorText === "string"
                  ? part.errorText
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {text && (
        <div
          className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? "bg-zinc-100 text-zinc-900"
              : "bg-zinc-800/60 text-zinc-200"
          }`}
        >
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      )}
    </div>
  );
}

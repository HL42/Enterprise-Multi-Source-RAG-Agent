import { TOOL_LABELS } from "@/app/lib/messages";

interface ToolInvocationBadgeProps {
  /** UIMessagePart.type — 形如 "tool-search_company_policy" 或 "dynamic-tool" */
  type: string;
  /** UIMessagePart.state — input-streaming / input-available / output-available / output-error / ... */
  state: string;
  toolName?: string;
  errorText?: string;
}

export function ToolInvocationBadge({
  type,
  state,
  toolName,
  errorText,
}: ToolInvocationBadgeProps) {
  const rawName =
    type.startsWith("tool-") ? type.slice("tool-".length) : (toolName ?? type);
  const label = TOOL_LABELS[rawName] ?? rawName;

  const isRunning = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";
  const isError = state === "output-error";

  const icon = isError ? "❌" : isDone ? "✅" : "🔧";
  const tail = isRunning ? "进行中…" : isError ? "失败" : "完成";

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${
        isError
          ? "border-red-500/40 bg-red-500/10 text-red-300"
          : isDone
            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            : "border-zinc-700 bg-zinc-800/60 text-zinc-300"
      }`}
    >
      <span>{icon}</span>
      <span className="font-medium">{label}</span>
      <span className="text-zinc-500">·</span>
      <span>{tail}</span>
      {isError && errorText && (
        <span className="ml-1 truncate text-zinc-400 max-w-[18rem]">
          {errorText}
        </span>
      )}
    </div>
  );
}

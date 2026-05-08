export function ChatHeader() {
  return (
    <header className="flex items-center gap-3 border-b border-zinc-800 py-4 shrink-0">
      <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/20 text-sm">
        ⚡
      </div>
      <div>
        <h1 className="text-sm font-semibold">企业内部支持智能体</h1>
        <p className="text-xs text-zinc-500">DeepSeek · 流式响应</p>
      </div>
    </header>
  );
}

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-zinc-800 text-xl">
        💬
      </div>
      <p className="text-sm font-medium text-zinc-300">
        你好，我是企业支持助手
      </p>
      <p className="mt-1 text-xs text-zinc-500">
        可以问我关于考勤、报销、IT 工单等问题
      </p>
    </div>
  );
}

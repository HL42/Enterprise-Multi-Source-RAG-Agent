export function LoadingBubble() {
  return (
    <div className="flex justify-start">
      <div className="rounded-2xl bg-zinc-800/60 px-5 py-3">
        <span className="inline-flex gap-1">
          <span className="size-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:0ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:150ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-zinc-500 [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
}

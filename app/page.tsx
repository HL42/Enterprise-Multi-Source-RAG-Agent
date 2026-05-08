"use client";

import { useChat } from "@ai-sdk/react";
import { useEffect, useRef, useState } from "react";
import { getMessageText } from "./lib/messages";
import { ChatHeader } from "./components/ChatHeader";
import { EmptyState } from "./components/EmptyState";
import { ChatMessage } from "./components/ChatMessage";
import { LoadingBubble } from "./components/LoadingBubble";
import { ChatInput } from "./components/ChatInput";

export default function ChatPage() {
  const { messages, sendMessage, status, error, clearError } = useChat();
  const [input, setInput] = useState("");

  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMsgCountRef = useRef(0);
  const isLoading = status === "submitted" || status === "streaming";

  // 新消息加入时 smooth scroll；streaming 过程中用 instant 避免多个动画互抢
  useEffect(() => {
    const isNewMessage = messages.length !== prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;
    bottomRef.current?.scrollIntoView({
      behavior: isNewMessage ? "smooth" : "instant",
    });
  }, [messages]);

  // 一旦 assistant 已经开始输出文字，跳点 loader 就冗余了
  const lastMsg = messages.at(-1);
  const showLoader =
    isLoading &&
    !(lastMsg?.role === "assistant" && getMessageText(lastMsg).length > 0);

  function handleSend() {
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  }

  return (
    <div className="mx-auto flex h-dvh max-w-2xl flex-col px-4">
      <ChatHeader />

      <section className="flex-1 space-y-5 overflow-y-auto py-6">
        {messages.length === 0 && <EmptyState />}

        {messages.map((m) => (
          <ChatMessage key={m.id} message={m} />
        ))}

        {showLoader && <LoadingBubble />}

        {error && (
          <div className="flex justify-start">
            <div className="flex items-start gap-2 max-w-[85%] rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              <span className="shrink-0">⚠️</span>
              <span className="flex-1">
                {error.message.includes("429")
                  ? "请求过于频繁，请稍后再试。"
                  : "AI 服务暂时不可用，请稍后重试。"}
              </span>
              <button
                onClick={clearError}
                className="shrink-0 ml-2 text-red-400 hover:text-red-200 transition-colors"
                aria-label="关闭错误提示"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </section>

      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSend}
        disabled={isLoading}
      />
    </div>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "企业内部支持智能体",
  description: "HR/IT 支持助手 — 基于 RAG 的企业知识库问答",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body className="bg-zinc-950 text-zinc-100 antialiased">{children}</body>
    </html>
  );
}

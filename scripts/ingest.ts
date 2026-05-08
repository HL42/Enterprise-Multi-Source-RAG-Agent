/**
 * 知识库向量化入库脚本（解耦版）
 *
 * 从 Supabase 拉取所有 embedding IS NULL 的 company_policies 记录，
 * 逐条切块 + 本地向量化 + 回写 embedding，不再依赖硬编码文本。
 *
 * 运行方式: npm run ingest  (或 npx tsx --env-file=.env.local scripts/ingest.ts)
 */

import { createClient } from "@supabase/supabase-js";
import { pipeline } from "@xenova/transformers";

// Node.js 20 没有原生 WebSocket，Supabase realtime 需要 polyfill
// ingest 脚本只用 REST API，但 createClient 仍会初始化 realtime 模块
if (typeof globalThis.WebSocket === "undefined") {
  try { (globalThis as any).WebSocket = require("ws"); } catch { /* 不阻塞 */ }
}

// ---------- 独立 env 读取（不依赖 app/lib/）----------

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "❌ 缺少环境变量。请确认 .env.local 已配置，或 shell 中已 export。\n" +
      "   NEXT_PUBLIC_SUPABASE_URL\n" +
      "   SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

const CHUNK_SIZE = 250;
const CHUNK_OVERLAP = 50;

// ---------- 切块 ----------

function chunkText(text: string): string[] {
  const rawParagraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const paragraphs: string[] = [];
  for (let i = 0; i < rawParagraphs.length; i++) {
    const p = rawParagraphs[i];
    if (/^#{1,3}\s/.test(p) && i + 1 < rawParagraphs.length) {
      paragraphs.push(p + "\n" + rawParagraphs[i + 1]);
      i++;
    } else {
      paragraphs.push(p);
    }
  }

  const chunks: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= CHUNK_SIZE) {
      chunks.push(para);
      continue;
    }
    let start = 0;
    while (start < para.length) {
      const end = Math.min(start + CHUNK_SIZE, para.length);
      let chunk = para.slice(start, end);
      if (end < para.length && chunk.length === CHUNK_SIZE) {
        const lastBreak = Math.max(
          chunk.lastIndexOf("。"),
          chunk.lastIndexOf("\n"),
          chunk.lastIndexOf("；"),
        );
        if (lastBreak > CHUNK_SIZE * 0.5) {
          chunk = chunk.slice(0, lastBreak + 1);
        }
      }
      chunks.push(chunk.trim());
      start += chunk.length - CHUNK_OVERLAP;
      if (chunk.length <= CHUNK_OVERLAP) break;
    }
  }
  return chunks;
}

// ---------- 主流程 ----------

async function main() {
  console.log("========== 知识库向量化入库 ==========\n");

  // 1. 拉取所有未向量化的 policies
  const { data: policies, error } = await supabase
    .from("company_policies")
    .select("id, title, content, category")
    .is("embedding", null);

  if (error) {
    console.error("❌ 查询失败:", error.message);
    process.exit(1);
  }

  if (!policies || policies.length === 0) {
    console.log("✅ 所有 company_policies 已有 embedding，无需处理。");
    return;
  }

  console.log(`发现 ${policies.length} 条待向量化记录\n`);

  // 2. 加载模型（单次）
  console.log("正在加载 embedding 模型 (首次运行下载 ~80MB)...");
  const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  console.log("模型就绪\n");

  // 3. 逐条处理
  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i];
    const label = `[${i + 1}/${policies.length}]`;
    console.log(`${label} "${policy.title}" — ${policy.content.length} 字符`);

    const chunks = chunkText(policy.content);
    console.log(`       切为 ${chunks.length} 块`);

    // 每块内容作为独立行插入（不覆盖原始 policy，新增行）
    for (const chunk of chunks) {
      const output = await extractor(chunk, { pooling: "mean", normalize: true });
      const embedding = Array.from(output.data as Float32Array);

      const { error: insErr } = await supabase.from("company_policies").insert({
        title: `${policy.title} — 块`,
        content: chunk,
        category: policy.category,
        embedding,
      });

      if (insErr) {
        console.error(`       ⚠️ 写入失败: ${insErr.message}`);
      }
    }

    // 删除原始无 embedding 行
    await supabase.from("company_policies").delete().eq("id", policy.id);

    console.log(`       ✅ 完成`);
  }

  console.log("\n========== 入库完毕 ==========");
}

main().catch((err) => {
  console.error("脚本异常:", err);
  process.exit(1);
});

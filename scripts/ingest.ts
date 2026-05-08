/**
 * 企业规章制度本地向量化入库脚本
 *
 * 运行方式:
 *   npx tsx scripts/ingest.ts
 *
 * 前置：在项目根 .env.local 中配置 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *      或在 shell 中 export 这两个变量。
 *
 * 首次运行会自动下载 all-MiniLM-L6-v2 模型 (~80MB ONNX)，缓存到本地后零网络。
 */

import { getSupabaseAdmin } from "../app/lib/supabase";
import { getEmbedding } from "../app/lib/embeddings";

// ----------------------------------------
// 配置
// ----------------------------------------

const CHUNK_SIZE = 250; // 每块最多 250 字符（all-MiniLM-L6-v2 上限 256 token）
const CHUNK_OVERLAP = 50; // 相邻块重叠 50 字符（20%），防止边界截断

// ----------------------------------------
// 1. 测试语料：公司报销制度（Markdown）
// ----------------------------------------

const RAW_POLICY = `# 公司报销管理制度 (2025 修订版)

## 第一章 总则

第一条 为规范公司报销流程、加强费用管控、保障员工合法权益，特制定本制度。

第二条 本制度适用于公司全体正式员工、实习生及外包驻场人员。

## 第二章 差旅报销

第三条 国内出差住宿标准：一线城市（北京、上海、广州、深圳）不超过 500 元/晚，其他城市不超过 350 元/晚，超出部分由个人承担。

第四条 出差交通费用实报实销。高铁二等座及以下无需事前审批，一等座和商务座须经部门总监邮件审批。

第五条 出差期间每日餐补为 80 元/天，无需发票，随工资发放。出差天数以出发日和返回日各算半天。

## 第三章 日常费用报销

第六条 办公用品采购单笔金额不超过 200 元的，由部门经理审批后自行购买并报销。单笔超过 200 元的，须通过行政部统一采购。

第七条 加班用餐报销标准为每人每餐 40 元，须附正规餐饮发票及加班审批截图。

第八条 市内交通费因公外出的，地铁/公交实报实销，网约车单次不超过 50 元，月累计不超过 500 元。

## 第四章 招待费

第九条 因业务需要宴请客户的，人均标准不超过 150 元。单次招待费超过 2000 元的，须提前一天书面申请并经 VP 审批。

第十条 商务礼品单件金额不超过 300 元，每年同一客户礼品累计不超过 1000 元。

## 第五章 报销流程

第十一条 所有报销须在费用发生之日起 5 个工作日内，通过 OA 系统提交报销单并上传原始凭证照片。

第十二条 报销单审批流程：部门经理 → 财务审核 → 总经理审批（单笔超过 5000 元的）。审批须在 3 个工作日内完成。

第十三条 每月 25 日为当月报销截止日，25 日之后提交的报销计入下月。报销款于次月 5 日统一发放至工资卡。

第十四条 虚报、伪造发票一经查实，按公司违纪处理，情节严重者予以辞退并追究法律责任。

## 第六章 附则

第十五条 本制度的最终解释权归财务部所有。如有疑问请联系财务主管陈静 (chenjing@company.cn)。

第十六条 本制度自发布之日起施行，原 2022 版报销制度同时废止。`;

// ----------------------------------------
// 2. 文本切块 (Chunking)
// ----------------------------------------

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const rawParagraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // 将 Markdown 标题与紧随其后的正文合并，避免标题成为孤块
  const paragraphs: string[] = [];
  for (let i = 0; i < rawParagraphs.length; i++) {
    const p = rawParagraphs[i];
    const isHeading = /^#{1,3}\s/.test(p);
    if (isHeading && i + 1 < rawParagraphs.length) {
      paragraphs.push(p + "\n" + rawParagraphs[i + 1]);
      i++;
    } else {
      paragraphs.push(p);
    }
  }

  const chunks: string[] = [];

  for (const para of paragraphs) {
    if (para.length <= chunkSize) {
      chunks.push(para);
      continue;
    }

    let start = 0;
    while (start < para.length) {
      const end = Math.min(start + chunkSize, para.length);
      let chunk = para.slice(start, end);

      // 尽量在句号/换行处断开，避免切碎语义
      if (end < para.length && chunk.length === chunkSize) {
        const lastBreak = Math.max(
          chunk.lastIndexOf("。"),
          chunk.lastIndexOf("\n"),
          chunk.lastIndexOf("；"),
        );
        if (lastBreak > chunkSize * 0.5) {
          chunk = chunk.slice(0, lastBreak + 1);
        }
      }

      chunks.push(chunk.trim());
      start += chunk.length - overlap;
      if (chunk.length <= overlap) break;
    }
  }

  return chunks;
}

// ----------------------------------------
// 3. 向量化（复用 app/lib/embeddings.ts）
// ----------------------------------------

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  console.log(`正在向量化 ${texts.length} 个文本块...\n`);

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    results.push(await getEmbedding(texts[i]));
    if ((i + 1) % 5 === 0 || i === texts.length - 1) {
      console.log(`  [${i + 1}/${texts.length}] 已完成...`);
    }
  }
  return results;
}

// ----------------------------------------
// 4. 存入 Supabase
// ----------------------------------------

async function storePolicies(chunks: string[], embeddings: number[][]) {
  const supabase = getSupabaseAdmin();

  console.log("\n清理旧数据...");
  await supabase.from("company_policies").delete().not("id", "is", null);

  console.log(`正在写入 ${chunks.length} 条向量数据...`);
  const rows = chunks.map((chunk, i) => ({
    title: `报销制度-块${i + 1}`,
    content: chunk,
    category: "财务",
    embedding: embeddings[i],
  }));

  const { error } = await supabase.from("company_policies").insert(rows);
  if (error) {
    console.error("写入失败:", error.message);
    throw error;
  }
  console.log(`写入成功! 共 ${rows.length} 条记录。`);
}

// ----------------------------------------
// 5. 主流程
// ----------------------------------------

async function main() {
  console.log("========== 企业规章制度向量化入库 ==========\n");
  console.log(`原始文本长度: ${RAW_POLICY.length} 字符`);
  console.log(
    `切块参数:   chunk_size=${CHUNK_SIZE}, overlap=${CHUNK_OVERLAP}\n`,
  );

  const chunks = chunkText(RAW_POLICY, CHUNK_SIZE, CHUNK_OVERLAP);
  console.log(`切块完成: ${chunks.length} 个块\n`);
  chunks.forEach((c, i) => {
    console.log(
      `  块${i + 1}: ${c.length} 字符 | ${c.slice(0, 40).replace(/\n/g, " ")}...`,
    );
    if (i > 0) {
      const prevEnd = chunks[i - 1].slice(-30);
      const currStart = c.slice(0, 30);
      console.log(`      ↳ 重叠 ← 上一块尾部: ...${prevEnd.replace(/\n/g, " ")}`);
      console.log(`      ↳ 重叠 → 当前块开头: ${currStart.replace(/\n/g, " ")}...`);
    }
  });

  console.log("\n");
  const embeddings = await generateEmbeddings(chunks);
  console.log(
    `\n向量化完成: ${embeddings.length} 个 ${embeddings[0].length} 维向量\n`,
  );

  await storePolicies(chunks, embeddings);

  console.log("\n========== 入库完毕 ==========");
  console.log(
    "可在 Supabase SQL Editor 中验证: SELECT id, title, content, embedding IS NOT NULL AS has_embedding FROM company_policies;",
  );
}

main().catch((err) => {
  console.error("脚本异常:", err);
  process.exit(1);
});

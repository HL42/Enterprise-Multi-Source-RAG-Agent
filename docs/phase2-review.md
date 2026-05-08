# Phase 2 复盘：本地向量化机制与切块策略

---

## 本 Phase 交付了什么

Phase 2 的目标是把"公司报销制度"这份企业规章文本，变成 `company_policies` 向量表里可检索的 embedding 数据。具体做了三件事：

### 1. 编写了测试语料 (1265 字符 Markdown)

在 `scripts/ingest.ts` 里硬编码了一份仿真的公司报销制度全文，包含 6 章 16 条，覆盖差旅、日常费用、招待费、报销流程等真实场景。这份语料就是 RAG 知识库的起点——后续 AI Agent 回答"出差住宿能报销多少""加班餐补怎么算"这类问题，都是从这些文本块里检索出来的。

### 2. 实现了文本切块 → 向量化 → 入库的完整流水线

这是一个零外部 API 调用的纯本地管线：

```
RAW_POLICY (1265 字符 Markdown)
    │
    ▼  chunkText()
16 个文本块 (chunk_size=250, overlap=50)
    │
    ▼  pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
16 个 384 维向量 (Tensor → number[])
    │
    ▼  supabase.from('company_policies').insert()
company_policies 表中新增 16 行，每行带 content + embedding
```

代码结构是五个清晰的函数，按职责拆分：
- `chunkText()` — 纯字符串处理，按段落切分 + 长段落滑动窗口 + 句号断点回退
- `generateEmbeddings()` — 调 ONNX 模型逐块推理，带进度日志
- `storePolicies()` — Supabase 写入，先清后插
- `main()` — 串联三步，打印每块内容和重叠区预览
- 全局错误兜底 `main().catch()`

### 3. 产出了这份复盘文档

本文档记录了两个关键设计决策的 WHY——为什么用本地推理而不是调 API、为什么切块参数是 250/50 而不是其他值。这些决策如果不写下来，两个月后回头看代码就会产生困惑。

---

## 一、@xenova/transformers 在本地运行的机制是什么？

### 本质：浏览器/Node.js 里的 ONNX 推理引擎

`@xenova/transformers` 并不是在本地跑一个 Python 进程，也不是调 Docker。它的运行链路如下：

```
你的 TypeScript 代码
       ↓
@xenova/transformers (JS 封装层)
       ↓
onnxruntime-web / onnxruntime-node (ONNX Runtime)
       ↓
all-MiniLM-L6-v2 模型权重文件 (ONNX 格式, ~80MB)
       ↓
CPU/GPU 推理 → 输出 384 维向量
```

**关键点拆解：**

1. **模型格式转换**：HuggingFace 上的 `sentence-transformers/all-MiniLM-L6-v2` 原始是 PyTorch 格式。Xenova 社区已经把它转换成了 ONNX（Open Neural Network Exchange）格式，并上传到了 HuggingFace Hub（`Xenova/all-MiniLM-L6-v2`）。

2. **ONNX Runtime**：这是微软开源的跨平台推理引擎，用 C++ 写成，有 Node.js binding（`onnxruntime-node`）。它优化了计算图，能在纯 CPU 上高效执行矩阵乘法——这恰好是 embedding 模型的主要操作。

3. **首次下载，后续零网络**：第一次运行 `pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` 时，脚本会从 HuggingFace CDN 下载 ONNX 模型文件（约 80MB），缓存到本机 `~/.cache/huggingface/` 或 `node_modules/@xenova/transformers/.cache/`。之后再运行，直接从本地缓存加载，**完全不产生任何网络请求**。

4. **Tokenizer 也是 JS 原生**：Xenova 团队用纯 JavaScript 重写了 BERT 的 WordPiece tokenizer，所以分词阶段也不需要调 Python。

### 它为你省下了哪些钱？

| 方案 | 单价 | 1000 次 embedding 成本 | 10 万次 embedding 成本 |
|---|---|---|---|
| **OpenAI `text-embedding-3-small`** | $0.02 / 1M token | ~$0.05 | ~$5 |
| **OpenAI `text-embedding-3-large`** | $0.13 / 1M token | ~$0.30 | ~$30 |
| **Cohere Embed** | $0.10 / 1M token | ~$0.25 | ~$25 |
| **@xenova/transformers (本地)** | **$0** | **$0** | **$0** |

更重要的是**无网络延迟**和**数据不出本机**：

- 调用 OpenAI Embedding API 每次需要 200-500ms 的网络往返；本地 ONNX 推理在同量级文本上只需 10-50ms。
- 你处理的"公司报销制度"属于企业内部文档。如果送到 OpenAI API，文本原文就会离开你的机器——这在企业合规上是一个风险点。本地运行意味着敏感文档始终在本地处理。

**唯一的成本是首次下载 80MB 模型文件 + 每次推理消耗的 CPU 时间。** 对于 your use case（几百条规章制度），这笔成本几乎为零。

---

## 二、文本切块（Chunking）的大小和重叠策略

### 我们选了 chunk_size=250, overlap=50（20%），为什么？

**首先是硬约束：模型输入上限。**

`all-MiniLM-L6-v2` 的 max sequence length 是 **256 token**。对于中文，一个汉字通常就是 1 个 token（WordPiece 对中文没有子词拆分）。所以 250 字符留了 6 个 token 的缓冲，确保不会因为特殊字符或标点超出上限导致截断。

**然后是检索质量：块不能太大，也不能太小。**

```
太小 (chunk < 100 字符):
  "出差住宿标准一线城市不超 500 元"
  → 用户问"我出差到上海能报销多少住宿费？"
  → 能匹配到，但块里没有"上海是一线城市"这个上下文，LLM 拿到后需要额外推断
  → 检索命中但信息不完整

合适 (chunk ≈ 250 字符):
  包含完整的第三条："国内出差住宿标准：一线城市（北京、上海、广州、
  深圳）不超过 500 元/晚，其他城市不超过 350 元/晚..."
  → 一条 chunk 包含完整语义：哪些城市、多少钱、什么条件
  → LLM 可以直接用这块内容生成准确回答

太大 (chunk > 500 字符):
  一个块塞进了第三、四、五条
  → 检索到的块里大部分内容跟用户问题不相关
  → embedding 被无关信息稀释，召回质量下降
  → 250 字符的语义精确度远好于 500 字符
```

**250 字符 ≈ 3-4 句中文**，恰好是一条完整制度的粒度，是语义表达的天然单位。

### Overlap 为什么是 50（20%）？

重叠解决一个问题：**关键信息恰好落在切块边界上被"切断"**。

举个实际例子——假设没有 overlap，严格按 250 切分我们的语料：

```
块 N:   "...审批须在 3 个工作日内完成。第十三条 每月 25 日为当月报销
         截止日，25 日之后提交的报销计入下月。报销款于次月 5 日统一发"
块 N+1: "放至工资卡。第十四条 虚报、伪造发票一经查实..."

问题：用户问"报销款什么时候到账？"
→ 答案"次月 5 日"在块 N 里
→ 但"放至工资卡"在块 N+1 里
→ 两块各缺失一部分，语义都是不完整的
```

加了 50 字符 overlap 后：

```
块 N:   "...审批须在 3 个工作日内完成。第十三条 每月 25 日为当月报销
         截止日，25 日之后提交的报销计入下月。报销款于次月 5 日统一发放至工资卡。"
块 N+1: "报销款于次月 5 日统一发放至工资卡。第十四条 虚报、伪造发票一经查实..."

结果：块 N 完整包含了"次月 5 日 + 发放至工资卡"这个完整语义
→ embedding 准确表达了"到账时间"的含义
→ 用户查询直接命中
```

**20% 是业界经验甜点**——大于 20%（比如 50%）会导致各 chunk 之间差异性变小，浪费存储和算力；小于 10% 则边界防护不足。在 250 块大小下，50 字符刚好覆盖一条中文短句，是合理的保险带。

### 脚本中还做了一个额外优化：尽量在句号/换行处断开

```typescript
const lastBreak = Math.max(
  chunk.lastIndexOf("。"),
  chunk.lastIndexOf("\n"),
  chunk.lastIndexOf("；")
);
if (lastBreak > chunkSize * 0.5) {
  chunk = chunk.slice(0, lastBreak + 1);
}
```

这确保我们不在一个句子的中间截断 chunk——宁愿让 chunk 稍短一些，也要保证每个 chunk 内部语义完整。毕竟 embedding 是按"整块文本"做池化平均的，半句话的向量和完整句子的向量，方向可能完全不同。

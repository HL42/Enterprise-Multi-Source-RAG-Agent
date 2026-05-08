import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const LOAD_TIMEOUT_MS = 25_000; // 模型下载冷启动最多等 25 秒

let extractor: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

export class EmbeddingTimeoutError extends Error {
  constructor() {
    super("EMBEDDING_TIMEOUT");
    this.name = "EmbeddingTimeoutError";
  }
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;

  if (!loadingPromise) {
    console.log(`[embedding] 正在加载 ${MODEL_ID} 模型...`);
    loadingPromise = pipeline("feature-extraction", MODEL_ID) as Promise<FeatureExtractionPipeline>;

    // 超时竞赛：模型下载太久 → 抛 EmbeddingTimeoutError
    loadingPromise = Promise.race([
      loadingPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new EmbeddingTimeoutError()), LOAD_TIMEOUT_MS),
      ),
    ]);
  }

  extractor = await loadingPromise;
  console.log("[embedding] 模型就绪");
  return extractor;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const extract = await getExtractor();
  const output = await extract(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

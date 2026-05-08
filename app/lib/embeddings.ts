import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

let extractor: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (!loadingPromise) {
    console.log(`[embedding] 正在加载 ${MODEL_ID} 模型...`);
    loadingPromise = pipeline(
      "feature-extraction",
      MODEL_ID,
    ) as Promise<FeatureExtractionPipeline>;
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

/**
 * @module SmartConnectionsService
 * Reads and queries the Obsidian Smart Connections plugin's embedding cache
 * at `<vault>/.smart-env/multi/*.ajson` and provides semantic search via a
 * locally-loaded ONNX embedding model.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "@huggingface/transformers";
import { BaseErrorCode, McpError } from "../../types-global/errors.js";
import { logger, RequestContext } from "../../utils/index.js";

export type EmbeddingKind = "source" | "block";

export interface StoredEmbedding {
  key: string;
  path: string;
  kind: EmbeddingKind;
  vec: Float32Array;
  text?: string;
  lines?: number[];
}

export interface SemanticHit {
  key: string;
  path: string;
  similarity: number;
}

export interface SemanticBlockHit extends SemanticHit {
  text?: string;
  lines?: number[];
}

type FeatureExtractor = (
  text: string,
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array }>;

export class SmartConnectionsService {
  private embeddings: StoredEmbedding[] | null = null;
  private embeddingsLoadedAt = 0;
  private pipelinePromise: Promise<FeatureExtractor> | null = null;
  private readonly storedModelName: string;

  constructor(
    private readonly vaultPath: string,
    private readonly onnxModelName: string,
    storedModelName?: string,
  ) {
    this.storedModelName = storedModelName ?? "TaylorAI/bge-micro-v2";
  }

  private async ensurePipeline(
    context: RequestContext,
  ): Promise<FeatureExtractor> {
    if (!this.pipelinePromise) {
      logger.info(
        `Loading Smart Connections embedding model: ${this.onnxModelName}`,
        context,
      );
      this.pipelinePromise = pipeline(
        "feature-extraction",
        this.onnxModelName,
      ) as unknown as Promise<FeatureExtractor>;
    }
    return this.pipelinePromise;
  }

  async loadEmbeddings(
    context: RequestContext,
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (!opts.force && this.embeddings) return;

    const multiDir = join(this.vaultPath, ".smart-env", "multi");
    let files: string[];
    try {
      files = (await readdir(multiDir)).filter((f) => f.endsWith(".ajson"));
    } catch (err) {
      const msg = `Failed to read Smart Connections cache at ${multiDir}: ${err instanceof Error ? err.message : String(err)}. Is the Smart Connections plugin installed and has it embedded at least one note?`;
      throw new McpError(BaseErrorCode.SERVICE_UNAVAILABLE, msg, context);
    }

    const loaded: StoredEmbedding[] = [];
    let skipped = 0;
    for (const file of files) {
      const fullPath = join(multiDir, file);
      try {
        const content = await readFile(fullPath, "utf-8");
        const entries = parseAjson(content);
        for (const [key, raw] of Object.entries(entries)) {
          const item = raw as Record<string, unknown>;
          const embeddings = item.embeddings as
            | Record<string, { vec?: number[] }>
            | undefined;
          const vecArray = embeddings?.[this.storedModelName]?.vec;
          if (!vecArray || !Array.isArray(vecArray)) continue;

          const vec = normalize(new Float32Array(vecArray));
          const kind: EmbeddingKind = key.startsWith("smart_sources:")
            ? "source"
            : "block";
          const storedPath = item.path as string | null | undefined;
          const path =
            storedPath && storedPath.length > 0
              ? storedPath
              : extractPathFromKey(key);
          loaded.push({
            key,
            path,
            kind,
            vec,
            text: (item.text as string | null | undefined) ?? undefined,
            lines: item.lines as number[] | undefined,
          });
        }
      } catch (err) {
        skipped++;
        logger.warning(
          `Failed to parse Smart Connections cache file ${file}: ${err instanceof Error ? err.message : String(err)}`,
          context,
        );
      }
    }

    this.embeddings = loaded;
    this.embeddingsLoadedAt = Date.now();
    logger.info(
      `Smart Connections: loaded ${loaded.length} embeddings from ${files.length} files (${skipped} skipped)`,
      context,
    );
  }

  private async encodeQuery(
    query: string,
    context: RequestContext,
  ): Promise<Float32Array> {
    const extractor = await this.ensurePipeline(context);
    const output = await extractor(query, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  async semanticSearch(
    query: string,
    limit: number,
    minSimilarity: number,
    context: RequestContext,
  ): Promise<SemanticHit[]> {
    await this.loadEmbeddings(context);
    const queryVec = await this.encodeQuery(query, context);

    const results: SemanticHit[] = [];
    for (const emb of this.embeddings!) {
      if (emb.kind !== "source") continue;
      const sim = dot(queryVec, emb.vec);
      if (sim >= minSimilarity) {
        results.push({ key: emb.key, path: emb.path, similarity: sim });
      }
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  async findRelated(
    filePath: string,
    limit: number,
    context: RequestContext,
  ): Promise<SemanticHit[]> {
    await this.loadEmbeddings(context);
    const targetKey = `smart_sources:${filePath}`;
    const target = this.embeddings!.find((e) => e.key === targetKey);
    if (!target) {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        `No Smart Connections embedding for '${filePath}'. The file may not exist in the vault or has not been embedded yet.`,
        context,
      );
    }

    const results: SemanticHit[] = [];
    for (const emb of this.embeddings!) {
      if (emb.kind !== "source" || emb.key === targetKey) continue;
      const sim = dot(target.vec, emb.vec);
      results.push({ key: emb.key, path: emb.path, similarity: sim });
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  async getContextBlocks(
    query: string,
    maxBlocks: number,
    minSimilarity: number,
    context: RequestContext,
  ): Promise<SemanticBlockHit[]> {
    await this.loadEmbeddings(context);
    const queryVec = await this.encodeQuery(query, context);

    const candidates: SemanticBlockHit[] = [];
    for (const emb of this.embeddings!) {
      if (emb.kind !== "block") continue;
      const sim = dot(queryVec, emb.vec);
      if (sim >= minSimilarity) {
        candidates.push({
          key: emb.key,
          path: emb.path,
          similarity: sim,
          text: emb.text,
          lines: emb.lines,
        });
      }
    }
    candidates.sort((a, b) => b.similarity - a.similarity);
    const top = candidates.slice(0, maxBlocks);

    // Hydrate text from disk for blocks that don't have it cached.
    const fileCache = new Map<string, string[]>();
    for (const block of top) {
      if (block.text || !block.path || !block.lines) continue;
      try {
        let lines = fileCache.get(block.path);
        if (!lines) {
          const full = await readFile(
            join(this.vaultPath, block.path),
            "utf-8",
          );
          lines = full.split("\n");
          fileCache.set(block.path, lines);
        }
        const [start, end] = block.lines;
        if (typeof start === "number" && typeof end === "number") {
          block.text = lines.slice(start - 1, end).join("\n");
        }
      } catch (err) {
        logger.warning(
          `Failed to hydrate block text for ${block.path}: ${err instanceof Error ? err.message : String(err)}`,
          context,
        );
      }
    }

    return top;
  }

  stats(): { loaded: boolean; sources: number; blocks: number; loadedAt: number } {
    if (!this.embeddings) {
      return { loaded: false, sources: 0, blocks: 0, loadedAt: 0 };
    }
    let sources = 0;
    let blocks = 0;
    for (const e of this.embeddings) {
      if (e.kind === "source") sources++;
      else blocks++;
    }
    return {
      loaded: true,
      sources,
      blocks,
      loadedAt: this.embeddingsLoadedAt,
    };
  }
}

function extractPathFromKey(key: string): string {
  const prefix = key.startsWith("smart_sources:")
    ? "smart_sources:"
    : key.startsWith("smart_blocks:")
      ? "smart_blocks:"
      : "";
  if (!prefix) return "";
  const rest = key.slice(prefix.length);
  const hashIdx = rest.indexOf("#");
  return hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
}

function parseAjson(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }
  return JSON.parse("{" + trimmed.replace(/,\s*$/, "") + "}");
}

function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

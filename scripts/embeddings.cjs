#!/usr/bin/env node
/**
 * embeddings.cjs
 * ─────────────────────────────────────────────
 * Embedding generation for the knowledge graph.
 *
 * Loads all-MiniLM-L6-v2 (384-dim) via @xenova/transformers.
 * Supports single/batch generation with SQLite + LRU caching.
 * Works offline after the first model download.
 *
 * Usage:
 *   node embeddings.cjs --text "query text"          # single embedding
 *   node embeddings.cjs --batch file.txt             # batch from file (one line per text)
 *   node embeddings.cjs --text "test" --json         # JSON output
 *   node embeddings.cjs --benchmark                  # speed test
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const CACHE_DIR = path.join(process.env.HOME, ".cache", "transformers");

/* ── Model config ────────────────────────────── */
const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIM = 384;
const EMBEDDING_BYTES = EMBEDDING_DIM * 4; // float32

/* ── SQLite setup ────────────────────────────── */
let db;
let dbMode = "none";

try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
  dbMode = "better-sqlite3";
} catch (e) {
  try {
    const sqlite3 = require("sqlite3");
    db = new sqlite3.Database(DB_PATH);
    dbMode = "sqlite3";
  } catch (e2) {
    console.warn("Warning: No SQLite module available. Caching disabled.");
  }
}

/* ── Cache table ─────────────────────────────── */
function initCacheTable() {
  if (!db) return;
  const sql = `
    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash TEXT PRIMARY KEY,
      text_preview TEXT,
      embedding BLOB NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_cache_hash ON embedding_cache(hash);
  `;
  try {
    if (dbMode === "better-sqlite3") {
      db.exec(sql);
    } else {
      db.exec(sql);
    }
  } catch (e) {
    // Table may already exist
  }
}
initCacheTable();

/* ── In-memory LRU cache ─────────────────────── */
class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    const val = this.cache.get(key);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first item)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

const memoryCache = new LRUCache(500);

/* ── Hash helper ─────────────────────────────── */
function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/* ── DB cache helpers ────────────────────────── */
function getCachedEmbedding(hash) {
  // 1. Check memory cache first
  const mem = memoryCache.get(hash);
  if (mem) return mem;

  // 2. Check SQLite cache
  if (!db) return null;

  try {
    let row;
    if (dbMode === "better-sqlite3") {
      const stmt = db.prepare("SELECT embedding FROM embedding_cache WHERE hash = ?");
      row = stmt.get(hash);
    } else {
      // sqlite3 async — use sync-ish for simplicity in this script
      // We'll use a simple synchronous workaround
      const stmt = db.prepare("SELECT embedding FROM embedding_cache WHERE hash = ?");
      row = stmt.get(hash);
    }

    if (row && row.embedding) {
      const embedding = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, EMBEDDING_DIM);
      memoryCache.set(hash, embedding);
      return embedding;
    }
  } catch (e) {
    // Cache miss or error
  }
  return null;
}

function storeCachedEmbedding(hash, text, embedding) {
  // 1. Store in memory cache
  memoryCache.set(hash, embedding);

  // 2. Store in SQLite cache
  if (!db) return;

  const preview = text.slice(0, 200);
  const buffer = Buffer.from(embedding.buffer);

  try {
    if (dbMode === "better-sqlite3") {
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO embedding_cache (hash, text_preview, embedding) VALUES (?, ?, ?)"
      );
      stmt.run(hash, preview, buffer);
    } else {
      db.run(
        "INSERT OR REPLACE INTO embedding_cache (hash, text_preview, embedding) VALUES (?, ?, ?)",
        [hash, preview, buffer]
      );
    }
  } catch (e) {
    // Non-fatal: cache write failure shouldn't break embedding generation
  }
}

/* ── Model loading ───────────────────────────── */
let pipeline = null;
let extractor = null;

async function loadModel() {
  if (extractor) return extractor;

  const { pipeline: pl, env } = await import("@xenova/transformers");

  // Configure cache directory
  env.cacheDir = CACHE_DIR;

  // Allow local models only (works offline after first download)
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // Allow download on first run

  console.error(`Loading model ${MODEL_NAME}...`);
  const start = Date.now();

  extractor = await pl("feature-extraction", MODEL_NAME, {
    quantized: true, // Use quantized model for speed
  });

  console.error(`Model loaded in ${Date.now() - start}ms`);
  return extractor;
}

/* ── Core embedding functions ────────────────── */

/**
 * Generate a single embedding for a text string.
 * @param {string} text - Input text
 * @returns {Promise<Float32Array>} - 384-dim embedding vector
 */
async function generateEmbedding(text) {
  if (!text || typeof text !== "string") {
    throw new Error("Invalid input: text must be a non-empty string");
  }

  const normalized = text.trim();
  if (normalized.length === 0) {
    throw new Error("Invalid input: text is empty");
  }

  const hash = hashText(normalized);

  // Check cache
  const cached = getCachedEmbedding(hash);
  if (cached) {
    return cached;
  }

  // Load model and generate
  const ext = await loadModel();
  const result = await ext(normalized, {
    pooling: "mean",
    normalize: true,
  });

  // Extract the embedding vector
  const embedding = new Float32Array(result.data);

  // Validate dimension
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`Expected ${EMBEDDING_DIM} dimensions, got ${embedding.length}`);
  }

  // Store in cache
  storeCachedEmbedding(hash, normalized, embedding);

  return embedding;
}

/**
 * Generate embeddings for multiple texts in a batch.
 * More efficient than calling generateEmbedding() in a loop.
 * @param {string[]} texts - Array of input texts
 * @returns {Promise<Float32Array[]>} - Array of 384-dim embedding vectors
 */
async function batchEmbedding(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error("Invalid input: texts must be a non-empty array");
  }

  const results = new Array(texts.length);
  const toGenerate = [];

  // Check cache for each text
  for (let i = 0; i < texts.length; i++) {
    const text = String(texts[i] || "").trim();
    if (text.length === 0) {
      results[i] = new Float32Array(EMBEDDING_DIM); // Zero vector for empty text
      continue;
    }

    const hash = hashText(text);
    const cached = getCachedEmbedding(hash);
    if (cached) {
      results[i] = cached;
    } else {
      toGenerate.push({ index: i, text, hash });
    }
  }

  if (toGenerate.length === 0) {
    return results;
  }

  // Load model
  const ext = await loadModel();

  // Process in chunks to avoid memory issues
  const BATCH_SIZE = 32;
  for (let i = 0; i < toGenerate.length; i += BATCH_SIZE) {
    const chunk = toGenerate.slice(i, i + BATCH_SIZE);
    const chunkTexts = chunk.map(item => item.text);

    const chunkResult = await ext(chunkTexts, {
      pooling: "mean",
      normalize: true,
    });

    // chunkResult.data shape: [chunkSize, 384] (flattened)
    const data = chunkResult.data;
    const chunkSize = chunk.length;

    for (let j = 0; j < chunkSize; j++) {
      const { index, text, hash } = chunk[j];
      const start = j * EMBEDDING_DIM;
      const embedding = new Float32Array(EMBEDDING_DIM);

      for (let k = 0; k < EMBEDDING_DIM; k++) {
        embedding[k] = data[start + k];
      }

      results[index] = embedding;
      storeCachedEmbedding(hash, text, embedding);
    }
  }

  return results;
}

/**
 * Compute cosine similarity between two embeddings.
 * @param {Float32Array} a - First embedding
 * @param {Float32Array} b - Second embedding
 * @returns {number} - Cosine similarity in [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error("Embeddings must have the same dimension");
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

/**
 * Find the top-k most similar embeddings to a query.
 * @param {Float32Array} queryEmbedding - Query embedding
 * @param {Float32Array[]} candidates - Array of candidate embeddings
 * @param {number} k - Number of top results
 * @returns {Array<{index: number, similarity: number}>}
 */
function topKSimilar(queryEmbedding, candidates, k = 5) {
  const scored = candidates.map((emb, index) => ({
    index,
    similarity: cosineSimilarity(queryEmbedding, emb),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

/* ── Cache management ────────────────────────── */

function getCacheStats() {
  const stats = {
    memoryCacheSize: memoryCache.size,
    dbCacheSize: 0,
  };

  if (db) {
    try {
      if (dbMode === "better-sqlite3") {
        const row = db.prepare("SELECT COUNT(*) as count FROM embedding_cache").get();
        stats.dbCacheSize = row.count;
      } else {
        // Fallback: can't easily get count with sqlite3 async API
      }
    } catch (e) {
      // Ignore
    }
  }

  return stats;
}

function clearCache() {
  memoryCache.clear();
  if (db) {
    try {
      if (dbMode === "better-sqlite3") {
        db.exec("DELETE FROM embedding_cache");
      } else {
        db.run("DELETE FROM embedding_cache");
      }
    } catch (e) {
      // Ignore
    }
  }
  console.log("Embedding cache cleared.");
}

/* ── CLI ─────────────────────────────────────── */

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node embeddings.cjs [options]

Options:
  --text <text>        Generate embedding for a single text
  --batch <file>       Generate embeddings for each line in a file
  --json               Output as JSON
  --benchmark          Run a speed benchmark
  --stats              Show cache statistics
  --clear-cache        Clear the embedding cache
  --similarity <a,b>   Compute cosine similarity between two texts
  --help               Show this help message

Examples:
  node embeddings.cjs --text "quantum computing"
  node embeddings.cjs --text "quantum computing" --json
  node embeddings.cjs --batch queries.txt --json
  node embeddings.cjs --benchmark
  node embeddings.cjs --similarity "apple,banana"
`);
    process.exit(0);
  }

  // --clear-cache
  if (args.includes("--clear-cache")) {
    clearCache();
    process.exit(0);
  }

  // --stats
  if (args.includes("--stats")) {
    const stats = getCacheStats();
    console.log("Cache Statistics");
    console.log("================");
    console.log(`Memory cache entries: ${stats.memoryCacheSize}`);
    console.log(`Database cache entries: ${stats.dbCacheSize}`);
    process.exit(0);
  }

  // --benchmark
  if (args.includes("--benchmark")) {
    console.log("Running embedding benchmark...\n");

    const testTexts = [
      "quantum computing",
      "machine learning",
      "black hole thermodynamics",
      "loop quantum gravity",
      "string theory",
      "artificial intelligence",
      "general relativity",
      "quantum field theory",
      "topological quantum computation",
      "holographic principle",
    ];

    // Warmup
    console.log("Warming up model...");
    await generateEmbedding("warmup");

    // Single embedding benchmark
    console.log("\nSingle embedding generation:");
    const singleStart = Date.now();
    for (const text of testTexts) {
      await generateEmbedding(text);
    }
    const singleTime = Date.now() - singleStart;
    console.log(`  ${testTexts.length} embeddings in ${singleTime}ms (${(singleTime / testTexts.length).toFixed(1)}ms avg)`);

    // Batch benchmark
    console.log("\nBatch embedding generation:");
    const batchStart = Date.now();
    await batchEmbedding(testTexts);
    const batchTime = Date.now() - batchStart;
    console.log(`  ${testTexts.length} embeddings in ${batchTime}ms (${(batchTime / testTexts.length).toFixed(1)}ms avg)`);

    // Cached benchmark
    console.log("\nCached embedding retrieval:");
    const cacheStart = Date.now();
    for (const text of testTexts) {
      await generateEmbedding(text);
    }
    const cacheTime = Date.now() - cacheStart;
    console.log(`  ${testTexts.length} cached embeddings in ${cacheTime}ms (${(cacheTime / testTexts.length).toFixed(1)}ms avg)`);

    // Similarity benchmark
    console.log("\nSimilarity computation:");
    const embeddings = await batchEmbedding(testTexts);
    const simStart = Date.now();
    for (let i = 0; i < embeddings.length - 1; i++) {
      cosineSimilarity(embeddings[i], embeddings[i + 1]);
    }
    const simTime = Date.now() - simStart;
    console.log(`  ${embeddings.length - 1} similarities in ${simTime}ms`);

    process.exit(0);
  }

  // --similarity
  const simIdx = args.indexOf("--similarity");
  if (simIdx !== -1 && args[simIdx + 1]) {
    const [textA, textB] = args[simIdx + 1].split(",");
    if (!textA || !textB) {
      console.error("Error: --similarity requires two texts separated by a comma");
      process.exit(1);
    }

    const [embA, embB] = await Promise.all([
      generateEmbedding(textA.trim()),
      generateEmbedding(textB.trim()),
    ]);

    const sim = cosineSimilarity(embA, embB);

    if (args.includes("--json")) {
      console.log(JSON.stringify({ textA: textA.trim(), textB: textB.trim(), similarity: sim }, null, 2));
    } else {
      console.log(`Cosine similarity: ${sim.toFixed(4)}`);
    }
    process.exit(0);
  }

  // --text
  const textIdx = args.indexOf("--text");
  if (textIdx !== -1 && args[textIdx + 1]) {
    const text = args[textIdx + 1];
    const start = Date.now();
    const embedding = await generateEmbedding(text);
    const elapsed = Date.now() - start;

    if (args.includes("--json")) {
      console.log(JSON.stringify({
        text,
        dimensions: embedding.length,
        model: MODEL_NAME,
        elapsedMs: elapsed,
        embedding: Array.from(embedding),
      }, null, 2));
    } else {
      console.log(`Text: ${text}`);
      console.log(`Dimensions: ${embedding.length}`);
      console.log(`Model: ${MODEL_NAME}`);
      console.log(`Elapsed: ${elapsed}ms`);
      console.log(`First 10 values: ${Array.from(embedding.slice(0, 10)).map(v => v.toFixed(6)).join(", ")}`);
    }
    process.exit(0);
  }

  // --batch
  const batchIdx = args.indexOf("--batch");
  if (batchIdx !== -1 && args[batchIdx + 1]) {
    const filePath = args[batchIdx + 1];
    if (!fs.existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }

    const lines = fs.readFileSync(filePath, "utf-8")
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0);

    console.error(`Processing ${lines.length} lines from ${filePath}...`);

    const start = Date.now();
    const embeddings = await batchEmbedding(lines);
    const elapsed = Date.now() - start;

    if (args.includes("--json")) {
      const output = lines.map((text, i) => ({
        text,
        embedding: Array.from(embeddings[i]),
      }));
      console.log(JSON.stringify({
        model: MODEL_NAME,
        dimensions: EMBEDDING_DIM,
        count: lines.length,
        elapsedMs: elapsed,
        results: output,
      }, null, 2));
    } else {
      console.log(`Processed ${lines.length} embeddings in ${elapsed}ms`);
      for (let i = 0; i < Math.min(lines.length, 5); i++) {
        console.log(`\n[${i + 1}] ${lines[i]}`);
        console.log(`    First 5 values: ${Array.from(embeddings[i].slice(0, 5)).map(v => v.toFixed(6)).join(", ")}`);
      }
      if (lines.length > 5) {
        console.log(`\n... and ${lines.length - 5} more`);
      }
    }
    process.exit(0);
  }

  console.log("No valid option provided. Use --help for usage.");
  process.exit(1);
}

/* ── Cleanup ─────────────────────────────────── */
function cleanup() {
  if (db && typeof db.close === "function") {
    db.close();
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

/* ── Module exports ──────────────────────────── */
module.exports = {
  generateEmbedding,
  batchEmbedding,
  cosineSimilarity,
  topKSimilar,
  getCacheStats,
  clearCache,
  MODEL_NAME,
  EMBEDDING_DIM,
};

/* ── Run CLI if called directly ──────────────── */
if (require.main === module) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

# Native SQLite + MiniLM Isolated Runtime

## Problem

After session-end `node_modules` cleanup, `better-sqlite3`'s native bindings are deleted. The graph-memory worker fails to start with:

```
Error: Cannot find module 'better-sqlite3'
```

Additionally, after switching to `node:sqlite` (Node 22+ built-in), semantic search produced garbage cosine similarities (~0.001 instead of ~0.5).

## Solution

### 1. Triple SQLite Driver Fallback

All scripts now resolve SQLite in this order:

```javascript
// 1. better-sqlite3 (fastest, native, synchronous)
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
  dbMode = "better-sqlite3";
} catch (e) {
  // 2. node:sqlite — Node 22+ built-in, zero dependencies
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(DB_PATH);
    dbMode = "node:sqlite";
  } catch (e2) {
    // 3. sqlite3 — async fallback (last resort)
    try {
      const sqlite3 = require("sqlite3");
      db = new sqlite3.Database(DB_PATH);
      dbMode = "sqlite3";
    } catch (e3) {
      // fatal
    }
  }
}
```

**Affected files:** `scripts/embeddings.cjs`, `scripts/query-bridge.cjs`, `scripts/queue-worker.cjs`, `scripts/session-entity-extractor.cjs`, `skills/graph-memory/scripts/query.js`

### 2. Isolated MiniLM Runtime

`@xenova/transformers` is resolved from an isolated directory to prevent version conflicts:

```javascript
const TRANSFORMERS_RUNTIME_DIR = process.env.GRAPH_MEMORY_TRANSFORMERS_DIR ||
  path.join(process.env.HOME, ".cache", "graph-memory-transformers");

const modulePath = require.resolve("@xenova/transformers", {
  paths: [TRANSFORMERS_RUNTIME_DIR, __dirname],
});
const transformersModule = await import(pathToFileURL(modulePath).href);
```

Install the runtime once:
```bash
mkdir -p ~/.cache/graph-memory-transformers
cd ~/.cache/graph-memory-transformers
npm install @xenova/transformers
```

### 3. BLOB Decoding Fix

**The bug:** `node:sqlite` returns BLOBs as `Uint8Array`. `better-sqlite3` returns them as `Buffer`. Both are `ArrayBuffer.isView`, but `new Float32Array(Uint8Array)` creates a view where each byte is a separate float.

**Wrong (produces 1,536-length garbage):**
```javascript
const emb = new Float32Array(row.embedding);  // Uint8Array(1536) → Float32Array(1536)
```

**Correct (produces 384-length valid vector):**
```javascript
function blobToFloat32(blob) {
  if (ArrayBuffer.isView(blob)) {
    return new Float32Array(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
  }
  // ... other cases
}
```

The key: use `blob.buffer` (the underlying ArrayBuffer) with the correct `byteOffset` and `byteLength / 4`.

## Validation

```bash
# Test with node:sqlite (no better-sqlite3 installed)
node scripts/query-bridge.cjs "quantum computing" --similarity
# Expect: similarity scores in 0.3-0.8 range

# Test embeddings
node scripts/embeddings.cjs --text "quantum computing" --json
# Expect: Float32Array(384) with reasonable values
```

## Files Modified

| File | Change |
|------|--------|
| `scripts/embeddings.cjs` | `node:sqlite` fallback, isolated runtime resolution |
| `scripts/query-bridge.cjs` | `node:sqlite` fallback, `blobToFloat32()` |
| `scripts/queue-worker.cjs` | `node:sqlite` fallback |
| `scripts/session-entity-extractor.cjs` | `node:sqlite` fallback |
| `skills/graph-memory/scripts/query.js` | `node:sqlite` fallback |

## See Also

- `errorLog.md` — BLOB decoding bug details
- `techContext.md` — SQLite driver chain documentation
- `systemPatterns.md` — Semantic search pattern

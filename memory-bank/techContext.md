# Tech Context

## Stack

- **Runtime**: Node.js (CommonJS `.cjs` files)
- **Database**: SQLite (via `better-sqlite3` or `sqlite3` fallback)
- **Embeddings**: `@xenova/transformers` (all-MiniLM-L6-v2, 384-dim)
- **Visualization**: D3.js (force-directed graph in HTML)
- **Session Source**: OpenClaw JSONL files (`~/.openclaw/agents/main/sessions/`)
- **Journal Source**: Markdown summaries (`journal/YYYY-MM-DD.md`)

## Dependencies

- `better-sqlite3` (preferred) or `sqlite3` (fallback) — SQLite bindings
- `@xenova/transformers` — On-device embedding generation (all-MiniLM-L6-v2, 384-dim)

## Embedding System

### `scripts/embeddings.cjs`

Core embedding generation module with caching.

**Features:**
- Loads `Xenova/all-MiniLM-L6-v2` model (384-dim float32 output)
- **Single**: `generateEmbedding(text)` → `Float32Array(384)`
- **Batch**: `batchEmbedding(texts[])` → `Float32Array[]` (chunked, ~32/item)
- **Cache**: Two-tier — in-memory LRU (500 entries) + SQLite `embedding_cache` table
- **Offline**: Works offline after first model download to `~/.cache/transformers`

**CLI Usage:**
```bash
node scripts/embeddings.cjs --text "quantum computing"
node scripts/embeddings.cjs --text "query" --json
node scripts/embeddings.cjs --batch queries.txt --json
node scripts/embeddings.cjs --similarity "apple,banana"
node scripts/embeddings.cjs --benchmark
node scripts/embeddings.cjs --stats
node scripts/embeddings.cjs --clear-cache
```

**Module API:**
```js
const { generateEmbedding, batchEmbedding, cosineSimilarity, topKSimilar } = require('./scripts/embeddings.cjs');

const emb = await generateEmbedding("text");           // Float32Array(384)
const embs = await batchEmbedding(["a", "b", "c"]);     // Float32Array[]
const sim = cosineSimilarity(emb1, emb2);               // number in [-1, 1]
const top = topKSimilar(queryEmb, candidateEmbs, 5);    // {index, similarity}[]
```

**Cache Schema:**
```sql
CREATE TABLE embedding_cache (
  hash TEXT PRIMARY KEY,          -- SHA-256 of normalized text
  text_preview TEXT,              -- First 200 chars (debugging)
  embedding BLOB NOT NULL,        -- 1536 bytes (384 × float32)
  created_at TEXT DEFAULT (datetime('now'))
);
```

## File Formats

### Session JSONL
```json
{"type":"message","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."},{"type":"thinking","thinking":"..."}]}}
```

### Graph Database Schema
```sql
CREATE TABLE entities (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  canonical_name TEXT NOT NULL,
  first_seen TEXT,
  last_seen TEXT,
  mention_count INTEGER DEFAULT 1,
  entity_type TEXT,
  confidence REAL,
  description TEXT,
  strength REAL,
  context TEXT,
  embedding BLOB          -- 384-dim float32 (1536 bytes), all-MiniLM-L6-v2
);

CREATE TABLE relationships (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relation_type TEXT,
  first_seen TEXT,
  last_seen TEXT,
  mention_count INTEGER DEFAULT 1,
  context TEXT,
  confidence REAL,
  strength REAL,
  UNIQUE(source, target, relation_type)
);

CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL,
  summary_text TEXT,
  embedding BLOB,           -- 384-dim float32 (1536 bytes)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_date)
);
```

## Known Issues

1. **No `--incremental` flag**: `build-graph.cjs` accepts `--incremental` but does a full rebuild anyway
2. ~~No npm deps~~ → Fixed: `package.json` with `@xenova/transformers` and `better-sqlite3`
3. **Journal truncation**: `journal-writer.cjs` truncates user messages to 100 chars, thinking to 300 chars
4. **Error pollution**: Cron job failures create many `error` entities that drown out real work

## Future Tech

- ~~Embedding-based semantic search (Phase 2)~~ → **Implemented** (T7b: `scripts/embeddings.cjs`)
- Incremental watermark system for session files
- `session-entity-extractor.cjs` — direct JSONL extraction (in progress)

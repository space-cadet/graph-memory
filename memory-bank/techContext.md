# Tech Context

## Stack

- **Runtime**: Node.js (CommonJS `.cjs` files)
- **Database**: SQLite (via `better-sqlite3` or `sqlite3` fallback)
- **Visualization**: D3.js (force-directed graph in HTML)
- **Session Source**: OpenClaw JSONL files (`~/.openclaw/agents/main/sessions/`)
- **Journal Source**: Markdown summaries (`journal/YYYY-MM-DD.md`)

## Dependencies

- `better-sqlite3` (preferred) or `sqlite3` (fallback) — SQLite bindings
- No npm package.json currently; scripts run with built-in Node.js modules

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
  entity_type TEXT
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
  UNIQUE(source, target, relation_type)
);
```

## Known Issues

1. **No `--incremental` flag**: `build-graph.cjs` accepts `--incremental` but does a full rebuild anyway
2. **No npm deps**: Scripts depend on globally installed `better-sqlite3` or `sqlite3`
3. **Journal truncation**: `journal-writer.cjs` truncates user messages to 100 chars, thinking to 300 chars
4. **Error pollution**: Cron job failures create many `error` entities that drown out real work

## Future Tech

- Embedding-based semantic search (Phase 2)
- Incremental watermark system for session files
- `session-entity-extractor.cjs` — direct JSONL extraction (in progress)

# Changelog

## 2026-08-30

### Added
- Native SQLite fallback (`node:sqlite` / `DatabaseSync`) across all scripts — T7
- Isolated MiniLM runtime via `GRAPH_MEMORY_TRANSFORMERS_DIR` env var — T7
- `blobToFloat32()` BLOB decoder for cross-driver embedding compatibility — T7

### Fixed
- BLOB decoding bug: `node:sqlite` returns `Uint8Array` instead of `Buffer` — semantic search now produces valid cosine similarities — T7
- Graph-memory stack now survives `node_modules` cleanup without manual intervention — T1, T8

### Changed
- SQLite driver resolution order: `better-sqlite3` → `node:sqlite` → `sqlite3` (all scripts) — T7

## 2026-07-29

### Added
- `.jsonl.gz` compressed session file support in all worker scripts — T2

## 2026-06-25

### Added
- Background queue worker (`queue-worker.cjs`) — T8
- OpenClaw skill wrapper (`skills/graph-memory/`) — T13
- Mulch integration pipeline — T14
- FTS5 + caching query optimization — T15

## 2026-06-18

### Added
- Initial repo creation
- Session-entity extractor with watermark-based incremental processing — T2
- Knowledge graph CLI (`knowledge-graph.cjs`, `build-graph.cjs`)
- DB-native memory bank

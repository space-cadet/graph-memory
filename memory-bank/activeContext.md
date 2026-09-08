# Active Context

*Last Updated: 2026-08-30*

## Current Focus

**T7: Vector Embeddings + Semantic Search — 🔄 in_progress**

Native SQLite fallback and BLOB decoding fix completed. Semantic search now functional in `query-bridge.cjs`. Remaining: session backfill script (`embed-sessions.cjs`), integration into `knowledge-graph.cjs`.

## Completed Tasks
| ID | Title | Status |
|----|-------|--------|
| T2 | Session-Entity-Extractor (Direct JSONL) | ✅ completed |
| T8 | Background Processing Queue | ✅ completed |
| T12 | Memory-Bank Protocol Extraction | ✅ completed |
| T13 | Graph-Memory OpenClaw Skill | ✅ completed |
| T14 | Mulch Integration Pipeline | ✅ completed |
| T15 | Query Optimization (FTS5 + Caching) | ✅ completed |

## Active Tasks
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| T1 | Graph Update Automation | in_progress | high |
| T7 | Vector Embeddings + Semantic Search | in_progress | high |

## Pending Tasks
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| T3 | Memory Search Bridge | pending | high |
| T4 | Entity Quality Improvements | pending | medium |
| T5 | Historical Backfill | pending | low |
| T6 | LLM-Based Entity Extraction | pending | high |
| T9 | Temporal Decay + Relationship Strength | pending | medium |
| T10 | Multi-Source Ingestion | pending | high |
| T11 | Agent Integration | pending | high |

## 2026-08-30 Repair — Native SQLite + BLOB Fix

**Problem**: After `node_modules` cleanup, `better-sqlite3` native bindings are missing. The graph-memory worker fails to start, and semantic search produces garbage cosine similarities.

**Root Cause**: 
1. `better-sqlite3` requires compiled native addon — deleted by session-end cleanup
2. `node:sqlite` (Node 22+ built-in) returns BLOBs as `Uint8Array`, not `Buffer`
3. `new Float32Array(Uint8Array)` treats each byte as a float element → 1,536-byte BLOB becomes 1,536-length Float32Array instead of 384-length

**Fix Applied**:
- Added `node:sqlite` / `DatabaseSync` fallback across all 5 scripts
- Added `GRAPH_MEMORY_TRANSFORMERS_DIR` env var for isolated MiniLM runtime
- Added `blobToFloat32()` in `query-bridge.cjs` with proper `ArrayBuffer.isView` handling
- Extracted `native/better_sqlite3.node` for persistence across cleanups

**Validation**: `node scripts/query-bridge.cjs "quantum computing" --similarity` now returns valid cosine similarities (0.3-0.8 range) instead of near-zero garbage.

## Architecture Docs
- `implementation-details/native-sqlite-minilm-search.md` — Aug 30 repair details
- `implementation-details/T6-architectural-plan.md` — Six-phase plan
- `implementation-details/tiered-memory-graph.md` — Tiered architecture spec
- `implementation-details/graph-integration-plan.md` — Integration roadmap

## Next Actions
1. **T7**: Build `scripts/embed-sessions.cjs` for bulk backfill
2. **T7**: Integrate semantic search into `knowledge-graph.cjs`
3. **T1**: Verify worker auto-restart after node_modules cleanup
4. **T6**: Begin LLM-based extraction planning (high impact, longer timeline)

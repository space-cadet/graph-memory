# Active Context

*Last Updated: 2026-07-08 12:30 UTC*

## Current Focus

**T6: LLM-Based Entity Extraction — ⬜ pending**

The graph integration track is now complete (T13, T14, T15). Next priority is extraction quality — the regex-based session-entity-extractor.cjs misses ~90% of meaningful content (e.g., "quantum" → 0 results). LLM-based extraction would dramatically improve entity quality, making the graph more useful for search and mulch pattern detection.

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

## Pending Tasks
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| T3 | Memory Search Bridge | pending | high |
| T4 | Entity Quality Improvements | pending | medium |
| T5 | Historical Backfill | pending | low |
| T6 | LLM-Based Entity Extraction | pending | high |
| T7 | Vector Embeddings + Semantic Search | pending | high |
| T9 | Temporal Decay + Relationship Strength | pending | medium |
| T10 | Multi-Source Ingestion | pending | high |
| T11 | Agent Integration | pending | high |

## Next Actions
1. **T6**: Begin LLM-based extraction planning (high impact, longer timeline) — regex extraction misses ~90% of content
2. **T3**: Memory Search Bridge — already partially functional via query-bridge.cjs, needs formalization
3. **T11**: Agent Integration — graph is now accessible via skill, needs hook into agent memory pipeline
4. **T7**: Vector Embeddings + Semantic Search — add semantic search capability

## Key Decisions (2026-07-08)
- **Rust rewrite rejected**: SQLite C API already optimal; FTS5 + caching is the right optimization path
- **T8 completed**: Queue worker operational since 2026-06-25
- **Integration priority**: T13 (skill) → T14 (mulch) → T15 (optimization) — ALL COMPLETED
- **Next priority**: T6 (LLM quality) → T3 (formalize search bridge) → T11 (agent memory hooks)

## Architecture Docs
- `implementation-details/T6-architectural-plan.md` — Six-phase plan
- `implementation-details/tiered-memory-graph.md` — Tiered architecture spec
- `implementation-details/graph-integration-plan.md` — Integration roadmap (NEW)

## Recent Fixes
- **2026-07-29**: Fixed graph-memory workers to handle `.jsonl.gz` compressed session files. Added `readSessionFile()` helper with `zlib.gunzipSync` to `backfill-sessions.cjs`, `queue-worker.cjs`, and `session-entity-extractor.cjs`. Updated file filters to include `.jsonl.gz`. Enables Tier 1 → Tier 2 pipeline to work with archived sessions per tiered-memory-graph spec.

# Active Context

*Last Updated: 2026-07-08 12:30 UTC*

## Current Focus

**T13: Graph-Memory OpenClaw Skill — ⬜ pending**

Priority shift: Agent integration is now the highest-impact immediate task. The graph is populated (9,543 sessions), queries work via CLI, but the agent cannot access it during conversations.

## Completed Tasks
| ID | Title | Status |
|----|-------|--------|
| T2 | Session-Entity-Extractor (Direct JSONL) | ✅ completed |
| T8 | Background Processing Queue | ✅ completed |
| T12 | Memory-Bank Protocol Extraction | ✅ completed |

## Active Tasks
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| T1 | Graph Update Automation | in_progress | high |
| T13 | Graph-Memory OpenClaw Skill | pending | high |

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
| T14 | Mulch Integration Pipeline | pending | high |
| T15 | Query Optimization (FTS5 + Caching) | pending | medium |

## Next Actions
1. **T13**: Create `skills/graph-memory/` with SKILL.md and query wrapper
2. **T14**: Design mulch integration cron (depends on T13)
3. **T15**: Add FTS5 and caching (independent, medium priority)
4. **T6**: Begin LLM-based extraction planning (high impact, longer timeline)

## Key Decisions (2026-07-08)
- **Rust rewrite rejected**: SQLite C API already optimal; FTS5 + caching is the right optimization path
- **T8 completed**: Queue worker operational since 2026-06-25
- **Integration priority**: T13 (skill) → T14 (mulch) → T6 (LLM quality)
- **Mulch cross-system**: Graph will feed into `.mulch/expertise/` nightly

## Architecture Docs
- `implementation-details/T6-architectural-plan.md` — Six-phase plan
- `implementation-details/tiered-memory-graph.md` — Tiered architecture spec
- `implementation-details/graph-integration-plan.md` — Integration roadmap (NEW)

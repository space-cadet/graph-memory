# Active Context

*Last Updated: 2026-06-18 19:30 UTC*

## Current Focus

**T1: Graph Update Automation** — In Progress

Integrating `session-entity-extractor.cjs` into the heartbeat rotation. T2 is now complete.

## Recent Decisions

- **T2 COMPLETE**: `session-entity-extractor.cjs` built and validated
- **Direct JSONL extraction confirmed**: Search quality dramatically improved
- **chimera found**: 0 → 1 (journal vs session extraction)
- **arXiv found**: 1-2 → 20 results
- **Watermark system**: `.session-watermark.json` tracks incremental progress

## Completed Tasks
- ✅ T2: Session-Entity-Extractor (Direct JSONL) — COMPLETE

## Active Tasks
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| T1 | Graph Update Automation | in_progress | HIGH |

## Pending Tasks
| ID | Title | Status | Priority |
|----|-------|--------|----------|
| T3 | Memory Search Bridge | pending | HIGH |
| T4 | Entity Quality Improvements | pending | MEDIUM |
| T5 | Historical Backfill | pending | LOW |

## Next Actions
1. Add graph build step to heartbeat rotation (T1)
2. Test incremental mode on heartbeat
3. Build search bridge (T3)

## Open Questions
1. Should the extractor run on EVERY heartbeat or every 2nd?
2. How to handle the large backfill (13,702 files) without blocking heartbeat?
3. Search bridge: CLI tool vs. agent integration via function call?

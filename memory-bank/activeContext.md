# Active Context

## Current Focus

**T2: Session-Entity-Extractor (Direct JSONL)** — In Progress

Building the direct JSONL extractor that reads full conversation text instead of truncated journal summaries. This is the foundation for all other tasks.

## Recent Decisions

- **Repo created**: `graph-memory` in `code/` with DB-native memory bank
- **Public GitHub repo**: `space-cadet/graph-memory` with personal info scrubbed
- **Update cadence**: Every 2nd heartbeat (~1 hour) alongside journal processing
- **Extraction strategy**: Direct JSONL, not journal-based (validated by search tests)

## Open Questions

1. How to handle incremental builds efficiently (watermark vs. full rebuild)
2. Whether to store conversation snippets in relationships table or a new table
3. How to weight entity types for search relevance (files vs. concepts vs. decisions)

## Next Actions

1. Build `session-entity-extractor.cjs` (T2)
2. Test on a single recent session
3. Add to heartbeat rotation (T1)
4. Build search bridge (T3)

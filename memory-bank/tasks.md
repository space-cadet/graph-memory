# Active Tasks

## T1: Graph Update Automation
- Status: 🔄 **in_progress**
- Priority: HIGH
- Started: 2026-06-18
- Details: Integrate graph build into heartbeat rotation. Run every 2nd heartbeat alongside journal processing. Use `session-entity-extractor.cjs` for incremental updates.

## T2: Session-Entity-Extractor (Direct JSONL)
- Status: 🔄 **in_progress**
- Priority: HIGH
- Started: 2026-06-18
- Details: Create new extractor that reads raw session JSONL files, extracts full user/assistant conversation text, runs entity patterns on complete content. Replaces journal-based extraction for new data.

## T3: Memory Search Bridge
- Status: ⏳ **pending**
- Priority: HIGH
- Started: 2026-06-18
- Depends on: T2
- Details: Create `search-graph.cjs` wrapper that takes a query, searches graph entities + relationships, returns structured summary. Hook into agent memory search pipeline.

## T4: Entity Quality Improvements
- Status: ⏳ **pending**
- Priority: MEDIUM
- Started: 2026-06-18
- Depends on: T2
- Details: Expand entity types (decision, topic, question), improve concept extraction, add relationship context (not just co-occurrence).

## T5: Historical Backfill
- Status: ⏳ **pending**
- Priority: LOW
- Started: 2026-06-18
- Depends on: T2
- Details: Reprocess all historical session JSONLs with new extractor to rebuild graph from full conversation text.

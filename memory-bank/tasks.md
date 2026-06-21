# Active Tasks

## T1: Graph Update Automation
- Status: 🔄 **in_progress**
- Priority: 🔴 high
- Started: 2026-06-18
- Details: Integrate graph build into heartbeat rotation. Run every 2nd heartbeat alongside journal processing. Use session-entity-extractor.cjs for incremental updates.

## T10: Multi-Source Ingestion
- Status: ⏳ **pending**
- Priority: 🔴 high
- Started: 2026-06-18T20:54:12.694Z
- Details: Ingest git commits, file modifications, calendar events, arXiv API. Transform graph from conversation-only to full work context. Phase 5 of architectural plan.

## T11: Agent Integration
- Status: ⏳ **pending**
- Priority: 🔴 high
- Started: 2026-06-18T20:54:12.694Z
- Details: Integrate graph queries into agent memory pipeline. Query graph as first-class memory source before falling back to MEMORY.md. Phase 6 of architectural plan.

## T2: Session-Entity-Extractor (Direct JSONL)
- Status: ✅ **completed**
- Priority: 🔴 high
- Started: 2026-06-18
- Details: Create new extractor that reads raw session JSONL files, extracts full user/assistant conversation text, runs entity patterns on complete content. Replaces journal-based extraction for new data.

## T3: Memory Search Bridge
- Status: ⏳ **pending**
- Priority: 🔴 high
- Started: 2026-06-18
- Details: Create search-graph.cjs wrapper that takes a query, searches graph entities + relationships, returns structured summary. Hook into agent memory search pipeline.

## T4: Entity Quality Improvements
- Status: ⏳ **pending**
- Priority: 🟡 medium
- Started: 2026-06-18
- Details: Expand entity types (decision, topic, question), improve concept extraction, add relationship context (not just co-occurrence).

## T5: Historical Backfill
- Status: ⏳ **pending**
- Priority: 🟢 low
- Started: 2026-06-18
- Details: Reprocess all historical session JSONLs with new extractor to rebuild graph from full conversation text.

## T6: LLM-Based Entity Extraction
- Status: ⏳ **pending**
- Priority: 🔴 high
- Started: 2026-06-18T20:54:12.694Z
- Details: Replace regex patterns with LLM-based entity extraction from session text. Extract entities, decisions, topics, questions with confidence scores. Phase 1 of architectural improvement plan.

## T7: Vector Embeddings + Semantic Search
- Status: ⏳ **pending**
- Priority: 🔴 high
- Started: 2026-06-18T20:54:12.694Z
- Details: Add embedding vectors per session summary and entity. Enable semantic search via cosine similarity. Use all-MiniLM-L6-v2 or equivalent (384-dim). Phase 2 of architectural plan.

## T8: Background Processing Queue
- Status: ⏳ **pending**
- Priority: 🟡 medium
- Started: 2026-06-18T20:54:12.694Z
- Details: Decouple extraction from heartbeat. Use queue-based async processing. Heartbeat enqueues, worker processes in background. Phase 3 of architectural plan.

## T9: Temporal Decay + Relationship Strength
- Status: ⏳ **pending**
- Priority: 🟡 medium
- Started: 2026-06-18T20:54:12.694Z
- Details: Add confidence and strength fields to relationships. Implement temporal decay: relationships fade if not reinforced. Phase 4 of architectural plan.


## T12: Memory-Bank Protocol Extraction
- Status: ✅ **completed**
- Priority: 🔴 high
- Started: 2026-06-22
- Completed: 2026-06-22
- Details: Extended session-entity-extractor.cjs to understand memory-bank protocol v6.12. Added task, edit_chunk, decision, blocker, next_action, file_change entity types. Created memory-bank-reconstructor.cjs that queries graph and outputs memory-bank markdown. Reconstructed 5 days (2026-06-17 through 2026-06-21) after workspace git reset. Graph: 968 sessions → 1,159 entities → 8,392 relationships.

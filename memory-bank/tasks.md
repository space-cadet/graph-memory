# Graph Memory Tasks

*Generated: 2026-06-25*

## Task Overview

| ID | Title | Status | Priority | Started | Last Updated | Details |
|----|-------|--------|----------|---------|--------------|---------|
| T1 | Graph Update Automation | 🔄 in_progress | 🔥 high | 2026-06-18 | 2026-06-18 | Integrate graph build into heartbeat rotation. Run every 2nd heartbeat alongside journal processing. Use session-entity-extractor.cjs for incremental updates. |
| T2 | Session-Entity-Extractor (Direct JSONL) | ✅ completed | 🔥 high | 2026-06-18 | 2026-06-18 | Create new extractor that reads raw session JSONL files, extracts full user/assistant conversation text, runs entity patterns on complete content. Replaces journal-based extraction for new data. |
| T3 | Memory Search Bridge | ⬜ pending | 🔥 high | 2026-06-18 | 2026-06-18 | Create search-graph.cjs wrapper that takes a query, searches graph entities + relationships, returns structured summary. Hook into agent memory search pipeline. |
| T4 | Entity Quality Improvements | ⬜ pending | ⏺️ medium | 2026-06-18 | 2026-06-18 | Expand entity types (decision, topic, question), improve concept extraction, add relationship context (not just co-occurrence). |
| T5 | Historical Backfill | ⬜ pending | ⬇️ low | 2026-06-18 | 2026-06-18 | Reprocess all historical session JSONLs with new extractor to rebuild graph from full conversation text. |
| T6 | LLM-Based Entity Extraction | ⬜ pending | 🔥 high | 2026-06-18 | 2026-06-18 | Replace regex patterns with LLM-based entity extraction from session text. Extract entities, decisions, topics, questions with confidence scores. Phase 1 of architectural improvement plan. |
| T7 | Vector Embeddings + Semantic Search | ⬜ pending | 🔥 high | 2026-06-18 | 2026-06-18 | Add embedding vectors per session summary and entity. Enable semantic search via cosine similarity. Use all-MiniLM-L6-v2 or equivalent (384-dim). Phase 2 of architectural plan. |
| T8 | Background Processing Queue | ⬜ pending | ⏺️ medium | 2026-06-18 | 2026-06-18 | Decouple extraction from heartbeat. Use queue-based async processing. Heartbeat enqueues, worker processes in background. Phase 3 of architectural plan. |
| T9 | Temporal Decay + Relationship Strength | ⬜ pending | ⏺️ medium | 2026-06-18 | 2026-06-18 | Add confidence and strength fields to relationships. Implement temporal decay: relationships fade if not reinforced. Phase 4 of architectural plan. |
| T10 | Multi-Source Ingestion | ⬜ pending | 🔥 high | 2026-06-18 | 2026-06-18 | Ingest git commits, file modifications, calendar events, arXiv API. Transform graph from conversation-only to full work context. Phase 5 of architectural plan. |
| T11 | Agent Integration | ⬜ pending | 🔥 high | 2026-06-18 | 2026-06-18 | Integrate graph queries into agent memory pipeline. Query graph as first-class memory source before falling back to MEMORY.md. Phase 6 of architectural plan. |
| T12 | Memory-Bank Protocol Extraction | ✅ completed | 🔥 high | 2026-06-22 | 2026-06-22 | Extended session-entity-extractor.cjs to understand memory-bank protocol v6.12. Added task, edit_chunk, decision, blocker, next_action, file_change entity types. Created memory-bank-reconstructor.cjs that queries graph and outputs memory-bank markdown. Reconstructed 5 days (2026-06-17 through 2026-06-21) after workspace git reset. Graph: 968 sessions → 1,159 entities → 8,392 relationships. |

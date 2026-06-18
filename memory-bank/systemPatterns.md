# System Patterns

## Pattern: Heartbeat-Driven Graph Updates

**Context**: Graph needs to stay current without manual intervention  
**Solution**: Run graph build on every 2nd heartbeat, alongside journal processing  
**Trade-off**: Delay of ~1 hour between session and graph update  
**Status**: Planned (T1)

## Pattern: Direct JSONL Extraction

**Context**: Journal-based extraction loses semantic content due to truncation  
**Solution**: Read raw session JSONL files, extract full conversation text  
**Trade-off**: More data = slower processing, but richer entities  
**Status**: In progress (T2)

## Pattern: Watermark-Based Incremental Processing

**Context**: 13,702 session files exist; full rebuild is too slow  
**Solution**: Track last-processed file/line in a watermark file, only process new data  
**Trade-off**: Requires careful watermark management to avoid missing data  
**Status**: Planned (T2)

## Pattern: Generic Aliases for Public Release

**Context**: Public repo must not contain personal information  
**Solution**: Replace all real names/institutions with generic placeholders  
**Trade-off**: Users must configure their own aliases before running  
**Status**: Implemented

## Pattern: DB-Native + Text Dual Memory Bank

**Context**: DB-native workflow exists but text files remain canonical for some projects  
**Solution**: Use DB for task tracking and data layer, text files for rich documentation  
**Trade-off**: Two sources of truth; need explicit sync  
**Status**: Active in this repo

## Pattern: Entity Canonicalization

**Context**: Same entity referred to by multiple names (e.g., "Deepak", "D.Vaid", "明达")  
**Solution**: `NAME_ALIASES` map in `entity-extractor.cjs` normalizes to canonical form  
**Trade-off**: Hardcoded list; needs user customization for different workspaces  
**Status**: Implemented, needs generalization

## Pattern: Tiered Memory Graph

**Context**: Raw sessions, summaries, topics, and long-term knowledge have different lifecycles and query patterns
**Solution**: Four-tier architecture with upward data flow and distinct retention policies
- T1: Raw sessions (90-day retention, archived)
- T2: Session summaries with embeddings (persistent)
- T3: Topic clusters (ephemeral, computed on query)
- T4: Long-term knowledge (persistent, human-reviewed)
**Trade-off**: More complex than flat graph, but enables "active work" vs "historical context" queries
**Status**: Designed (T6-T11)

## Pattern: LLM-Based Entity Extraction

**Context**: Regex patterns miss ~90% of meaningful entities (concepts, decisions, topics)
**Solution**: Replace regex with LLM extraction per session batch
**Trade-off**: API cost ($0.001-0.01/session) vs extraction quality
**Alternative**: Local model (Ollama) for zero cost, slower throughput
**Status**: Designed (T6)

## Pattern: Semantic Search via Embeddings

**Context**: Literal string search can't bridge vocabulary gaps ("chat component" ≠ "chimera-chat")
**Solution**: Store 384-dim embedding vectors per session summary and entity
**Trade-off**: ~1.5KB per embedding, but enables cosine similarity search
**Model**: all-MiniLM-L6-v2 (fast) or all-mpnet-base-v2 (better quality)
**Status**: Designed (T7)

## Pattern: Temporal Relationship Decay

**Context**: All relationships treated equally — can't distinguish active from stale
**Solution**: Relationships have strength (0.0-1.0) that decays over time, reinforced by mentions
**Trade-off**: Requires periodic recalculation, but enables "show me active projects" queries
**Decay rule**: strength(t) = strength_0 × 0.5^(days / half_life)
**Status**: Designed (T9)

## Pattern: Multi-Source Context Ingestion

**Context**: Graph only knows conversation content, not actual work activity
**Solution**: Ingest git commits, file modifications, calendar events, arXiv API
**Trade-off**: More complex pipeline, but richer context for agent queries
**Status**: Designed (T10)

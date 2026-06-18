# T6: Architectural Improvement Plan — Robust Memory System

*Created: 2026-06-19*  
*Status: Planning Complete, Pending Implementation*

## Executive Summary

The current graph-memory system is a successful prototype that proves the concept of building a knowledge graph from OpenClaw sessions. However, regex-based extraction, flat relationships, and single-source ingestion create hard limits on scalability and usefulness. This document outlines a six-phase plan to transform the prototype into a robust, scalable memory system.

## Current Architecture Assessment

### What's Working
- SQLite storage with entities + relationships
- Watermark-based incremental processing
- CLI query tool (`knowledge-graph.cjs`)
- Direct JSONL extraction (T2 complete)

### Critical Gaps
1. **Regex extraction captures ~10% of meaningful content**
   - "quantum" → 0 results
   - "chimera" → 0 results  
   - "obsidian" → 0 results
   - Only files, tools, and explicit `[[links]]` match

2. **2,808 of 3,653 relationships are `mentioned_with`** (co-occurrence noise)

3. **No semantic search** — literal string matching only

4. **Synchronous single-writer SQLite** — will block at scale

5. **Single source** — only session text, no git, files, calendar

6. **No agent integration** — I never query the graph during conversations

## Six-Phase Improvement Plan

### Phase 1: LLM-Based Entity Extraction (T6)
**Priority:** 🔴 HIGH  
**Impact:** **Highest** — fixes the core quality problem  
**Time Estimate:** 1-2 days

**Problem:** Regex patterns (`/\b(?:npm|git|python)\b/gi`) can't understand context. They miss "quantum computing" entirely and catch "git" when talking about a person.

**Solution:** Replace regex with LLM-based extraction per session.

```javascript
// Per-session LLM call (batched for efficiency)
const extractionPrompt = `
Analyze this conversation and extract:
1. ENTITIES: Projects, concepts, people, tools, files mentioned
2. DECISIONS: Explicit choices made ("we decided to...", "chose X over Y")
3. TOPICS: Discussion subjects
4. QUESTIONS: Unresolved questions
5. RELATIONSHIPS: How entities relate (uses, depends_on, implements)

Return JSON:
{
  "entities": [{"name": "...", "type": "...", "confidence": 0.95}],
  "decisions": [{"what": "...", "rationale": "...", "date": "..."}],
  "topics": ["..."],
  "questions": ["..."],
  "relationships": [{"source": "...", "target": "...", "type": "...", "strength": 0.9}]
}
`;
```

**Cost:** ~$0.001-0.01/session. At 13K sessions, one-time backfill ≈ $50-100. Incremental ≈ pennies.

**Alternative:** Local model (Ollama/llama.cpp) for zero API cost, slower but private.

**Schema Changes:**
```sql
ALTER TABLE entities ADD COLUMN confidence REAL DEFAULT 1.0;
ALTER TABLE entities ADD COLUMN description TEXT;
ALTER TABLE relationships ADD COLUMN confidence REAL DEFAULT 1.0;
ALTER TABLE relationships ADD COLUMN strength REAL DEFAULT 1.0;
ALTER TABLE relationships ADD COLUMN valid_from TEXT;
ALTER TABLE relationships ADD COLUMN valid_until TEXT;
```

---

### Phase 2: Vector Embeddings + Semantic Search (T7)
**Priority:** 🔴 HIGH  
**Impact:** **High** — enables "similar to" queries  
**Time Estimate:** 2-3 days

**Problem:** Can't ask "what were we doing with that chat component?" and find `chimera-chat`.

**Solution:** Store embedding vectors per session summary and entity description.

```sql
-- New table
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY,
  entity_name TEXT,
  content TEXT,
  embedding BLOB,  -- 384 floats (all-MiniLM-L6-v2)
  created_at TEXT
);

-- Search: cosine similarity
SELECT entity_name, content,
       (embedding * query_embedding) / (|embedding| * |query_embedding|) AS similarity
FROM embeddings
ORDER BY similarity DESC
LIMIT 10;
```

**Model:** `all-MiniLM-L6-v2` (384-dim, fast, good quality) or `all-mpnet-base-v2` (768-dim, better quality).

**Storage:** ~1.5KB per embedding. 10K sessions ≈ 15MB.

---

### Phase 3: Background Processing Queue (T8)
**Priority:** 🟡 MEDIUM  
**Impact:** **Medium** — scalability  
**Time Estimate:** 1 day

**Problem:** Heartbeat triggers synchronous extraction. At 13K sessions, this blocks for minutes.

**Solution:** Decouple with queue-based async processing.

```
Heartbeat: Check for new sessions → Enqueue session IDs → Done ( < 100ms)
Worker (every 5 min): Dequeue up to N sessions → Process → Update graph
```

**Implementation:**
```bash
# Simple queue file
~/.openclaw_memory/.extraction-queue  # JSON array of session paths

# Worker cron job
*/5 * * * * cd ~/code/graph-memory && node scripts/extraction-worker.cjs
```

---

### Phase 4: Temporal Decay + Relationship Strength (T9)
**Priority:** 🟡 MEDIUM  
**Impact:** **Medium** — "active work" vs "past work"  
**Time Estimate:** 1-2 days

**Problem:** Can't distinguish "what am I actively working on?" from "what did I work on last year?"

**Solution:** Relationships have strength that decays over time.

```
Initial strength: 1.0
After 7 days without mention: 0.7
After 30 days: 0.3
After 90 days: 0.1 (archived)
Reinforcement: +0.2 per mention (max 1.0)
```

**Query:** "Show me active projects" → strength > 0.5  
**Query:** "Show me historical context" → include all, rank by strength

---

### Phase 5: Multi-Source Ingestion (T10)
**Priority:** 🔴 HIGH  
**Impact:** **High** — richer context  
**Time Estimate:** 3-5 days

**Problem:** Graph only knows what we talked about, not what we actually did.

**Sources to ingest:**
1. **Git commits** in `~/code/*` repos → project activity, file changes, commit messages
2. **File modifications** → what's being edited right now
3. **Calendar events** → meetings, deadlines, travel
4. **ArXiv API** → new papers in watched categories

**Example enrichment:**
```
Graph knows: "We discussed chimera-chat on June 15"
Git knows: "3 commits to chimera-chat on June 15: feat/debate-mode, fix/zen-mode"
Combined: "Active development on chimera-chat debate mode (June 15)"
```

---

### Phase 6: Agent Integration (T11)
**Priority:** 🔴 HIGH  
**Impact:** **High** — makes it actually useful  
**Time Estimate:** 2-3 days

**Problem:** I never query the graph. I read MEMORY.md and session files instead.

**Solution:** Integrate graph queries into the agent memory pipeline.

```javascript
// In agent memory retrieval:
async function retrieveMemory(query) {
  // Try graph first
  const graphResults = await queryGraph(query, { minConfidence: 0.7 });
  if (graphResults.length > 0) {
    return formatGraphResults(graphResults);
  }
  
  // Fallback to MEMORY.md
  return readMemoryMd();
}
```

**Requirements:**
- Query latency < 100ms
- Structured return with confidence scoring
- Graceful degradation (don't fail if graph is unavailable)

---

## Tiered Memory Graph Architecture

```
┌─────────────────────────────────────────────────────────┐
│  TIER 4: Long-term Knowledge (Facts, Decisions, People)  │
│  ├─ Persistent entities (people, projects, institutions) │
│  ├─ Key decisions with rationale                        │
│  ├─ Stable relationships (Deepak → NITK)                │
│  └─ Storage: SQLite + occasional human review           │
├─────────────────────────────────────────────────────────┤
│  TIER 3: Topic Clusters (Aggregated Sessions)            │
│  ├─ Auto-generated topic models from session groups      │
│  ├─ "Quantum gravity papers" = arxiv + LQG sessions     │
│  └─ Storage: SQLite + simple clustering                  │
├─────────────────────────────────────────────────────────┤
│  TIER 2: Session Summaries (Extracted per session)       │
│  ├─ LLM-extracted: entities, decisions, key questions    │
│  ├─ Vector embeddings for semantic search                │
│  ├─ Temporal index (when did this happen?)               │
│  └─ Storage: SQLite + embedding JSON                     │
├─────────────────────────────────────────────────────────┤
│  TIER 1: Raw Sessions (Ephemeral, 30-90 day retention)   │
│  ├─ Full JSONL logs                                      │
│  ├─ Compressed after summarization                       │
│  └─ Storage: Filesystem (rotate/archive old ones)        │
└─────────────────────────────────────────────────────────┘
```

## Implementation Order Recommendation

| Order | Phase | Why First? |
|-------|-------|-----------|
| 1 | T6: LLM Extraction | Fixes core quality problem. Everything else is wasted effort if extraction is bad. |
| 2 | T11: Agent Integration | Makes the system useful immediately. Even a small graph is valuable if I can query it. |
| 3 | T7: Vector Embeddings | Enables semantic search. Builds on T6's improved entities. |
| 4 | T8: Background Queue | Unblocks heartbeat. Required before scale. |
| 5 | T10: Multi-Source | Richer context. Builds on stable extraction (T6). |
| 6 | T9: Temporal Decay | Nice-to-have refinement. Do after core is solid. |

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| LLM API costs too high | Low | Medium | Use local model (Ollama) or batch processing |
| Embedding storage too large | Low | Low | 13K sessions × 1.5KB = ~20MB, trivial |
| SQLite becomes bottleneck | Medium | Medium | Migrate to PostgreSQL later if needed |
| LLM extraction hallucinates entities | Medium | High | Confidence scoring + human review of high-confidence entities |
| Background worker fails silently | Medium | High | Health checks + alerts in heartbeat |

## Success Metrics

| Metric | Current | Target (T6+T7) |
|--------|---------|----------------|
| "quantum" search results | 0 | > 50 |
| "chimera" search results | 0 | > 20 |
| Meaningful relationships | 9% | > 50% |
| Query latency | N/A | < 100ms |
| Agent uses graph for memory | 0% | > 30% |

---

*Next step: Implement T6 (LLM-Based Entity Extraction)*

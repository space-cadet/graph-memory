# Tiered Memory Graph Architecture

*Specification for graph-memory v2.0*

## Overview

The memory system is organized into four tiers, each with different retention policies, update frequencies, and query patterns. Data flows upward (from raw sessions to long-term knowledge) through extraction, aggregation, and decay processes.

## Data Flow

```
Raw Sessions (T1) → Session Summaries (T2) → Topic Clusters (T3) → Long-term Knowledge (T4)
      ↓                    ↓                      ↓                      ↓
  JSONL files         SQLite + vectors       SQLite                  SQLite
  30-90 day           persistent             persistent              persistent
  retention
```

---

## Tier 1: Raw Sessions

**Purpose:** Immutable source of truth. All conversation data.

**Format:** OpenClaw JSONL files

**Retention:** 90 days online, then compressed to `.jsonl.gz` and archived

**Size estimate:** ~50KB per session × 13K sessions = ~650MB raw

**Access pattern:** Read-only. Extracted into higher tiers, rarely queried directly.

**Rotation policy:**
```bash
# After summarization + extraction, compress sessions older than 90 days
find ~/.openclaw/agents/main/sessions/ -name '*.jsonl' -mtime +90 \
  -exec gzip {} \; \
  -exec mv {}.gz ~/.openclaw/archives/sessions/ \;
```

---

## Tier 2: Session Summaries

**Purpose:** Structured, searchable representation of each session.

**Storage:** SQLite tables + embedding vectors

### Schema

```sql
-- Session summaries
CREATE TABLE session_summaries (
  id INTEGER PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  date TEXT NOT NULL,
  summary TEXT,           -- LLM-generated 2-3 sentence summary
  key_entities TEXT,      -- JSON array of entity names
  decisions TEXT,         -- JSON array of decisions
  topics TEXT,            -- JSON array of topics
  questions TEXT,         -- JSON array of unresolved questions
  embedding BLOB          -- 384-dim vector
);

-- Extracted entities (per session)
CREATE TABLE session_entities (
  session_id TEXT,
  entity_name TEXT,
  entity_type TEXT,
  confidence REAL,
  context TEXT,           -- surrounding sentence
  PRIMARY KEY (session_id, entity_name)
);

-- Extracted relationships (per session)
CREATE TABLE session_relationships (
  session_id TEXT,
  source TEXT,
  target TEXT,
  relation_type TEXT,
  strength REAL,
  context TEXT
);
```

### Extraction Pipeline

```
1. Read session JSONL
2. Concatenate user + assistant text
3. LLM extraction → entities, decisions, topics, relationships
4. Store in session_* tables
5. Generate summary + embedding
6. Update watermark
```

**Batch size:** 10-50 sessions per LLM call (to reduce API cost)

**Cost:** ~$0.005-0.02 per batch of 10 sessions

---

## Tier 3: Topic Clusters

**Purpose:** Group related sessions into coherent topics. Enable "what was I working on in June?" queries.

**Storage:** SQLite

### Clustering Approach

Simple embedding-based clustering:

```sql
-- Cluster sessions by embedding similarity
SELECT 
  s1.session_id,
  s2.session_id,
  cosine_similarity(s1.embedding, s2.embedding) AS sim
FROM session_summaries s1
JOIN session_summaries s2 ON s1.date = s2.date  -- same day
WHERE sim > 0.75;
```

**Clusters are ephemeral** — recomputed on query. No persistent cluster table needed.

**Alternative:** HDBSCAN or K-means on embeddings for persistent clusters.

---

## Tier 4: Long-term Knowledge

**Purpose:** Persistent facts that survive session rotation. The "memory" in memory bank.

**Storage:** SQLite (same as current graph.db)

### Entity Types

| Type | Example | Source |
|------|---------|--------|
| person | Deepak, Sage | Explicit mentions + alias resolution |
| project | chimera-chat, obsidian-ai | Git repos + explicit mentions |
| concept | quantum computing, LLM tool calling | LLM extraction |
| institution | NITK, IUCAA | Explicit mentions |
| paper | arXiv:2605.15200 | arXiv ID patterns + API lookup |
| decision | "Chose Chart.js over D3" | LLM extraction |
| goal | "Implement debate mode" | LLM extraction |

### Relationship Types

| Type | Example |
|------|---------|
| works_at | Deepak → NITK |
| created | Deepak → chimera-chat |
| uses | chimera-chat → Chart.js |
| depends_on | chimera-chat → esbuild |
| decided_to_use | chimera-chat → Chart.js |
| implements | chimera-chat → multi-agent orchestration |
| answers | chimera-chat → "How to do debate mode?" |
| cites | paper → paper |

### Decay Rules

```
Relationship strength(t) = strength_0 × decay_factor^(days_elapsed / half_life)

Default half_lives:
- mentioned_with: 7 days
- uses: 30 days
- created: 90 days (permanent, no decay)
- decided_to_use: 180 days

Reinforcement: +0.2 per mention, max 1.0
```

---

## Query Patterns

### Q1: "What am I actively working on?"
```sql
SELECT e.name, e.entity_type, MAX(r.strength) AS max_strength
FROM entities e
JOIN relationships r ON e.name = r.source OR e.name = r.target
WHERE e.entity_type = 'project'
  AND r.last_seen > date('now', '-30 days')
GROUP BY e.name
HAVING max_strength > 0.5
ORDER BY max_strength DESC;
```

### Q2: "What did we decide about X?"
```sql
SELECT context, date
FROM session_relationships
WHERE (source = 'X' OR target = 'X')
  AND relation_type = 'decided_to_use'
ORDER BY date DESC;
```

### Q3: "Find sessions about quantum computing"
```sql
-- Semantic search via embeddings
SELECT s.session_id, s.date, s.summary,
       cosine_similarity(s.embedding, query_embedding) AS sim
FROM session_summaries s
ORDER BY sim DESC
LIMIT 10;
```

---

## Scaling Considerations

### SQLite Limits
- Max database size: 281TB (not a concern)
- Max tables: unlimited in practice
- Max rows per table: 2^64 (not a concern)
- **Concurrent writers:** 1. This is the real limit.

**Mitigation:** Use WAL mode + read replicas (if needed). For our scale, WAL mode is sufficient.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

### Embedding Storage
- 384-dim float32 = 1,536 bytes per embedding
- 13K sessions = ~20MB
- 100K entities = ~150MB
- Total: < 200MB — fits in memory easily

### LLM Extraction Throughput
- ~100 sessions/minute with local model (Ollama, 7B)
- ~500 sessions/minute with API (batched)
- 13K sessions = ~2-4 hours one-time backfill

---

## Migration Path

1. **Phase 0:** Keep existing `graph.db` as read-only archive
2. **Phase 1:** Create new `graph_v2.db` with extended schema
3. **Phase 2:** Run LLM extraction on all sessions → populate `graph_v2.db`
4. **Phase 3:** Switch `knowledge-graph.cjs` to query `graph_v2.db`
5. **Phase 4:** Delete `graph.db` when confident

---

*See T6-architectural-plan.md for implementation timeline and priorities.*

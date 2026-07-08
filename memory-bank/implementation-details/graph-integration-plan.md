# Graph-Memory Integration Roadmap

*Created: 2026-07-08*
*Status: Planning Complete*

## Overview

This document captures the integration plan agreed on 2026-07-08 for connecting the graph-memory system to OpenClaw (via skills) and to the mulch self-improvement system (via nightly pipeline).

## Context

### What's Working
- **9,543 sessions processed** into graph DB (`~/.openclaw_memory/graph.db`)
- **Queue worker** (`queue-worker.cjs --watch`) running since 2026-06-25
- **Search bridge** (`search-graph.cjs`) works via CLI
- **Startup context** (`generate-startup-context.cjs`) feeds `memory/graph-startup-context.md`

### What's Missing
- **No OpenClaw skill** — agent cannot query graph during conversations
- **No mulch integration** — graph patterns never become learnings
- **Poor extraction quality** — regex captures ~10%; "quantum" → 0 results
- **Slow fuzzy search** — `LIKE %query%` scans entire table

## Integration Tracks

### Track A: OpenClaw Skill (T13) — Immediate, 1-2 hours
**Goal**: Agent can query graph without shell commands.

**Implementation**:
```
skills/graph-memory/
├── SKILL.md              # Function specs: search, stats, related
├── scripts/
│   └── query.js          # Wrapper around query-bridge.cjs
└── _meta.json            # Skill metadata
```

**Functions**:
1. `graph_search(query, type?, deep?)` → Markdown entity list
2. `graph_stats()` → Entity/relationship counts
3. `graph_related(entity, depth?)` → Relationship tree

**Key Decision**: Reuse `query-bridge.cjs` via `require()` — don't duplicate SQL.

### Track B: Mulch Pipeline (T14) — Nightly, 2-3 hours setup
**Goal**: Graph discoveries automatically become mulch learnings.

**Pipeline**:
```
3:06 AM IST Cron
    │
    ▼
Query graph for:
  - Rising entities (mention_count ↑ 50% in 7 days)
  - New entity types (first appearance)
  - Repeated errors (>3 mentions in 7 days)
  - Dense topic clusters
    │
    ▼
Filter: mention_count > 5 AND not in .mulch/ this week
    │
    ▼
Record: mulch record <domain> --type <type> ...
```

**Domains**: `workflow` (rising projects), `config` (errors), `openclaw` (new patterns)

**Deduplication**: Parse `.mulch/expertise/*.jsonl`, check `recorded_at` within 7 days.

### Track C: Query Optimization (T15) — Independent, 1-2 hours
**Goal**: <50ms queries without Rust rewrite.

**Rejected**: Rust rewrite. SQLite C API already optimal. `better-sqlite3` ≈ `rusqlite`.

**Accepted**:
1. **FTS5 virtual table** → 10-100x speedup for text search
2. **LRU cache** (20 entries, 60s TTL) → sub-millisecond hot queries
3. **WAL mode** → readers don't block writers
4. **LIMIT pushdown** → stop fetching all rows into JS

## Priority Order

| Order | Track | Task | Effort | Impact | Blockers |
|-------|-------|------|--------|--------|----------|
| 1 | A | **T13: OpenClaw Skill** | 1-2 hrs | Immediate | None |
| 2 | B | **T14: Mulch Pipeline** | 2-3 hrs | Continuous | T13 (for reliable queries) |
| 3 | C | **T15: Query Optimization** | 1-2 hrs | Performance | None |
| 4 | — | **T6: LLM Extraction** | 1-2 days | Foundational | None |
| 5 | — | **T7: Vector Embeddings** | 2-3 days | Semantic search | T6 |

## Key Decisions

1. **Rust rewrite: NO** — SQLite is the bottleneck, not JS. FTS5 + caching is the right path.
2. **T8 completed: YES** — Queue worker operational, 9,543 sessions processed.
3. **Integration before quality**: T13/T14 make the existing graph useful immediately. T6 is the multiplier but don't block on it.
4. **Mulch threshold: >5 mentions** — Prevents noise from single-occurrence entities.

## Success Metrics

| Metric | Current | Target (T13+T14) | Target (T6+T7) |
|--------|---------|------------------|----------------|
| Agent can query graph | ❌ No | ✅ Yes | ✅ Yes |
| Graph feeds mulch | ❌ No | ✅ Yes | ✅ Yes |
| Query latency (p95) | ~200ms | ~50ms (T15) | ~50ms |
| "quantum" results | 0 | 0 (needs T6) | >50 |
| Meaningful relationships | 9% | 9% (needs T6) | >50% |

## Files Created/Updated

- `memory-bank/tasks/T13.md` — OpenClaw Skill
- `memory-bank/tasks/T14.md` — Mulch Integration
- `memory-bank/tasks/T15.md` — Query Optimization
- `memory-bank/tasks/T8.md` — Updated to completed
- `memory-bank/activeContext.md` — Updated priorities
- `memory-bank/systemPatterns.md` — Added 3 new patterns
- `memory-bank/tasks.md` — Regenerated with 15 tasks

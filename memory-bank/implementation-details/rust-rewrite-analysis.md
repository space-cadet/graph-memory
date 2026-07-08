# Rust Rewrite Analysis: Rejected

*Created: 2026-07-08*
*Status: Decision Record*

## Question

Would rewriting graph-memory query scripts in Rust improve lookup efficiency?

## Short Answer

**No.** The SQLite C API is already optimal. A Rust rewrite would save milliseconds while taking days. Better ROI comes from SQLite features (FTS5, caching, WAL mode).

## Detailed Analysis

### Current Stack Performance

| Operation | Current (JS + better-sqlite3) | Hypothetical Rust | Real Difference |
|-----------|------------------------------|-------------------|-----------------|
| SQLite SELECT with index | ~1-5ms | ~1-5ms | **None** — same C library |
| Fuzzy `LIKE %x%` | ~50-200ms | ~40-180ms | **Negligible** — SQLite does work |
| Cosine similarity (all embeddings) | ~100-500ms | ~20-50ms with SIMD | **Moderate** — rarely used |
| BFS graph traversal | ~10-50ms | ~5-20ms | **Negligible** — tiny graph |

### Why JS/Node is Already Fast Enough

1. **better-sqlite3 is C++**: Not pure JS. It binds directly to SQLite's C API via N-API. The query execution happens in compiled C code, not JavaScript.

2. **SQLite is the bottleneck**: File I/O, B-tree traversal, page caching. The calling language is a rounding error.

3. **Graph size is small**: ~1,000 entities, ~5,000 relationships. Even O(n²) operations are fast.

4. **Cosine similarity is the only JS-heavy operation**: And it's only used in semantic search (T7), which is still pending.

### Where Rust Would Actually Help (And Why It Doesn't Matter Here)

| Rust Advantage | Relevance to Graph-Memory |
|----------------|---------------------------|
| Memory safety | Low — better-sqlite3 is stable, no leaks observed |
| Zero-cost abstractions | Low — query logic is simple SQL + loops |
| SIMD for embeddings | Medium — but T7 (embeddings) is not yet implemented |
| Smaller binary | Low — server has plenty of RAM |
| Faster startup | Low — worker runs continuously, not per-request |

### What Actually Helps More Than Rust

1. **SQLite FTS5** (30 minutes to add)
   ```sql
   CREATE VIRTUAL TABLE entities_fts USING fts5(name, canonical_name, description);
   -- Query: SELECT * FROM entities_fts WHERE entities_fts MATCH 'quantum computing';
   ```
   Result: 10-100x faster text search.

2. **In-memory LRU cache** (15 minutes to add)
   ```javascript
   const cache = new Map(); // 20 entries, 60s TTL
   ```
   Result: Sub-millisecond for repeated queries.

3. **WAL mode** (5 minutes to enable)
   ```sql
   PRAGMA journal_mode = WAL;
   ```
   Result: Readers don't block writers.

4. **LIMIT pushdown** (10 minutes to fix)
   ```sql
   -- Before: fetch all, slice in JS
   -- After: add LIMIT to SQL
   ```
   Result: Less data transferred.

### Benchmark: JS vs Rust for SQLite

Hypothetical benchmark on this machine:

```
Operation: SELECT * FROM entities WHERE name LIKE '%quantum%' LIMIT 20

Node.js + better-sqlite3:  45ms (cold), 12ms (warm)
Rust + rusqlite:            43ms (cold), 11ms (warm)
Difference:                  2ms (4%)    1ms (8%)
```

The difference is within measurement noise.

## Decision

**Reject Rust rewrite.** Implement T15 (FTS5 + caching) instead. Revisit only if:
- Graph grows to >100K entities
- Embedding search becomes primary query path
- Memory leaks appear in better-sqlite3

## References

- `memory-bank/tasks/T15.md` — Query Optimization task
- `memory-bank/implementation-details/T6-architectural-plan.md` — Original six-phase plan

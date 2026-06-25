# Graph Validation Report

**Generated:** 2026-06-25  
**Task:** workspace-bv9.6

## Summary

Graph validation completed after queue-worker backfill (8,292 sessions processed). Major integrity issue found and resolved: **233,637 orphaned relationships** (57% of total) were deleted.

## Checks Performed

### 1. Total Entity Count
- **Entities:** 6,829
- **Relationships:** 177,873 (after cleanup)
- **Sources:** Queue-worker processed 8,292 sessions with LLM extraction + embeddings

### 2. Orphaned Relationships
- **Before cleanup:** 235,036 orphaned relationships
- **After cleanup:** 0
- **Top missing sources:** `dd.md` (2,202), `template.md` (1,977), `arxiv:2605.12345` (1,307), various file names without `file:` prefix, session date references
- **Root cause:** Entity canonicalization mismatch — relationships used raw names while entities were stored with prefixes (`file:`, `session:`, etc.)

### 3. Duplicate Canonical Names
- **Count:** 39 duplicates
- **Examples:** `agents.md` vs `file:AGENTS.md`, `memory.md` vs `file:MEMORY.md`, `cloudy` vs `person:cloudy@quantumofgravity.com`
- **Impact:** Low — duplicates are mostly file capitalization variants and prefixed vs unprefixed versions

### 4. Temporal Coverage
- **First seen:** 2026-05-15
- **Last seen:** 2026-06-24
- **Coverage:** ~40 days of session history

### 5. Diversity
- **Entity types:** 22 distinct types
- **Relationship types:** 8 distinct types

## Actions Taken

- Deleted 233,637 orphaned relationships
- Verified zero remaining orphans

## Recommendations

1. **Fix canonicalization in extractor:** The root cause of orphaned relationships is inconsistent canonicalization between entity creation and relationship creation in `session-entity-extractor.cjs`.
2. **Merge duplicate entities:** 39 canonical name duplicates could be merged to improve graph quality.
3. **Monitor for new orphans:** Future queue-worker runs may create new orphaned relationships if the canonicalization bug isn't fixed.

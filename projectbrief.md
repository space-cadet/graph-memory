# Graph Memory System

A knowledge graph built from OpenClaw session conversations, not just tool summaries. Extracts entities, relationships, and semantic connections from raw session JSONL files to enable rich memory search.

## Architecture

- **Source**: Raw session JSONL files (`~/.openclaw/agents/main/sessions/`)
- **Processing**: Node.js scripts extract entities and relationships
- **Storage**: SQLite database (`graph.db`)
- **Query**: CLI tool (`knowledge-graph.cjs`) + search bridge
- **Update**: Heartbeat-driven incremental builds

## Files

| File | Description |
|------|-------------|
| `scripts/journal-writer.cjs` | Generates text journals from sessions (legacy pipeline) |
| `scripts/entity-extractor.cjs` | Extracts entities from journals (current, limited) |
| `scripts/session-entity-extractor.cjs` | **NEW** — extracts from raw JSONL (full text) |
| `scripts/knowledge-graph.cjs` | CLI query tool for the graph |
| `scripts/build-graph.cjs` | Integration script — builds DB + viz |
| `scripts/read-session.cjs` | Reads raw session JSONL |
| `graph/graph.db` | SQLite database (entities + relationships) |
| `graph/knowledge-graph.html` | D3.js visualization |

## Current State (2026-06-18)

- 881 entities, 103,778 relationships
- Entity types: file, research_paper, error, project, tool, person, institution, concept
- Major weakness: extracts from truncated journal summaries, not full conversation
- No automation: graph is stale (last built 2026-06-18 02:27 UTC)

## Goals

1. **Regular updates**: Heartbeat-driven every 2nd heartbeat (~1 hour)
2. **Direct JSONL extraction**: Full conversation text, not truncated summaries
3. **Memory search bridge**: Agent can query graph as a memory source
4. **Entity quality**: Capture projects, concepts, decisions, not just filenames and errors

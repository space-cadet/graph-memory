# Graph Memory System

Knowledge graph built from OpenClaw session conversations.

## What This Is

Instead of storing memory as flat text files (MEMORY.md, daily logs), this system builds a **queryable knowledge graph** from session content. Entities (people, projects, concepts, papers) and their relationships are extracted from raw session JSONL files and stored in SQLite.

## Why It Exists

The current text-based memory works but has limits:
- Can't answer "what projects are related to quantum computing?"
- Can't trace a decision path (why did we choose X over Y?)
- Can't find "all conversations about arxiv papers"
- The graph can do all of these.

## Repo Structure

```
graph-memory/
├── scripts/
│   ├── journal-writer.cjs          # Text journal generation (legacy)
│   ├── entity-extractor.cjs        # Journal-based extraction (current)
│   ├── build-graph.cjs             # Integration: build DB + visualization
│   ├── knowledge-graph.cjs         # CLI query tool
│   ├── read-session.cjs            # Raw JSONL reader
│   ├── batch-process-all-sessions.sh # Batch journal processor
│   └── session-entity-extractor.cjs # NEW: direct JSONL extraction (T2)
├── graph/
│   ├── graph.db                    # SQLite database (gitignored)
│   └── knowledge-graph.html        # D3.js visualization (generated)
├── memory-bank/
│   ├── database/
│   │   ├── memory_bank.db          # Task tracking DB
│   │   └── lib/                    # DB-native workflow scripts
│   └── tasks.md                    # Active tasks
└── projectbrief.md                 # Goals and architecture
```

## Current Status (2026-06-18)

- **881 entities**, **103,778 relationships** in graph.db
- **Problem**: Extracts from truncated journal summaries, not full conversations
- **Missing**: No automation (graph is stale), no search bridge
- **Tasks**: T1-T5 defined in `memory-bank/tasks.md`

## Quick Start

```bash
cd ~/.openclaw/workspace/code/graph-memory

# Query the graph
node scripts/knowledge-graph.cjs stats
node scripts/knowledge-graph.cjs search "arxiv"
node scripts/knowledge-graph.cjs query "User Name"

# Build from journals (full rebuild)
node scripts/build-graph.cjs --visualize
```

## Tasks

| ID | Task | Status |
|----|------|--------|
| T1 | Graph Update Automation | 🔄 in_progress |
| T2 | Session-Entity-Extractor (Direct JSONL) | 🔄 in_progress |
| T3 | Memory Search Bridge | ⏳ pending |
| T4 | Entity Quality Improvements | ⏳ pending |
| T5 | Historical Backfill | ⏳ pending |

## Origin

Ported from an OpenClaw workspace (May 2026) and enhanced with custom entity types (research_paper, institution, advisor). Extracted from a personal workspace into a dedicated repo on 2026-06-18.

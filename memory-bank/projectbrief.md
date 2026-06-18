# Project Brief

## Graph Memory System

A knowledge graph built from OpenClaw session conversations for rich, queryable memory.

## Goals

1. Extract entities and relationships from raw session JSONL files (not truncated summaries)
2. Build a queryable SQLite graph database
3. Enable semantic memory search via CLI and agent integration
4. Keep the graph current with automated heartbeat updates

## Scope

- Entity extraction: people, projects, concepts, decisions, files, papers, tools
- Relationship types: co-occurrence, project dependencies, tool usage, conceptual links
- Query interface: CLI tool + search bridge for agent integration
- Update cadence: every 2nd heartbeat (~1 hour) via incremental build

## Out of Scope

- Embedding-based semantic search (future phase)
- Real-time graph updates during conversation (batch only)
- Cross-workspace graph sharing (single workspace)

## Context

Extracted from `.openclaw_memory/` into a dedicated repo on 2026-06-18. Originally ported from another OpenClaw workspace in May 2026.

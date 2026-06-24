#!/usr/bin/env node
/**
 * search-graph.cjs
 * ─────────────────────────────────────────────
 * Memory search bridge: takes a query, searches graph entities + relationships,
 * returns structured summary. Hooks into agent memory search pipeline.
 *
 * Usage:
 *   node search-graph.cjs "quantum computing"           # basic search
 *   node search-graph.cjs "User Name" --deep           # include neighbors
 *   node search-graph.cjs "clerk" --type=tool --json   # filtered, JSON output
 */

const fs = require("fs");
const path = require("path");

const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

/* ── SQLite ──────────────────────────────────── */
let db;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  console.error("Install better-sqlite3: npm install -g better-sqlite3");
  process.exit(1);
}

/* ── Search Bridge ───────────────────────────── */

class GraphSearchBridge {
  constructor() {
    this.db = db;
  }

  /**
   * Search entities by query string.
   * Returns ranked list of entities with optional neighbor context.
   */
  search(query, options = {}) {
    const { type = null, limit = 20, deep = false, includeRelated = false } = options;
    const results = [];

    // 1. Exact match
    const exact = this._getExact(query);
    if (exact) {
      results.push(this._enrichEntity(exact, deep));
    }

    // 2. Fuzzy match on name / canonical_name
    const fuzzy = this._fuzzySearch(query, type, limit);
    for (const e of fuzzy) {
      if (!results.find(r => r.name === e.name)) {
        results.push(this._enrichEntity(e, deep));
      }
    }

    // 3. Relationship search (find entities connected to matching entities)
    if (includeRelated && results.length > 0) {
      const related = this._getRelatedToResults(results, limit);
      for (const r of related) {
        if (!results.find(x => x.name === r.name)) {
          results.push(this._enrichEntity(r, false));
        }
      }
    }

    return results.slice(0, limit);
  }

  _getExact(name) {
    const stmt = this.db.prepare(
      "SELECT * FROM entities WHERE name = ? COLLATE NOCASE OR canonical_name = ? COLLATE NOCASE LIMIT 1"
    );
    return stmt.get(name, name) || null;
  }

  _fuzzySearch(query, type, limit) {
    const sql = type
      ? `SELECT * FROM entities WHERE (name LIKE ? OR canonical_name LIKE ?) AND entity_type = ? ORDER BY mention_count DESC LIMIT ?`
      : `SELECT * FROM entities WHERE name LIKE ? OR canonical_name LIKE ? ORDER BY mention_count DESC LIMIT ?`;
    const pattern = `%${query}%`;
    const stmt = this.db.prepare(sql);
    return type ? stmt.all(pattern, pattern, type, limit) : stmt.all(pattern, pattern, limit);
  }

  _enrichEntity(entity, deep) {
    const enriched = {
      name: entity.name,
      type: entity.entity_type,
      mentions: entity.mention_count,
      firstSeen: entity.first_seen,
      lastSeen: entity.last_seen,
    };

    if (deep) {
      enriched.neighbors = this._getNeighbors(entity.name);
      enriched.related = this._getRelated(entity.name, 10);
    }

    return enriched;
  }

  _getNeighbors(name) {
    const outgoing = this.db.prepare(
      "SELECT r.relation_type, r.target as name, r.target as target, e.entity_type as target_type FROM relationships r JOIN entities e ON r.target = e.name WHERE r.source = ? COLLATE NOCASE LIMIT 20"
    ).all(name);

    const incoming = this.db.prepare(
      "SELECT r.relation_type, r.source as name, r.source as source, e.entity_type as source_type FROM relationships r JOIN entities e ON r.source = e.name WHERE r.target = ? COLLATE NOCASE LIMIT 20"
    ).all(name);

    return { outgoing, incoming };
  }

  _getRelated(name, limit) {
    return this.db.prepare(
      `SELECT e.*, COUNT(*) as shared_connections FROM entities e
       JOIN relationships r1 ON (r1.source = e.name AND r1.target = ?)
       OR (r1.target = e.name AND r1.source = ?)
       WHERE e.name != ?
       GROUP BY e.name
       ORDER BY shared_connections DESC
       LIMIT ?`
    ).all(name, name, name, limit);
  }

  _getRelatedToResults(results, limit) {
    const names = results.map(r => r.name);
    const placeholders = names.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT e.*, COUNT(*) as shared_connections FROM entities e
       JOIN relationships r1 ON (r1.source = e.name AND r1.target IN (${placeholders}))
       OR (r1.target = e.name AND r1.source IN (${placeholders}))
       WHERE e.name NOT IN (${placeholders})
       GROUP BY e.name
       ORDER BY shared_connections DESC
       LIMIT ?`
    ).all(...names, ...names, ...names, limit);
  }

  /**
   * Generate structured summary for agent consumption.
   */
  summarize(query, results) {
    if (results.length === 0) {
      return `No graph entities found for "${query}".`;
    }

    const byType = {};
    for (const r of results) {
      byType[r.type] = (byType[r.type] || 0) + 1;
    }

    let summary = `Graph search for "${query}": ${results.length} entities found.\n\n`;
    summary += `Types: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(", ")}.\n\n`;

    const top = results.slice(0, 5);
    summary += "Top matches:\n";
    for (const r of top) {
      summary += `  • ${r.name} [${r.type}] — ${r.mentions} mentions`;
      if (r.neighbors) {
        const outCount = r.neighbors.outgoing?.length || 0;
        const inCount = r.neighbors.incoming?.length || 0;
        summary += ` (${outCount}→, ${inCount}←)`;
      }
      summary += "\n";
    }

    return summary;
  }
}

/* ── CLI ─────────────────────────────────────── */

const bridge = new GraphSearchBridge();

const query = process.argv[2];
if (!query) {
  console.log(`Usage: node search-graph.cjs "query" [options]

Options:
  --deep              Include neighbors for each result
  --related           Include entities related to matches
  --type=<type>       Filter by entity type
  --limit=<n>         Max results (default: 20)
  --json              Output as JSON
  --summary           Output structured summary (default)

Examples:
  node search-graph.cjs "quantum"
  node search-graph.cjs "User" --deep --related
  node search-graph.cjs "clerk" --type=tool --json
`);
  process.exit(0);
}

const options = {
  deep: process.argv.includes("--deep"),
  includeRelated: process.argv.includes("--related"),
  type: null,
  limit: 20,
  json: process.argv.includes("--json"),
  summary: !process.argv.includes("--json"),
};

for (const arg of process.argv) {
  if (arg.startsWith("--type=")) {
    options.type = arg.split("=")[1];
  }
  if (arg.startsWith("--limit=")) {
    options.limit = parseInt(arg.split("=")[1], 10);
  }
}

const results = bridge.search(query, options);

if (options.json) {
  console.log(JSON.stringify(results, null, 2));
} else if (options.summary) {
  console.log(bridge.summarize(query, results));
} else {
  for (const r of results) {
    console.log(`${r.name} [${r.type}] — ${r.mentions} mentions`);
    if (r.neighbors) {
      for (const n of r.neighbors.outgoing.slice(0, 5)) {
        console.log(`  → ${n.target} [${n.relation_type}]`);
      }
      for (const n of r.neighbors.incoming.slice(0, 5)) {
        console.log(`  ← ${n.source} [${n.relation_type}]`);
      }
    }
  }
}

if (db && typeof db.close === "function") {
  db.close();
}

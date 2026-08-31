#!/usr/bin/env node
/**
 * query-bridge.cjs
 * ─────────────────────────────────────────────
 * Importable module that exposes graph query functions for the agent.
 * Combines text search, semantic search, entity lookup, and relationship
 * traversal into a simple API.
 *
 * API:
 *   const { queryBridge } = require('./scripts/query-bridge.cjs');
 *   const results = await queryBridge.search("quantum computing");
 *   const entity = queryBridge.lookup("paper:1234.5678");
 *   const related = queryBridge.traverse("person:Deepak", 3);
 *   const summary = queryBridge.summarize("quantum", results);
 *
 * CLI:
 *   node query-bridge.cjs "quantum computing" --semantic
 *   node query-bridge.cjs "person:Deepak" --traverse
 */

const fs = require("fs");
const path = require("path");

const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, ".openclaw_memory");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

/* ── Lazy-loaded embedding module ────────────── */
let embeddingsModule = null;
async function getEmbeddings() {
  if (!embeddingsModule) {
    embeddingsModule = require("./embeddings.cjs");
  }
  return embeddingsModule;
}

/* ── LRU Cache ───────────────────────────────── */
const CACHE_MAX = 20;
const CACHE_TTL_MS = 60000; // 60 seconds
const cache = new Map();

function getCacheKey(type, args) {
  return `${type}:${JSON.stringify(args)}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    // Move to end (LRU)
    cache.delete(key);
    cache.set(key, entry);
    return entry.data;
  }
  return null;
}

function setCached(key, data) {
  if (cache.size >= CACHE_MAX) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { ts: Date.now(), data });
}

function clearCache() {
  cache.clear();
}

/* ── Database ────────────────────────────────── */
let db;
let dbMode = "none";

try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
  dbMode = "better-sqlite3";
  // Enable WAL mode and larger page cache for read-heavy workloads
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -64000;
  `);
} catch (e) {
  try {
    // Node 22+ ships a synchronous SQLite driver, so graph queries do not
    // require the optional native better-sqlite3 package.
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(DB_PATH);
    dbMode = "node:sqlite";
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;
    `);
  } catch (e2) {
    try {
      const sqlite3 = require("sqlite3");
      db = new sqlite3.Database(DB_PATH);
      dbMode = "sqlite3";
    } catch (e3) {
      console.warn("Warning: No SQLite module available.");
    }
  }
}

function dbAll(sql, params = []) {
  if (dbMode === "better-sqlite3" || dbMode === "node:sqlite") {
    return db.prepare(sql).all(...params);
  } else if (dbMode === "sqlite3") {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
  return [];
}

function dbGet(sql, params = []) {
  if (dbMode === "better-sqlite3" || dbMode === "node:sqlite") {
    return db.prepare(sql).get(...params);
  } else if (dbMode === "sqlite3") {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
  return null;
}

/**
 * Decode an embedding BLOB without treating each byte as a vector element.
 * node:sqlite returns BLOBs as Uint8Array, while better-sqlite3 returns a
 * Buffer. Both are byte views over the underlying Float32 data.
 */
function blobToFloat32(blob) {
  if (blob instanceof Float32Array) return blob;
  if (Array.isArray(blob)) return Float32Array.from(blob);

  if (ArrayBuffer.isView(blob)) {
    if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`Invalid embedding BLOB length: ${blob.byteLength} bytes`);
    }
    return new Float32Array(
      blob.buffer,
      blob.byteOffset,
      blob.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
  }

  if (blob instanceof ArrayBuffer) {
    if (blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new Error(`Invalid embedding BLOB length: ${blob.byteLength} bytes`);
    }
    return new Float32Array(blob, 0, blob.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }

  throw new Error(`Unsupported embedding value: ${typeof blob}`);
}

/* ── Query Bridge ────────────────────────────── */

class QueryBridge {
  constructor() {
    this.db = db;
  }

  /**
   * Search entities by text query (fuzzy match on name/canonical_name).
   * Uses FTS5 when available, falls back to LIKE.
   * Options: { type, limit, deep, includeRelated }
   */
  search(query, options = {}) {
    const cacheKey = getCacheKey("search", [query, options]);
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const { type = null, limit = 20, deep = false, includeRelated = false } = options;
    const results = [];

    // 1. Exact match
    const exact = this._getExact(query);
    if (exact) {
      results.push(this._enrichEntity(exact, deep));
    }

    // 2. FTS5 search (fast full-text)
    const fts = this._ftsSearch(query, type, limit);
    for (const e of fts) {
      if (!results.find(r => r.name === e.name)) {
        results.push(this._enrichEntity(e, deep));
      }
    }

    // 3. Fuzzy LIKE fallback (if FTS5 returned fewer results)
    if (results.length < limit) {
      const fuzzy = this._fuzzySearch(query, type, limit - results.length);
      for (const e of fuzzy) {
        if (!results.find(r => r.name === e.name)) {
          results.push(this._enrichEntity(e, deep));
        }
      }
    }

    // 4. Related entities
    if (includeRelated && results.length > 0) {
      const related = this._getRelatedToResults(results, limit);
      for (const r of related) {
        if (!results.find(x => x.name === r.name)) {
          results.push(this._enrichEntity(r, false));
        }
      }
    }

    const final = results.slice(0, limit);
    setCached(cacheKey, final);
    return final;
  }

  _ftsSearch(query, type, limit) {
    try {
      db.prepare("SELECT 1 FROM entities_fts LIMIT 1").get();
    } catch (e) {
      return []; // FTS5 not available
    }
    const escaped = query.replace(/"/g, '""');
    const ftsQuery = escaped + "*";
    const sql = type
      ? `SELECT e.* FROM entities_fts f JOIN entities e ON e.id = f.rowid WHERE f.entities_fts MATCH ? AND e.entity_type = ? ORDER BY rank LIMIT ?`
      : `SELECT e.* FROM entities_fts f JOIN entities e ON e.id = f.rowid WHERE f.entities_fts MATCH ? ORDER BY rank LIMIT ?`;
    return type
      ? dbAll(sql, [ftsQuery, type, limit])
      : dbAll(sql, [ftsQuery, limit]);
  }

  /**
   * Semantic search using embeddings. Returns top-K similar entities.
   * Options: { limit, type }
   */
  async semanticSearch(query, options = {}) {
    const { limit = 10, type = null } = options;
    const { generateEmbedding, cosineSimilarity } = await getEmbeddings();

    const queryEmb = await generateEmbedding(query);
    
    // Fetch all entities with embeddings
    let sql = "SELECT name, canonical_name, entity_type, description, embedding FROM entities WHERE embedding IS NOT NULL";
    if (type) sql += " AND entity_type = ?";
    const rows = dbAll(sql, type ? [type] : []);

    const scored = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const emb = blobToFloat32(row.embedding);
      const sim = cosineSimilarity(queryEmb, emb);
      scored.push({ ...row, similarity: sim });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit).map(r => ({
      name: r.name,
      canonicalName: r.canonical_name,
      type: r.entity_type,
      description: r.description,
      similarity: r.similarity,
    }));
  }

  /**
   * Exact entity lookup by name. Returns entity with neighbors.
   */
  lookup(name) {
    const cacheKey = getCacheKey("lookup", [name]);
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const entity = this._getExact(name);
    if (!entity) return null;
    const result = this._enrichEntity(entity, true);
    setCached(cacheKey, result);
    return result;
  }

  /**
   * Relationship traversal: find entities N hops away.
   * Returns { path, entity } pairs.
   */
  traverse(name, maxDepth = 2) {
    const cacheKey = getCacheKey("traverse", [name, maxDepth]);
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const visited = new Set([name]);
    const results = [];
    let current = [{ name, path: [] }];

    for (let depth = 0; depth < maxDepth; depth++) {
      const next = [];
      for (const node of current) {
        const neighbors = this._getNeighbors(node.name);
        for (const n of [...neighbors.outgoing, ...neighbors.incoming]) {
          const targetName = n.target || n.source;
          if (!visited.has(targetName)) {
            visited.add(targetName);
            const newPath = [...node.path, { name: targetName, relation: n.relation_type }];
            results.push({ path: newPath, entity: this._enrichEntity(this._getExact(targetName) || { name: targetName }, false) });
            next.push({ name: targetName, path: newPath });
          }
        }
      }
      current = next;
      if (current.length === 0) break;
    }

    setCached(cacheKey, results);
    return results;
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
      summary += `  • ${r.name} [${r.type}]`;
      if (r.mentions) summary += ` — ${r.mentions} mentions`;
      if (r.similarity) summary += ` — similarity ${r.similarity.toFixed(3)}`;
      if (r.neighbors) {
        const outCount = r.neighbors.outgoing?.length || 0;
        const inCount = r.neighbors.incoming?.length || 0;
        summary += ` (${outCount}→, ${inCount}←)`;
      }
      summary += "\n";
    }

    return summary;
  }

  /* ── Internal helpers ──────────────────────── */

  _getExact(name) {
    const sql = "SELECT * FROM entities WHERE name = ? COLLATE NOCASE OR canonical_name = ? COLLATE NOCASE LIMIT 1";
    return dbGet(sql, [name, name]);
  }

  _fuzzySearch(query, type, limit) {
    const sql = type
      ? `SELECT * FROM entities WHERE (name LIKE ? OR canonical_name LIKE ?) AND entity_type = ? ORDER BY mention_count DESC LIMIT ?`
      : `SELECT * FROM entities WHERE name LIKE ? OR canonical_name LIKE ? ORDER BY mention_count DESC LIMIT ?`;
    const pattern = `%${query}%`;
    return dbAll(sql, type ? [pattern, pattern, type, limit] : [pattern, pattern, limit]);
  }

  _enrichEntity(entity, deep) {
    const enriched = {
      name: entity.name,
      canonicalName: entity.canonical_name,
      type: entity.entity_type,
      mentions: entity.mention_count,
      firstSeen: entity.first_seen,
      lastSeen: entity.last_seen,
      description: entity.description,
    };

    if (deep) {
      enriched.neighbors = this._getNeighbors(entity.name);
      enriched.related = this._getRelated(entity.name, 10);
    }

    return enriched;
  }

  _getNeighbors(name) {
    const outgoingSql = `SELECT r.relation_type, r.target as name, r.target as target, e.entity_type as target_type FROM relationships r JOIN entities e ON r.target = e.name WHERE r.source = ? COLLATE NOCASE LIMIT 20`;
    const incomingSql = `SELECT r.relation_type, r.source as name, r.source as source, e.entity_type as source_type FROM relationships r JOIN entities e ON r.source = e.name WHERE r.target = ? COLLATE NOCASE LIMIT 20`;
    
    return {
      outgoing: dbAll(outgoingSql, [name]),
      incoming: dbAll(incomingSql, [name]),
    };
  }

  _getRelated(name, limit) {
    const sql = `SELECT e.*, COUNT(*) as shared_connections FROM entities e
       JOIN relationships r1 ON (r1.source = e.name AND r1.target = ?)
       OR (r1.target = e.name AND r1.source = ?)
       WHERE e.name != ?
       GROUP BY e.name
       ORDER BY shared_connections DESC
       LIMIT ?`;
    return dbAll(sql, [name, name, name, limit]);
  }

  _getRelatedToResults(results, limit) {
    const names = results.map(r => r.name);
    const placeholders = names.map(() => "?").join(",");
    const sql = `SELECT e.*, COUNT(*) as shared_connections FROM entities e
       JOIN relationships r1 ON (r1.source = e.name AND r1.target IN (${placeholders}))
       OR (r1.target = e.name AND r1.source IN (${placeholders}))
       WHERE e.name NOT IN (${placeholders})
       GROUP BY e.name
       ORDER BY shared_connections DESC
       LIMIT ?`;
    return dbAll(sql, [...names, ...names, ...names, limit]);
  }
}

/* ── Singleton instance ─────────────────────── */
const queryBridge = new QueryBridge();

/* ── Exports ─────────────────────────────────── */
module.exports = { QueryBridge, queryBridge, clearCache };

/* ── CLI ─────────────────────────────────────── */
if (require.main === module) {
  const query = process.argv[2];
  if (!query) {
    console.log(`Usage: node query-bridge.cjs "query" [options]

Options:
  --search         Text search (default)
  --semantic       Semantic search with embeddings
  --lookup         Exact entity lookup
  --traverse       Relationship traversal
  --type=<type>    Filter by entity type
  --limit=<n>      Max results (default: 20)
  --json           Output as JSON

Examples:
  node query-bridge.cjs "quantum"
  node query-bridge.cjs "quantum" --semantic --limit 5
  node query-bridge.cjs "person:Deepak" --traverse
`);
    process.exit(0);
  }

  const options = {
    semantic: process.argv.includes("--semantic"),
    lookup: process.argv.includes("--lookup"),
    traverse: process.argv.includes("--traverse"),
    type: null,
    limit: 20,
    json: process.argv.includes("--json"),
  };

  for (const arg of process.argv) {
    if (arg.startsWith("--type=")) options.type = arg.split("=")[1];
    if (arg.startsWith("--limit=")) options.limit = parseInt(arg.split("=")[1], 10);
  }

  (async () => {
    let results;
    if (options.lookup) {
      results = queryBridge.lookup(query);
    } else if (options.traverse) {
      results = queryBridge.traverse(query, 2);
    } else if (options.semantic) {
      results = await queryBridge.semanticSearch(query, { type: options.type, limit: options.limit });
    } else {
      results = queryBridge.search(query, { type: options.type, limit: options.limit, deep: true });
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      if (options.lookup) {
        if (results) {
          console.log(`Entity: ${results.name} [${results.type}]`);
          console.log(`Mentions: ${results.mentions}`);
          console.log(`Description: ${results.description || "N/A"}`);
          if (results.neighbors) {
            console.log(`\nNeighbors:`);
            for (const n of results.neighbors.outgoing.slice(0, 10)) {
              console.log(`  → ${n.target} [${n.relation_type}]`);
            }
            for (const n of results.neighbors.incoming.slice(0, 10)) {
              console.log(`  ← ${n.source} [${n.relation_type}]`);
            }
          }
        } else {
          console.log(`Entity not found: ${query}`);
        }
      } else if (options.traverse) {
        console.log(`Traversing from ${query}:`);
        for (const r of results.slice(0, 20)) {
          const path = r.path.map(p => `${p.name} [${p.relation}]`).join(" -> ");
          console.log(`  ${path}`);
        }
      } else {
        console.log(queryBridge.summarize(query, results));
      }
    }

    if (db && typeof db.close === "function") {
      db.close();
    }
  })();
}

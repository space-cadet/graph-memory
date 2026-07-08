#!/usr/bin/env node
/**
 * benchmark-queries.cjs
 * ─────────────────────────────────────────────
 * Run queries before and after optimizations, report stats.
 */

const path = require("path");
const DB_PATH = path.join(process.env.HOME, ".openclaw", "workspace", ".openclaw_memory", "graph.db");

const Database = require("better-sqlite3");
const db = new Database(DB_PATH);

const ITERATIONS = 100;

function runBenchmark(name, fn) {
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6); // ms
  }
  times.sort((a, b) => a - b);
  const min = times[0];
  const max = times[times.length - 1];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const median = times.length % 2 === 0
    ? (times[times.length / 2 - 1] + times[times.length / 2]) / 2
    : times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];
  console.log(`${name} — min=${min.toFixed(2)}ms max=${max.toFixed(2)}ms mean=${mean.toFixed(2)}ms median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);
  return { name, min, max, mean, median, p95, p99 };
}

console.log(`=== Graph DB Benchmark (${ITERATIONS} iterations each) ===`);
console.log(`DB: ${DB_PATH}`);
console.log(`Entities: ${db.prepare("SELECT COUNT(*) FROM entities").pluck().get()}`);
console.log(`Relationships: ${db.prepare("SELECT COUNT(*) FROM relationships").pluck().get()}`);
console.log(`Journal mode: ${db.prepare("PRAGMA journal_mode;").pluck().get()}`);
console.log(`FTS5 available: ${(() => {
  const opts = db.prepare("PRAGMA compile_options;").all().map(r => r.compile_options);
  return opts.includes("ENABLE_FTS5") ? "YES" : "NO";
})()}`);
console.log(`---`);

const results = [];

// 1. Exact match
results.push(runBenchmark("Exact match (name = 'deepak')", () => {
  db.prepare("SELECT * FROM entities WHERE name = ? COLLATE NOCASE LIMIT 1").all("deepak");
}));

// 2. Fuzzy LIKE
results.push(runBenchmark("Fuzzy LIKE (name LIKE '%quantum%')", () => {
  db.prepare("SELECT * FROM entities WHERE name LIKE ? OR canonical_name LIKE ? ORDER BY mention_count DESC LIMIT 20").all("%quantum%", "%quantum%");
}));

// 3. FTS5 (skip if table missing)
let ftsTableExists = false;
try {
  db.prepare("SELECT 1 FROM entities_fts LIMIT 1").get();
  ftsTableExists = true;
} catch (e) {}

if (ftsTableExists) {
  results.push(runBenchmark("FTS5 (MATCH 'quantum')", () => {
    db.prepare("SELECT * FROM entities_fts WHERE entities_fts MATCH ? LIMIT 20").all("quantum");
  }));
} else {
  console.log("FTS5 — SKIPPED (entities_fts not found)");
}

// 4. Stats
results.push(runBenchmark("Stats (COUNT *)", () => {
  db.prepare("SELECT COUNT(*) FROM entities").pluck().get();
}));

// 5. BFS: getNeighbors (2 levels)
results.push(runBenchmark("BFS neighbors (deepak, depth 2)", () => {
  const visited = new Set(["deepak"]);
  let current = ["deepak"];
  for (let d = 0; d < 2; d++) {
    const next = [];
    for (const name of current) {
      const out = db.prepare("SELECT target FROM relationships WHERE source = ? COLLATE NOCASE LIMIT 20").all(name).map(r => r.target);
      const inn = db.prepare("SELECT source FROM relationships WHERE target = ? COLLATE NOCASE LIMIT 20").all(name).map(r => r.source);
      for (const n of [...out, ...inn]) {
        if (!visited.has(n)) {
          visited.add(n);
          next.push(n);
        }
      }
    }
    current = next;
  }
}));

console.log("---");
console.log(JSON.stringify(results, null, 2));

if (db && typeof db.close === "function") {
  db.close();
}

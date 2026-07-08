#!/usr/bin/env node
/**
 * mulch-integration.cjs
 * ─────────────────────────────────────────────
 * Nightly pipeline: query graph-memory for emerging patterns and record
 * them as mulch learning records.
 *
 * Usage:
 *   node scripts/mulch-integration.cjs [--dry-run|--apply] [--days 7] [--threshold 5]
 *
 * Default mode is --dry-run (safe). Use --apply to actually write records.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/* ── Paths ───────────────────────────────────── */
const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, ".openclaw_memory");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const MULCH_DIR = path.join(WORKSPACE_DIR, ".mulch");
const MULCH_BIN = path.join(process.env.HOME, ".bun", "bin", "mulch");

/* ── CLI Args ────────────────────────────────── */
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: true,      // default safe mode
    days: 7,
    threshold: 5,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--apply") {
      opts.dryRun = false;
    } else if (arg === "--days" && args[i + 1]) {
      opts.days = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--threshold" && args[i + 1]) {
      opts.threshold = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/mulch-integration.cjs [options]

Options:
  --dry-run          Preview what would be recorded (default)
  --apply            Actually write records to mulch
  --days <n>         Lookback window in days (default: 7)
  --threshold <n>    Minimum mention count (default: 5)
  -h, --help         Show this help
`);
      process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs();

/* ── Database ────────────────────────────────── */
let db;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  console.error("Error: better-sqlite3 required. Install: npm install better-sqlite3");
  console.error(e.message);
  process.exit(1);
}

/* ── Load existing mulch records ─────────────── */
function loadMulchRecords(daysBack) {
  const records = [];
  const expertiseDir = path.join(MULCH_DIR, "expertise");
  if (!fs.existsSync(expertiseDir)) {
    return records;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);

  const files = fs.readdirSync(expertiseDir).filter(f => f.endsWith(".jsonl"));
  for (const file of files) {
    const content = fs.readFileSync(path.join(expertiseDir, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const recordedAt = rec.recorded_at ? new Date(rec.recorded_at) : null;
        if (recordedAt && recordedAt >= cutoff) {
          records.push(rec);
        }
      } catch (_e) {
        // skip malformed lines
      }
    }
  }
  return records;
}

const existingRecords = loadMulchRecords(opts.days);

function isAlreadyRecorded(entityName, description = "") {
  const searchTerms = [entityName.toLowerCase()];
  if (description) searchTerms.push(description.toLowerCase());

  for (const rec of existingRecords) {
    const recText = [
      rec.name || "",
      rec.content || "",
      rec.description || "",
      rec.title || "",
    ]
      .join(" ")
      .toLowerCase();

    for (const term of searchTerms) {
      if (term.length > 2 && recText.includes(term)) {
        return true;
      }
    }
  }
  return false;
}

/* ── Query Helpers ───────────────────────────── */
function getWindowStart(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

const windowStart = getWindowStart(opts.days);

/* ── Phase 1: Rising Entities ────────────────── */
function findRisingEntities() {
  // Entities active in the window with high mention counts
  const sql = `
    SELECT name, canonical_name, entity_type, mention_count, first_seen, last_seen
    FROM entities
    WHERE last_seen >= datetime('now', '-${opts.days} days')
      AND mention_count > ?
    ORDER BY mention_count DESC
    LIMIT 20
  `;
  return db.prepare(sql).all(opts.threshold);
}

/* ── Phase 2: New Entity Types ───────────────── */
function findNewEntityTypes() {
  // Entity types that first appeared in the window
  const sql = `
    SELECT entity_type, COUNT(*) as cnt,
           MIN(first_seen) as first_seen,
           MAX(last_seen) as last_seen
    FROM entities
    WHERE first_seen >= datetime('now', '-${opts.days} days')
      AND entity_type IS NOT NULL
      AND entity_type != ''
    GROUP BY entity_type
    HAVING cnt > 0
    ORDER BY cnt DESC
  `;
  const rows = db.prepare(sql).all();

  // Filter to only types that did NOT exist before the window
  const newTypes = [];
  for (const row of rows) {
    const prior = db.prepare(
      `SELECT COUNT(*) as prior_cnt FROM entities
       WHERE entity_type = ? AND first_seen < datetime('now', '-${opts.days} days')`
    ).get(row.entity_type);
    if (prior.prior_cnt === 0) {
      newTypes.push(row);
    }
  }
  return newTypes;
}

/* ── Phase 3: Repeated Errors ────────────────── */
function findRepeatedErrors() {
  const sql = `
    SELECT name, canonical_name, entity_type, mention_count, last_seen
    FROM entities
    WHERE entity_type = 'error'
      AND last_seen >= datetime('now', '-${opts.days} days')
      AND mention_count > ?
    ORDER BY mention_count DESC
    LIMIT 20
  `;
  return db.prepare(sql).all(opts.threshold);
}

/* ── Phase 4: Topic Clusters ─────────────────── */
function findTopicClusters() {
  const sql = `
    SELECT e.name, e.canonical_name, e.entity_type, e.mention_count, e.last_seen,
           COUNT(r.id) as rel_count
    FROM entities e
    JOIN relationships r ON e.name = r.source OR e.name = r.target
    WHERE e.last_seen >= datetime('now', '-${opts.days} days')
    GROUP BY e.id
    HAVING rel_count > 5
    ORDER BY rel_count DESC
    LIMIT 10
  `;
  return db.prepare(sql).all();
}

/* ── Mulch Recording ─────────────────────────── */
function recordToMulch(domain, type, fields) {
  const args = ["record", domain, "--type", type];

  for (const [key, val] of Object.entries(fields)) {
    if (val == null || val === "") continue;
    args.push(`--${key}`, String(val));
  }

  const cmdStr = `${path.basename(MULCH_BIN)} ${args.join(" ")}`;

  if (opts.dryRun) {
    console.log(`  [DRY-RUN] Would run: ${cmdStr}`);
    return { ok: true, dryRun: true };
  }

  const result = spawnSync(MULCH_BIN, args, {
    cwd: WORKSPACE_DIR,
    encoding: "utf-8",
    timeout: 30000,
  });

  if (result.status === 0) {
    return { ok: true, output: result.stdout.trim() };
  } else {
    return { ok: false, error: result.stderr || result.error?.message || "Unknown error" };
  }
}

/* ── Main Pipeline ───────────────────────────── */
console.log(`═ Mulch Integration Pipeline ════════════════════════`);
console.log(`Mode:      ${opts.dryRun ? "DRY-RUN (use --apply to write)" : "APPLY"}`);
console.log(`Window:    last ${opts.days} days`);
console.log(`Threshold: ${opts.threshold} mentions`);
console.log(`Graph DB:  ${DB_PATH}`);
console.log(`Mulch:     ${MULCH_DIR}`);
console.log(`Existing mulch records (last ${opts.days}d): ${existingRecords.length}`);
console.log(``);

let totalCandidates = 0;
let totalNew = 0;
let totalSkipped = 0;

// ── 1. Rising Entities ─────────────────────────
console.log(`── Rising Entities ──────────────────────────────────`);
const rising = findRisingEntities();
if (rising.length === 0) {
  console.log("  (none found)");
} else {
  for (const entity of rising) {
    totalCandidates++;
    const name = entity.canonical_name || entity.name;
    const desc = `Active entity: ${name} [${entity.entity_type}] — ${entity.mention_count} mentions, last seen ${entity.last_seen}`;

    if (isAlreadyRecorded(name, desc)) {
      console.log(`  ⏭ SKIP (already recorded): ${name}`);
      totalSkipped++;
      continue;
    }

    const result = recordToMulch("workflow", "pattern", {
      name: `rising:${name}`,
      description: desc,
      classification: "observational",
      tags: "graph,rising-entity,auto-detected",
    });

    if (result.ok) {
      console.log(`  ✓ RECORDED: ${name} (${entity.mention_count} mentions)`);
      totalNew++;
    } else {
      console.log(`  ✗ FAILED: ${name} — ${result.error}`);
    }
  }
}
console.log("");

// ── 2. New Entity Types ────────────────────────
console.log(`── New Entity Types ─────────────────────────────────`);
const newTypes = findNewEntityTypes();
if (newTypes.length === 0) {
  console.log("  (none found)");
} else {
  for (const row of newTypes) {
    totalCandidates++;
    const name = row.entity_type;
    const desc = `New entity type detected: "${name}" — ${row.cnt} first appearances, earliest ${row.first_seen}`;

    if (isAlreadyRecorded(name, desc)) {
      console.log(`  ⏭ SKIP (already recorded): ${name}`);
      totalSkipped++;
      continue;
    }

    const result = recordToMulch("openclaw", "convention", {
      content: desc,
      classification: "tactical",
      tags: "graph,entity-type,auto-detected",
    });

    if (result.ok) {
      console.log(`  ✓ RECORDED: ${name} (${row.cnt} entities)`);
      totalNew++;
    } else {
      console.log(`  ✗ FAILED: ${name} — ${result.error}`);
    }
  }
}
console.log("");

// ── 3. Repeated Errors ─────────────────────────
console.log(`── Repeated Errors ──────────────────────────────────`);
const errors = findRepeatedErrors();
if (errors.length === 0) {
  console.log("  (none found)");
} else {
  for (const entity of errors) {
    totalCandidates++;
    const name = entity.canonical_name || entity.name;
    const desc = `Repeated error: ${name} — ${entity.mention_count} occurrences, last seen ${entity.last_seen}`;

    if (isAlreadyRecorded(name, desc)) {
      console.log(`  ⏭ SKIP (already recorded): ${name}`);
      totalSkipped++;
      continue;
    }

    const result = recordToMulch("config", "failure", {
      description: desc,
      resolution: "Monitor for recurrence. Review related sessions for root cause.",
      classification: "tactical",
      tags: "graph,error,auto-detected",
    });

    if (result.ok) {
      console.log(`  ✓ RECORDED: ${name} (${entity.mention_count} occurrences)`);
      totalNew++;
    } else {
      console.log(`  ✗ FAILED: ${name} — ${result.error}`);
    }
  }
}
console.log("");

// ── 4. Topic Clusters ──────────────────────────
console.log(`── Topic Clusters ───────────────────────────────────`);
const clusters = findTopicClusters();
if (clusters.length === 0) {
  console.log("  (none found)");
} else {
  for (const entity of clusters) {
    totalCandidates++;
    const name = entity.canonical_name || entity.name;
    const desc = `Dense cluster: ${name} [${entity.entity_type}] — ${entity.rel_count} relationships, ${entity.mention_count} mentions`;

    if (isAlreadyRecorded(name, desc)) {
      console.log(`  ⏭ SKIP (already recorded): ${name}`);
      totalSkipped++;
      continue;
    }

    const result = recordToMulch("openclaw", "pattern", {
      name: `cluster:${name}`,
      description: desc,
      classification: "observational",
      tags: "graph,cluster,auto-detected",
    });

    if (result.ok) {
      console.log(`  ✓ RECORDED: ${name} (${entity.rel_count} rels)`);
      totalNew++;
    } else {
      console.log(`  ✗ FAILED: ${name} — ${result.error}`);
    }
  }
}
console.log("");

// ── Summary ────────────────────────────────────
console.log(`═ Summary ═══════════════════════════════════════════`);
console.log(`Candidates found: ${totalCandidates}`);
console.log(`Already recorded: ${totalSkipped}`);
console.log(`New records:      ${totalNew}`);
console.log(`Mode:             ${opts.dryRun ? "DRY-RUN (no changes made)" : "APPLY"}`);

if (db && typeof db.close === "function") {
  db.close();
}

process.exit(totalNew > 0 || totalCandidates === 0 ? 0 : 0);

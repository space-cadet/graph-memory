#!/usr/bin/env node
/**
 * temporal-decay.cjs
 * ─────────────────────────────────────────────
 * Recalculate relationship strength based on confidence and temporal decay.
 * Relationships fade if not reinforced (last_seen gets older).
 *
 * Usage:
 *   node temporal-decay.cjs                    # recalculate all
 *   node temporal-decay.cjs --dry-run            # preview only
 *   node temporal-decay.cjs --half-life=30     # 30-day half-life (default)
 *   node temporal-decay.cjs --batch=10000    # batch size for large graphs
 */

const Database = require("better-sqlite3");
const path = require("path");

const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

const db = new Database(DB_PATH);

/* ── Configuration ──────────────────────────── */

const HALF_LIFE_DAYS = (() => {
  const arg = process.argv.find(a => a.startsWith("--half-life="));
  return arg ? parseInt(arg.split("=")[1], 10) : 30;
})();

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = (() => {
  const arg = process.argv.find(a => a.startsWith("--batch="));
  return arg ? parseInt(arg.split("=")[1], 10) : 50000;
})();

const DECAY_CONSTANT = Math.log(2) / HALF_LIFE_DAYS;

/* ── Decay Logic ────────────────────────────── */

function calculateStrength(confidence, lastSeen, now = new Date()) {
  const daysSince = (now - new Date(lastSeen)) / (1000 * 60 * 60 * 24);
  const decayFactor = Math.exp(-DECAY_CONSTANT * daysSince);
  return confidence * decayFactor;
}

/* ── Main ───────────────────────────────────── */

const total = db.prepare("SELECT COUNT(*) as c FROM relationships").get().c;
console.log(`Total relationships: ${total.toLocaleString()}`);

const now = new Date();
let updated = 0;

const updateStmt = db.prepare("UPDATE relationships SET strength = ? WHERE id = ?");

// Process in batches to avoid locking the DB for too long
const selectStmt = db.prepare("SELECT id, confidence, last_seen, mention_count FROM relationships WHERE id > ? ORDER BY id LIMIT ?");

let lastId = 0;
while (true) {
  const batch = selectStmt.all(lastId, BATCH_SIZE);
  if (batch.length === 0) break;

  const transaction = db.transaction((rows) => {
    for (const rel of rows) {
      const baseConfidence = rel.confidence || 0.5;
      const mentionBoost = Math.min(rel.mention_count * 0.05, 0.3);
      const confidence = Math.min(baseConfidence + mentionBoost, 1.0);
      const strength = calculateStrength(confidence, rel.last_seen, now);
      if (!DRY_RUN) {
        updateStmt.run(strength, rel.id);
      }
    }
  });

  transaction(batch);
  updated += batch.length;
  lastId = batch[batch.length - 1].id;

  if (updated % 100000 === 0 || batch.length < BATCH_SIZE) {
    console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Processed ${updated.toLocaleString()} / ${total.toLocaleString()}`);
  }

  if (batch.length < BATCH_SIZE) break;
}

console.log(`\n${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${updated.toLocaleString()} relationships`);
console.log(`Half-life: ${HALF_LIFE_DAYS} days | Decay constant: ${DECAY_CONSTANT.toFixed(4)}`);

// Show sample
const sample = db.prepare("SELECT source, target, relation_type, confidence, strength, last_seen FROM relationships ORDER BY strength DESC LIMIT 5").all();
console.log("\nTop 5 by strength:");
for (const r of sample) {
  console.log(`  ${r.source} → ${r.target} [${r.relation_type}] conf=${r.confidence.toFixed(2)} strength=${r.strength.toFixed(3)}`);
}

const faded = db.prepare("SELECT COUNT(*) as c FROM relationships WHERE strength < 0.1").get();
console.log(`\nFaded relationships (strength < 0.1): ${faded.c.toLocaleString()}`);

db.close();

#!/usr/bin/env node
/**
 * backfill-embeddings.cjs
 * ─────────────────────────────────────────────
 * One-time backfill script that generates embeddings for all existing
 * entities and session summaries in graph.db.
 *
 * Features:
 *   - Batch processing for efficiency (~32 items per batch for entities)
 *   - Resumable (skips already-embedded items unless --force)
 *   - Progress reporting with estimated completion time
 *   - Can be interrupted and resumed
 *   - Creates session summaries from journals if missing
 *
 * Usage:
 *   node backfill-embeddings.cjs
 *   node backfill-embeddings.cjs --force  # re-embed everything
 */

const fs = require("fs");
const path = require("path");
const { batchEmbedding, generateEmbedding } = require("./embeddings.cjs");

const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const JOURNAL_DIR = path.join(MEMORY_DIR, "journal");
const PROGRESS_PATH = path.join(MEMORY_DIR, ".backfill-progress.json");

const args = process.argv.slice(2);
const force = args.includes("--force");

let db;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  try {
    const sqlite3 = require("sqlite3");
    db = new sqlite3.Database(DB_PATH);
  } catch (e2) {
    console.error("No SQLite module available. Install with:");
    console.error("  npm install better-sqlite3");
    process.exit(1);
  }
}

const isBetterSqlite = typeof db.prepare === "function";

function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_PATH)) {
      return JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"));
    }
  } catch (e) {
    console.error("Progress read error:", e.message);
  }
  return { entitiesDone: 0, summariesDone: 0, lastRun: null };
}

function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
  } catch (e) {
    console.error("Progress write error:", e.message);
  }
}

function ensureSchema() {
  try {
    if (isBetterSqlite) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_date TEXT NOT NULL,
          summary_text TEXT,
          embedding BLOB,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(session_date)
        );
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_session_summaries_date ON session_summaries(session_date);`);
    } else {
      db.run(`
        CREATE TABLE IF NOT EXISTS session_summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_date TEXT NOT NULL,
          summary_text TEXT,
          embedding BLOB,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(session_date)
        );
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_session_summaries_date ON session_summaries(session_date);`);
    }
  } catch (e) {
    if (!e.message.includes("already exists") && !e.message.includes("duplicate column name")) {
      console.error("Schema error:", e.message);
    }
  }
}

async function backfillEntities() {
  console.log("\n--- Backfilling entity embeddings ---");

  let entities;
  if (isBetterSqlite) {
    const query = force
      ? "SELECT name, canonical_name, description FROM entities"
      : "SELECT name, canonical_name, description FROM entities WHERE embedding IS NULL";
    entities = db.prepare(query).all();
  } else {
    const query = force
      ? "SELECT name, canonical_name, description FROM entities"
      : "SELECT name, canonical_name, description FROM entities WHERE embedding IS NULL";
    entities = await new Promise((resolve, reject) => {
      db.all(query, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  if (!entities || entities.length === 0) {
    console.log("No entities need embedding backfill.");
    return 0;
  }

  console.log(`Found ${entities.length} entities to embed`);
  const progress = loadProgress();
  let processed = 0;
  const startTime = Date.now();

  const texts = entities.map(r => r.description || r.canonical_name || r.name);
  const batchSize = 32;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batchTexts = texts.slice(i, i + batchSize);
    const batchEntities = entities.slice(i, i + batchSize);

    try {
      const embeddings = await batchEmbedding(batchTexts);
      const updateStmt = db.prepare("UPDATE entities SET embedding = ? WHERE name = ?");

      for (let j = 0; j < batchEntities.length; j++) {
        const buffer = Buffer.from(embeddings[j].buffer);
        updateStmt.run(buffer, batchEntities[j].name);
      }

      processed += batchEntities.length;
      progress.entitiesDone = processed;
      saveProgress(progress);

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const remaining = (entities.length - processed) / rate;
      console.log(`  Progress: ${processed}/${entities.length} entities (${rate.toFixed(1)} items/s, ~${remaining.toFixed(0)}s remaining)`);
    } catch (e) {
      console.error(`  Batch failed at offset ${i}:`, e.message);
    }
  }

  console.log(`Done backfilling ${processed} entities.`);
  return processed;
}

async function backfillSessionSummaries() {
  console.log("\n--- Backfilling session summary embeddings ---");

  let journalFiles;
  try {
    journalFiles = fs.readdirSync(JOURNAL_DIR)
      .filter(f => f.endsWith(".md"))
      .map(f => path.join(JOURNAL_DIR, f))
      .sort();
  } catch (e) {
    console.log("No journal directory found, skipping session summaries.");
    return 0;
  }

  if (journalFiles.length === 0) {
    console.log("No journal files found.");
    return 0;
  }

  let summariesNeedingEmbeddings = [];

  for (const file of journalFiles) {
    const basename = path.basename(file, ".md");
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (e) {
      console.error(`Failed to read journal ${basename}:`, e.message);
      continue;
    }

    let existing;
    if (isBetterSqlite) {
      existing = db.prepare("SELECT id, summary_text, embedding FROM session_summaries WHERE session_date = ?").get(basename);
    } else {
      existing = await new Promise((resolve, reject) => {
        db.get("SELECT id, summary_text, embedding FROM session_summaries WHERE session_date = ?", [basename], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    }

    if (existing && !force && existing.embedding) {
      continue;
    }

    if (existing) {
      if (existing.summary_text !== text) {
        if (isBetterSqlite) {
          db.prepare("UPDATE session_summaries SET summary_text = ?, created_at = datetime('now') WHERE session_date = ?")
            .run(text, basename);
        } else {
          db.run("UPDATE session_summaries SET summary_text = ?, created_at = datetime('now') WHERE session_date = ?", [text, basename]);
        }
      }
      summariesNeedingEmbeddings.push({ session_date: basename, text });
    } else {
      if (isBetterSqlite) {
        db.prepare("INSERT INTO session_summaries (session_date, summary_text) VALUES (?, ?)").run(basename, text);
      } else {
        db.run("INSERT INTO session_summaries (session_date, summary_text) VALUES (?, ?)", [basename, text]);
      }
      summariesNeedingEmbeddings.push({ session_date: basename, text });
    }
  }

  if (summariesNeedingEmbeddings.length === 0) {
    console.log("No session summaries need embedding backfill.");
    return 0;
  }

  console.log(`Found ${summariesNeedingEmbeddings.length} session summaries to embed`);
  const progress = loadProgress();
  let processed = 0;
  const startTime = Date.now();

  for (let i = 0; i < summariesNeedingEmbeddings.length; i++) {
    const { session_date, text } = summariesNeedingEmbeddings[i];
    try {
      const embedding = await generateEmbedding(text);
      const buffer = Buffer.from(embedding.buffer);
      if (isBetterSqlite) {
        db.prepare("UPDATE session_summaries SET embedding = ? WHERE session_date = ?")
          .run(buffer, session_date);
      } else {
        db.run("UPDATE session_summaries SET embedding = ? WHERE session_date = ?", [buffer, session_date]);
      }
      processed++;
      progress.summariesDone = processed;
      saveProgress(progress);

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      const remaining = (summariesNeedingEmbeddings.length - processed) / rate;
      console.log(`  Progress: ${processed}/${summariesNeedingEmbeddings.length} summaries (${session_date}, ${rate.toFixed(1)} items/s, ~${remaining.toFixed(0)}s remaining)`);
    } catch (e) {
      console.error(`  Failed to embed ${session_date}:`, e.message);
    }
  }

  console.log(`Done backfilling ${processed} session summaries.`);
  return processed;
}

async function main() {
  console.log("Starting embedding backfill...");
  console.log(`Database: ${DB_PATH}`);
  console.log(`Force mode: ${force}`);
  const startTime = Date.now();

  ensureSchema();
  const entityCount = await backfillEntities();
  const summaryCount = await backfillSessionSummaries();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Backfill complete in ${elapsed}s.`);
  console.log(`  Entities: ${entityCount}`);
  console.log(`  Session summaries: ${summaryCount}`);

  if (db && typeof db.close === "function") {
    db.close();
  }
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

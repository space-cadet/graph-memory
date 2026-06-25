#!/usr/bin/env node
/**
 * queue-worker.cjs
 * ─────────────────────────────────────────────
 * Background worker that processes session extraction jobs from a queue.
 * Runs independently of heartbeat. Uses SQLite for job storage.
 *
 * Queue schema:
 *   - extraction_queue table with id, session_file, status, created_at, started_at, completed_at, error
 *
 * Usage:
 *   node scripts/queue-worker.cjs               # process pending jobs once
 *   node scripts/queue-worker.cjs --watch       # keep polling for new jobs
 *   node scripts/queue-worker.cjs --enqueue <file>  # add a job to queue
 *   node scripts/queue-worker.cjs --status      # show queue status
 *   node scripts/queue-worker.cjs --clear       # clear completed jobs
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, ".openclaw_memory");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const SESSIONS_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "agents",
  "main",
  "sessions"
);
const SCRIPT_DIR = __dirname;

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const dryRun = args.includes("--dry-run");
const showStatus = args.includes("--status");
const clearCompleted = args.includes("--clear");

let enqueueFile = null;
const enqueueIdx = args.indexOf("--enqueue");
if (enqueueIdx !== -1 && args[enqueueIdx + 1]) {
  enqueueFile = args[enqueueIdx + 1];
}

/* ── Database setup ──────────────────────────── */
let db;
let betterSqlite;

try {
  betterSqlite = require("better-sqlite3");
  db = betterSqlite(DB_PATH);
} catch (e) {
  try {
    const sqlite3 = require("sqlite3");
    db = new sqlite3.Database(DB_PATH);
  } catch (e2) {
    console.error("No SQLite driver found. Install better-sqlite3 or sqlite3.");
    process.exit(1);
  }
}

function dbRun(sql, params = []) {
  if (typeof db.prepare === "function") {
    return db.prepare(sql).run(...params);
  } else if (typeof db.run === "function") {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
}

function dbAll(sql, params = []) {
  if (typeof db.prepare === "function") {
    return db.prepare(sql).all(...params);
  } else if (typeof db.all === "function") {
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
  if (typeof db.prepare === "function") {
    return db.prepare(sql).get(...params);
  } else if (typeof db.get === "function") {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }
  return null;
}

/* ── Schema ──────────────────────────────────── */
async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS extraction_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      UNIQUE(session_file)
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON extraction_queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_created ON extraction_queue(created_at);
  `;
  
  for (const stmt of sql.split(";").filter(s => s.trim())) {
    await dbRun(stmt);
  }
}

/* ── Queue operations ────────────────────────── */
async function enqueueJob(sessionFile) {
  const resolvedPath = path.resolve(sessionFile);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    return false;
  }
  
  try {
    await dbRun(
      "INSERT INTO extraction_queue (session_file, status) VALUES (?, 'pending') ON CONFLICT(session_file) DO UPDATE SET status = 'pending'",
      [resolvedPath]
    );
    console.log(`Enqueued: ${resolvedPath}`);
    return true;
  } catch (e) {
    console.error(`Failed to enqueue: ${e.message}`);
    return false;
  }
}

async function getPendingJobs(limit = 10) {
  return dbAll(
    "SELECT * FROM extraction_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
    [limit]
  );
}

async function markJobStarted(id) {
  await dbRun(
    "UPDATE extraction_queue SET status = 'processing', started_at = datetime('now') WHERE id = ?",
    [id]
  );
}

async function markJobCompleted(id) {
  await dbRun(
    "UPDATE extraction_queue SET status = 'completed', completed_at = datetime('now'), error = NULL WHERE id = ?",
    [id]
  );
}

async function markJobFailed(id, error) {
  await dbRun(
    "UPDATE extraction_queue SET status = 'failed', completed_at = datetime('now'), error = ? WHERE id = ?",
    [error.substring(0, 500), id]
  );
}

async function getQueueStatus() {
  const counts = await dbAll(`
    SELECT status, COUNT(*) as count FROM extraction_queue GROUP BY status
  `);
  const total = await dbGet(`SELECT COUNT(*) as count FROM extraction_queue`);
  const oldest = await dbGet(`SELECT MIN(created_at) as oldest FROM extraction_queue WHERE status = 'pending'`);
  return { counts, total: total?.count || 0, oldestPending: oldest?.oldest || null };
}

async function clearCompletedJobs() {
  const result = await dbRun("DELETE FROM extraction_queue WHERE status = 'completed'");
  console.log(`Cleared ${result.changes} completed jobs.`);
}

/* ── Job processing ──────────────────────────── */
async function processJob(job) {
  const sessionFile = job.session_file;
  console.log(`Processing: ${sessionFile}`);
  
  if (dryRun) {
    console.log(`[DRY-RUN] Would process: ${sessionFile}`);
    return true;
  }
  
  try {
    // Use the existing session-entity-extractor
    const output = execSync(
      `node "${path.join(SCRIPT_DIR, "session-entity-extractor.cjs")}" --file "${sessionFile}"`,
      {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 300000, // 5 min timeout
        cwd: path.dirname(SCRIPT_DIR),
      }
    );
    console.log(output);
    return true;
  } catch (e) {
    console.error(`Failed to process ${sessionFile}:`, e.stderr || e.message);
    return false;
  }
}

async function processBatch(limit = 5) {
  const jobs = await getPendingJobs(limit);
  console.log(`Found ${jobs.length} pending job(s).`);
  
  if (jobs.length === 0) {
    return 0;
  }
  
  let processed = 0;
  for (const job of jobs) {
    await markJobStarted(job.id);
    const success = await processJob(job);
    if (success) {
      await markJobCompleted(job.id);
      processed++;
    } else {
      await markJobFailed(job.id, `Extraction failed for ${job.session_file}`);
    }
  }
  
  return processed;
}

/* ── Auto-enqueue new sessions ───────────────── */
async function enqueueNewSessions() {
  // Find all .jsonl session files not yet in queue
  const allFiles = [];
  try {
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".trajectory.jsonl")) {
        allFiles.push(path.join(SESSIONS_DIR, entry.name));
      }
    }
  } catch (e) {
    console.error("Failed to read sessions directory:", e.message);
    return 0;
  }
  
  let enqueued = 0;
  for (const file of allFiles) {
    const existing = await dbGet(
      "SELECT id FROM extraction_queue WHERE session_file = ?",
      [file]
    );
    if (!existing) {
      await enqueueJob(file);
      enqueued++;
    }
  }
  
  return enqueued;
}

/* ── Main ────────────────────────────────────── */
async function main() {
  await ensureSchema();
  
  if (showStatus) {
    const status = await getQueueStatus();
    console.log("\nQueue Status:");
    console.log("-".repeat(40));
    for (const row of status.counts) {
      console.log(`  ${row.status}: ${row.count}`);
    }
    console.log(`  total: ${status.total}`);
    if (status.oldestPending) {
      console.log(`  oldest pending: ${status.oldestPending}`);
    }
    console.log();
    return;
  }
  
  if (clearCompleted) {
    await clearCompletedJobs();
    return;
  }
  
  if (enqueueFile) {
    await enqueueJob(enqueueFile);
    return;
  }
  
  // Auto-enqueue any new sessions (skip in dry-run to avoid noise)
  if (!dryRun) {
    const enqueued = await enqueueNewSessions();
    if (enqueued > 0) {
      console.log(`Auto-enqueued ${enqueued} new session file(s).`);
    }
  }
  
  if (watch) {
    console.log("Worker started in watch mode. Press Ctrl+C to stop.");
    while (true) {
      const processed = await processBatch(5);
      if (processed === 0) {
        console.log("No pending jobs. Waiting 30s...");
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  } else {
    const processed = await processBatch(10);
    console.log(`Processed ${processed} job(s).`);
  }
  
  if (db && typeof db.close === "function") {
    db.close();
  }
}

main().catch(err => {
  console.error("Worker error:", err);
  process.exit(1);
});

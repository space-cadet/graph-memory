#!/usr/bin/env node
/**
 * migrate-embeddings.cjs
 * ─────────────────────────────────────────────
 * Migrates existing graph.db to support vector embeddings.
 *
 * Changes:
 *   - Adds embedding BLOB to entities table (384-dim float32, 1536 bytes)
 *   - Creates session_summaries table for session-level semantic search
 *   - Creates idx_session_summaries_date index for date-based lookups
 *
 * Usage:
 *   node migrate-embeddings.cjs
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

let db;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  try {
    const sqlite3 = require("sqlite3");
    db = new sqlite3.Database(DB_PATH);
  } catch (e2) {
    console.error("No SQLite module available.");
    process.exit(1);
  }
}

function columnExists(table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === column);
  } catch (e) {
    let exists = false;
    db.each(`PRAGMA table_info(${table})`, (err, row) => {
      if (row && row.name === column) exists = true;
    });
    return exists;
  }
}

function tableExists(table) {
  try {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).all(table);
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

function run(sql) {
  try {
    if (typeof db.exec === "function") {
      db.exec(sql);
    } else if (typeof db.run === "function") {
      db.run(sql);
    }
    return true;
  } catch (e) {
    if (!e.message.includes("duplicate column") && !e.message.includes("already exists")) {
      console.error(`Migration error: ${e.message}`);
      return false;
    }
    return true;
  }
}

function migrate() {
  if (!fs.existsSync(DB_PATH)) {
    console.error("Database not found:", DB_PATH);
    process.exit(1);
  }

  console.log("Migrating graph.db for embeddings...");

  // 1. Add embedding column to entities
  if (!columnExists("entities", "embedding")) {
    const ok = run(`ALTER TABLE entities ADD COLUMN embedding BLOB;`);
    console.log(ok ? "  ✓ Added column: embedding (BLOB) to entities" : "  ✗ Failed to add embedding column");
  } else {
    console.log("  ○ Column already exists: embedding");
  }

  // 2. Create session_summaries table
  if (!tableExists("session_summaries")) {
    const ok = run(`
      CREATE TABLE session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_date TEXT NOT NULL,
        summary_text TEXT,
        embedding BLOB,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(session_date)
      );
    `);
    console.log(ok ? "  ✓ Created table: session_summaries" : "  ✗ Failed to create session_summaries table");
  } else {
    console.log("  ○ Table already exists: session_summaries");
  }

  // 3. Add index on session_date
  try {
    run(`CREATE INDEX IF NOT EXISTS idx_session_summaries_date ON session_summaries(session_date);`);
    console.log("  ✓ Created index: idx_session_summaries_date");
  } catch (e) {
    console.log("  ✗ Failed to create index:", e.message);
  }

  // 4. Add description column if missing (from previous migration, some dbs may not have it)
  if (!columnExists("entities", "description")) {
    const ok = run(`ALTER TABLE entities ADD COLUMN description TEXT;`);
    console.log(ok ? "  ✓ Added column: description (TEXT)" : "  ✗ Failed to add description");
  }

  console.log("Migration complete.");

  if (db && typeof db.close === "function") {
    db.close();
  }
}

migrate();

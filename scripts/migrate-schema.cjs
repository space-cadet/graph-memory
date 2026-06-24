#!/usr/bin/env node
/**
 * migrate-schema.cjs
 * ─────────────────────────────────────────────
 * Migrates existing graph.db to include LLM extraction columns.
 *
 * Adds to entities table:
 *   - confidence REAL (0.0–1.0)
 *   - description TEXT
 *   - strength REAL (0.0–1.0, relationship/importance strength)
 *   - context TEXT (snippet where entity was found)
 *
 * Usage:
 *   node migrate-schema.cjs
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
    // Fallback for sqlite3 API
    let exists = false;
    db.each(`PRAGMA table_info(${table})`, (err, row) => {
      if (row && row.name === column) exists = true;
    });
    return exists;
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
    if (!e.message.includes("duplicate column")) {
      console.error(`Migration error: ${e.message}`);
      return false;
    }
    return true; // already exists
  }
}

function migrate() {
  if (!fs.existsSync(DB_PATH)) {
    console.error("Database not found:", DB_PATH);
    process.exit(1);
  }

  console.log("Migrating graph.db schema...");

  const columns = [
    { name: "confidence", type: "REAL" },
    { name: "description", type: "TEXT" },
    { name: "strength", type: "REAL" },
    { name: "context", type: "TEXT" }
  ];

  for (const col of columns) {
    const sql = `ALTER TABLE entities ADD COLUMN ${col.name} ${col.type};`;
    const ok = run(sql);
    if (ok) {
      console.log(`  ✓ Added column: ${col.name} (${col.type})`);
    } else {
      console.log(`  ✗ Failed to add column: ${col.name}`);
    }
  }

  console.log("Migration complete.");

  if (db && typeof db.close === "function") {
    db.close();
  }
}

migrate();

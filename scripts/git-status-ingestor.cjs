#!/usr/bin/env node
/**
 * git-status-ingestor.cjs
 * ─────────────────────────────────────────────
 * Tracks current file modifications from git diff/status and maps
 * them to entities in the graph database. Links file changes to
 * projects via .beads/project-dirs.json.
 *
 * Entity types: file
 * Relationship types: file_belongs_to_project
 *
 * Usage:
 *   node scripts/git-status-ingestor.cjs           # current modifications
 *   node scripts/git-status-ingestor.cjs --dry-run # print, don't write
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/* ── Paths ───────────────────────────────────── */
const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, ".openclaw_memory");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const PROJECT_DIRS_PATH = path.join(WORKSPACE_DIR, ".beads", "project-dirs.json");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

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

/* ── Project mapping ─────────────────────────── */
function loadProjectDirs() {
  try {
    const raw = fs.readFileSync(PROJECT_DIRS_PATH, "utf8");
    const map = JSON.parse(raw);
    // Build reverse map: relative path prefix -> project name
    const reverse = {};
    for (const [name, dir] of Object.entries(map)) {
      if (dir === ".") {
        reverse[""] = name;
      } else {
        reverse[dir] = name;
      }
    }
    return reverse;
  } catch (e) {
    console.error("Failed to load project-dirs.json:", e.message);
    return {};
  }
}

function findProjectForFile(filePath, projectMap) {
  // Exact match first
  if (projectMap[filePath]) {
    return projectMap[filePath];
  }
  // Find the longest matching prefix
  let bestProject = "workspace";
  let bestLen = -1;
  for (const [prefix, project] of Object.entries(projectMap)) {
    if (prefix === "") continue; // handled above if exact match
    if (filePath.startsWith(prefix + "/") && prefix.length > bestLen) {
      bestProject = project;
      bestLen = prefix.length;
    }
  }
  return bestProject;
}

/* ── Upsert helpers ──────────────────────────── */
function upsertEntity(name, canonicalName, type, date, description = null) {
  if (dryRun) {
    console.log(`[DRY-RUN] Entity: ${name} (${type})`);
    return;
  }

  const stmt = `
    INSERT INTO entities (name, canonical_name, first_seen, last_seen, mention_count, entity_type, description)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      last_seen = ?,
      mention_count = mention_count + 1
  `;

  try {
    if (typeof db.prepare === "function") {
      const prepared = db.prepare(stmt);
      prepared.run(name, canonicalName, date, date, type, description, date);
    } else if (typeof db.run === "function") {
      db.run(stmt, [name, canonicalName, date, date, type, description, date]);
    }
  } catch (e) {
    console.error(`Failed to upsert entity ${name}:`, e.message);
  }
}

function upsertRelationship(source, target, type, context, date) {
  if (dryRun) {
    console.log(`[DRY-RUN] Rel: ${source} --[${type}]--> ${target}`);
    return;
  }

  const stmt = `
    INSERT INTO relationships (source, target, relation_type, first_seen, last_seen, mention_count, context)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(source, target, relation_type) DO UPDATE SET
      last_seen = ?,
      mention_count = mention_count + 1
  `;

  try {
    if (typeof db.prepare === "function") {
      const prepared = db.prepare(stmt);
      prepared.run(source, target, type, date, date, context, date);
    } else if (typeof db.run === "function") {
      db.run(stmt, [source, target, type, date, date, context, date]);
    }
  } catch (e) {
    if (!e.message.includes("UNIQUE constraint failed")) {
      console.error(`Failed to upsert relationship ${source}->${target}:`, e.message);
    }
  }
}

/* ── Git status parser ───────────────────────── */
function getModifiedFiles() {
  try {
    const output = execSync(
      `git -C "${WORKSPACE_DIR}" diff --name-only HEAD`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
    return output.split("\n").filter((l) => l.trim());
  } catch (e) {
    // If HEAD doesn't exist (empty repo), fall back to ls-files
    try {
      const output = execSync(
        `git -C "${WORKSPACE_DIR}" status --short`,
        { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
      );
      return output
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
    } catch (e2) {
      console.error("Failed to get modified files:", e2.message);
      return [];
    }
  }
}

/* ── Main ────────────────────────────────────── */
function main() {
  const today = new Date().toISOString().split("T")[0];
  const projectMap = loadProjectDirs();

  const files = getModifiedFiles();
  console.log(`Found ${files.length} modified files.`);

  if (files.length === 0) {
    console.log("No modifications to ingest.");
    process.exit(0);
  }

  if (dryRun) {
    console.log("\n--- DRY RUN ---\n");
  }

  let entityCount = 0;
  let relCount = 0;

  for (const file of files) {
    const fileKey = `file:${file}`;
    const project = findProjectForFile(file, projectMap);
    const projectKey = `repo:${project}`;

    // Upsert file
    upsertEntity(fileKey, file, "file", today);
    entityCount++;

    // Upsert project
    upsertEntity(projectKey, project, "project", today);
    entityCount++;

    // Relationship: file belongs to project
    upsertRelationship(fileKey, projectKey, "file_belongs_to_project", "git status", today);
    relCount++;

    // TODO: Link file changes to tasks by checking beads tasks that map to this project
    // This requires querying the beads database for open tasks in the matching project.
  }

  if (!dryRun) {
    console.log(`\nIngested ${entityCount} entities, ${relCount} relationships.`);
  } else {
    console.log(`\n[DRY-RUN] Would ingest ${entityCount} entities, ${relCount} relationships.`);
  }

  if (db && typeof db.close === "function") {
    db.close();
  }
}

main();

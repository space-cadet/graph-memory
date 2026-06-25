#!/usr/bin/env node
/**
 * git-commit-ingestor.cjs
 * ─────────────────────────────────────────────
 * Reads git log from the workspace and inserts commit authors,
 * messages, and file changes as entities into the graph database.
 *
 * Entity types created: person, commit, file
 * Relationship types created: authored_by, changed, file_belongs_to_project
 *
 * Usage:
 *   node scripts/git-commit-ingestor.cjs              # ingest all commits
 *   node scripts/git-commit-ingestor.cjs --since 7d   # last 7 days
 *   node scripts/git-commit-ingestor.cjs --dry-run    # print, don't write
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/* ── Paths ───────────────────────────────────── */
const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, ".openclaw_memory");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sinceArg = args.includes("--since")
  ? args[args.indexOf("--since") + 1]
  : null;

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

/* ── Git log parser ──────────────────────────── */
function getCommits(since = null) {
  const format =
    "COMMIT_START%n%H%n%an%n%ae%n%aI%n%s%n%b%nFILES_START%n";
  let cmd = `git -C "${WORKSPACE_DIR}" log --pretty=format:"${format}" --name-only`;
  if (since) {
    cmd += ` --since="${since}"`;
  }

  try {
    return execSync(cmd, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  } catch (e) {
    console.error("Failed to run git log:", e.message);
    return "";
  }
}

function parseCommits(logOutput) {
  const commits = [];
  const blocks = logOutput.split("COMMIT_START\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    const hash = lines[0].trim();
    const authorName = lines[1].trim();
    const authorEmail = lines[2].trim();
    const date = lines[3].trim();
    const subject = lines[4].trim();

    // Find FILES_START and collect files after it
    const filesIdx = lines.indexOf("FILES_START");
    const files =
      filesIdx >= 0
        ? lines
            .slice(filesIdx + 1)
            .filter((l) => l.trim() && !l.startsWith(" "))
        : [];

    // Build message body (lines between subject and FILES_START)
    const bodyLines =
      filesIdx >= 0 ? lines.slice(5, filesIdx) : lines.slice(5);
    const body = bodyLines.join("\n").trim();
    const message = body ? `${subject}\n\n${body}` : subject;

    commits.push({
      hash,
      authorName,
      authorEmail,
      date: date.split("T")[0], // YYYY-MM-DD
      subject,
      message,
      files,
    });
  }

  return commits;
}

/* ── Main ────────────────────────────────────── */
function main() {
  console.log("Fetching git log...");
  const logOutput = getCommits(sinceArg);

  if (!logOutput.trim()) {
    console.log("No commits found.");
    process.exit(0);
  }

  const commits = parseCommits(logOutput);
  console.log(`Found ${commits.length} commits to ingest.`);

  // Detect repo name from git remote or directory name
  let repoName = "workspace";
  try {
    const remoteUrl = execSync(
      `git -C "${WORKSPACE_DIR}" remote get-url origin`,
      { encoding: "utf8" }
    ).trim();
    const match = remoteUrl.match(/\/([^\/]+?)(?:\.git)?$/);
    if (match) repoName = match[1];
  } catch (e) {
    repoName = path.basename(WORKSPACE_DIR);
  }

  if (dryRun) {
    console.log("\n--- DRY RUN ---\n");
  }

  // Upsert project entity for the repo
  upsertEntity(
    `repo:${repoName}`,
    repoName,
    "project",
    commits[0]?.date || new Date().toISOString().split("T")[0]
  );

  let entityCount = 0;
  let relCount = 0;

  for (const commit of commits) {
    const authorKey = `person:${commit.authorEmail}`;
    const commitKey = `commit:${commit.hash}`;
    const date = commit.date;

    // Upsert person
    upsertEntity(authorKey, commit.authorName, "person", date);
    entityCount++;

    // Upsert commit
    upsertEntity(commitKey, commit.subject, "commit", date, commit.message);
    entityCount++;

    // Relationship: commit authored_by person
    upsertRelationship(commitKey, authorKey, "authored_by", commit.subject, date);
    relCount++;

    // Relationship: commit belongs_to_project repo
    upsertRelationship(
      commitKey,
      `repo:${repoName}`,
      "file_belongs_to_project",
      commit.subject,
      date
    );
    relCount++;

    for (const file of commit.files) {
      const fileKey = `file:${file}`;

      // Upsert file
      upsertEntity(fileKey, file, "file", date);
      entityCount++;

      // Relationship: commit changed file
      upsertRelationship(commitKey, fileKey, "changed", commit.subject, date);
      relCount++;

      // Relationship: file belongs_to_project repo
      upsertRelationship(
        fileKey,
        `repo:${repoName}`,
        "file_belongs_to_project",
        commit.subject,
        date
      );
      relCount++;
    }
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

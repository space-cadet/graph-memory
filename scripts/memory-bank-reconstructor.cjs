#!/usr/bin/env node
/**
 * memory-bank-reconstructor.cjs
 * ─────────────────────────────────────────────
 * Queries the knowledge graph for protocol entities (tasks, decisions,
 * edit chunks, blockers, next actions) and reconstructs memory-bank
 * markdown files from the graph state.
 *
 * Usage:
 *   node memory-bank-reconstructor.cjs --date 2026-06-17    # reconstruct specific date
 *   node memory-bank-reconstructor.cjs --range 2026-06-17,2026-06-21  # date range
 *   node memory-bank-reconstructor.cjs --output ~/.openclaw/workspace/memory-bank
 */

const fs = require("fs");
const path = require("path");

/* ── Paths ───────────────────────────────────── */
const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const DEFAULT_OUTPUT = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  "memory-bank"
);

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dateOverride = args.includes("--date")
  ? args[args.indexOf("--date") + 1]
  : null;
const rangeArg = args.includes("--range")
  ? args[args.indexOf("--range") + 1]
  : null;
const outputDir = args.includes("--output")
  ? args[args.indexOf("--output") + 1]
  : DEFAULT_OUTPUT;

const dateRange = rangeArg ? rangeArg.split(",") : null;
const startDate = dateRange ? dateRange[0] : null;
const endDate = dateRange ? (dateRange[1] || dateRange[0]) : null;

/* ── SQLite ──────────────────────────────────── */
let db;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  console.error("Install better-sqlite3: npm install -g better-sqlite3");
  process.exit(1);
}

/* ── Query helpers ───────────────────────────── */

function getTasks(dateFilter = null) {
  // Find tasks that had protocol activity on the given date
  let sql = `
    SELECT DISTINCT e.*,
      (SELECT r2.target FROM relationships r2
       WHERE r2.source = r.source AND r2.relation_type = 'task_has_status'
       ORDER BY r2.last_seen DESC LIMIT 1) as status,
      (SELECT r2.target FROM relationships r2
       WHERE r2.source = r.source AND r2.relation_type = 'task_blocked_by'
       ORDER BY r2.last_seen DESC LIMIT 1) as blocker,
      (SELECT r2.target FROM relationships r2
       WHERE r2.source = r.source AND r2.relation_type = 'task_next_action'
       ORDER BY r2.last_seen DESC LIMIT 1) as next_action
    FROM relationships r
    JOIN entities e ON r.source = e.canonical_name COLLATE NOCASE
    WHERE e.entity_type = 'task'
      AND CAST(substr(e.canonical_name, 2) AS INTEGER) <= 30
      AND r.relation_type IN ('task_has_status', 'task_blocked_by', 'task_next_action', 'edit_chunk_for_task', 'file_change_for_task', 'session_mentions')
  `;
  if (dateFilter) {
    sql += ` AND substr(r.last_seen, 1, 10) = '${dateFilter}'`;
  }
  sql += ` ORDER BY e.mention_count DESC`;
  return db.prepare(sql).all();
}

function getTaskDetails(taskName) {
  const statuses = db.prepare(
    `SELECT target, last_seen FROM relationships
     WHERE source = ? COLLATE NOCASE AND relation_type = 'task_has_status'
     ORDER BY last_seen DESC`
  ).all(taskName);

  const blockers = db.prepare(
    `SELECT r.target, r.context, r.last_seen
     FROM relationships r
     WHERE r.source = ? COLLATE NOCASE AND r.relation_type = 'task_blocked_by'
     ORDER BY r.last_seen DESC`
  ).all(taskName);

  const nextActions = db.prepare(
    `SELECT r.target, r.context, r.last_seen
     FROM relationships r
     WHERE r.source = ? COLLATE NOCASE AND r.relation_type = 'task_next_action'
     ORDER BY r.last_seen DESC`
  ).all(taskName);

  const editChunks = db.prepare(
    `SELECT r.source as chunk_id, e.name as chunk_name
     FROM relationships r
     JOIN entities e ON r.source = e.name
     WHERE r.target = ? COLLATE NOCASE AND r.relation_type = 'edit_chunk_for_task'`
  ).all(taskName);

  const fileChanges = db.prepare(
    `SELECT r.source as change_id, e.name as change_name
     FROM relationships r
     JOIN entities e ON r.source = e.name
     WHERE r.target = ? COLLATE NOCASE AND r.relation_type = 'file_change_for_task'`
  ).all(taskName);

  return { statuses, blockers, nextActions, editChunks, fileChanges };
}

function getDecisions(dateFilter = null) {
  let sql = `
    SELECT e.*, r.context, r.last_seen as decision_date
    FROM entities e
    JOIN relationships r ON e.name = r.source
    WHERE e.entity_type = 'decision' AND r.relation_type = 'decision_made_in_session'
  `;
  if (dateFilter) {
    sql += ` AND substr(r.last_seen, 1, 10) = '${dateFilter}'`;
  }
  sql += ` ORDER BY r.last_seen DESC LIMIT 20`;
  return db.prepare(sql).all();
}

function getEditChunks(dateFilter = null) {
  let sql = `
    SELECT e.*, r.last_seen as chunk_date
    FROM entities e
    JOIN relationships r ON e.name = r.source
    WHERE e.entity_type = 'edit_chunk' AND r.relation_type = 'edit_chunk_in_session'
  `;
  if (dateFilter) {
    sql += ` AND substr(r.last_seen, 1, 10) = '${dateFilter}'`;
  }
  sql += ` ORDER BY r.last_seen DESC`;
  return db.prepare(sql).all();
}

function getActiveFiles(dateFilter = null) {
  let sql = `
    SELECT e.*, r.last_seen as change_date
    FROM entities e
    JOIN relationships r ON e.name = r.source
    WHERE e.entity_type = 'file_change' AND r.relation_type = 'file_changed_in_session'
  `;
  if (dateFilter) {
    sql += ` AND substr(r.last_seen, 1, 10) = '${dateFilter}'`;
  }
  sql += ` ORDER BY r.last_seen DESC LIMIT 30`;
  return db.prepare(sql).all();
}

function getBlockers(dateFilter = null) {
  let sql = `
    SELECT e.*, r.context, r.last_seen as blocker_date
    FROM entities e
    JOIN relationships r ON e.name = r.source
    WHERE e.entity_type = 'blocker' AND r.relation_type = 'blocker_found_in_session'
  `;
  if (dateFilter) {
    sql += ` AND substr(r.last_seen, 1, 10) = '${dateFilter}'`;
  }
  sql += ` ORDER BY r.last_seen DESC LIMIT 20`;
  return db.prepare(sql).all();
}

/* ── Markdown generators ─────────────────────── */

function normalizeTaskName(name) {
  const match = name.match(/^(t)(\d+)$/i);
  if (match) return `T${match[2]}`;
  return name;
}

function generateTasksMd(tasks, dateLabel) {
  let md = `# Active Tasks — ${dateLabel}\n\n`;

  const active = tasks.filter(t => {
    const s = t.status || "";
    return s.includes("in_progress") || s.includes("blocked") || !s;
  });
  const completed = tasks.filter(t => {
    const s = t.status || "";
    return s.includes("complete") || s.includes("done");
  });

  if (active.length > 0) {
    md += "## In Progress / Active\n\n";
    for (const task of active) {
      const details = getTaskDetails(task.name);
      const status = task.status ? task.status.replace("status:", "") : "unknown";
      const blocker = details.blockers.length > 0
        ? (details.blockers[0].context || details.blockers[0].target.replace("blocker:", ""))
        : null;
      const nextAction = details.nextActions.length > 0
        ? (details.nextActions[0].context || details.nextActions[0].target.replace("next:", ""))
        : null;
      const displayName = normalizeTaskName(task.name);

      md += `### ${displayName}\n`;
      md += `- **Status**: ${status}\n`;
      if (blocker) md += `- **Blocker**: ${blocker}\n`;
      if (nextAction) md += `- **Next Action**: ${nextAction}\n`;
      if (details.editChunks.length > 0) {
        md += `- **Edit Chunks**: ${details.editChunks.map(c => c.chunk_name).join(", ")}\n`;
      }
      md += `- **Mentions**: ${task.mention_count}\n`;
      md += `\n`;
    }
  }

  if (completed.length > 0) {
    md += "## Completed\n\n";
    for (const task of completed) {
      const displayName = normalizeTaskName(task.name);
      md += `- **${displayName}** — ${task.status.replace("status:", "")} (${task.mention_count} mentions)\n`;
    }
    md += "\n";
  }

  return md;
}

function generateActiveContextMd(tasks, decisions, blockers, files, dateLabel) {
  let md = `# Active Context — ${dateLabel}\n\n`;

  md += "## Current Focus\n\n";
  const topTasks = tasks.slice(0, 5);
  if (topTasks.length > 0) {
    for (const task of topTasks) {
      const status = task.status ? task.status.replace("status:", "") : "active";
      const displayName = normalizeTaskName(task.name);
      md += `- **${displayName}** — ${status}\n`;
    }
  } else {
    md += "No active tasks detected in graph.\n";
  }
  md += "\n";

  if (blockers.length > 0) {
    md += "## Blockers\n\n";
    for (const b of blockers.slice(0, 5)) {
      const context = b.context || b.name.replace("blocker:", "");
      md += `- ${context}\n`;
    }
    md += "\n";
  }

  if (decisions.length > 0) {
    md += "## Recent Decisions\n\n";
    for (const d of decisions.slice(0, 10)) {
      const text = d.context || d.name.replace("decision:", "");
      md += `- ${text}\n`;
    }
    md += "\n";
  }

  if (files.length > 0) {
    md += "## Files in Flight\n\n";
    for (const f of files.slice(0, 15)) {
      const text = f.name.replace("change:", "").replace(/:/g, " → ");
      md += `- \`${text}\`\n`;
    }
    md += "\n";
  }

  md += "*Reconstructed from graph database. Some details may be incomplete.*\n";
  return md;
}

function generateEditHistoryMd(editChunks, dateLabel) {
  let md = `# Edit History — ${dateLabel}\n\n`;

  if (editChunks.length === 0) {
    md += "No edit chunks detected in graph for this period.\n";
    return md;
  }

  md += "| Date | Edit Chunk | Task |\n";
  md += "|------|-----------|------|\n";

  for (const chunk of editChunks) {
    const tasks = db.prepare(
      `SELECT r.target FROM relationships r
       WHERE r.source = ? AND r.relation_type = 'edit_chunk_for_task'`
    ).all(chunk.name);
    const taskList = tasks.map(t => normalizeTaskName(t.target)).join(", ") || "—";
    const chunkShort = chunk.name.replace("edit:", "");
    md += `| ${chunk.chunk_date || "—"} | ${chunkShort} | ${taskList} |\n`;
  }

  return md;
}

function generateSessionCacheMd(tasks, dateLabel) {
  let md = `# Session Cache — ${dateLabel}\n\n`;

  md += "## Active Tasks\n\n";
  for (const task of tasks.slice(0, 10)) {
    const status = task.status ? task.status.replace("status:", "") : "active";
    const displayName = normalizeTaskName(task.name);
    md += `- **${displayName}** [${status}]\n`;
  }
  md += "\n";

  md += "## Context\n\n";
  md += "- **Tasks tracked in graph**: " + tasks.length + "\n";
  md += "- **Last reconstructed**: " + new Date().toISOString() + "\n";
  md += "\n";

  return md;
}

/* ── Main ────────────────────────────────────── */
function main() {
  const dates = [];

  if (dateOverride) {
    dates.push(dateOverride);
  } else if (startDate && endDate) {
    // Generate all dates in range
    let current = new Date(startDate);
    const end = new Date(endDate);
    while (current <= end) {
      dates.push(current.toISOString().split("T")[0]);
      current.setDate(current.getDate() + 1);
    }
  } else {
    // Default: reconstruct all dates with data
    const result = db.prepare(
      `SELECT DISTINCT substr(r.last_seen, 1, 10) as date
       FROM relationships r
       JOIN entities e ON r.source = e.canonical_name COLLATE NOCASE
       WHERE e.entity_type = 'task'
       ORDER BY date DESC`
    ).all();
    dates.push(...result.map(r => r.date));
  }

  console.error(`Reconstructing memory-bank for ${dates.length} date(s): ${dates.join(", ")}`);
  console.error(`Output directory: ${outputDir}`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const date of dates) {
    console.error(`\nProcessing ${date}...`);

    const tasks = getTasks(date);
    const decisions = getDecisions(date);
    const blockers = getBlockers(date);
    const files = getActiveFiles(date);
    const editChunks = getEditChunks(date);

    console.error(`  Tasks: ${tasks.length}, Decisions: ${decisions.length}, Blockers: ${blockers.length}, Files: ${files.length}, Edit chunks: ${editChunks.length}`);

    const dateLabel = date;

    // Generate files
    const tasksMd = generateTasksMd(tasks, dateLabel);
    const activeContextMd = generateActiveContextMd(tasks, decisions, blockers, files, dateLabel);
    const editHistoryMd = generateEditHistoryMd(editChunks, dateLabel);
    const sessionCacheMd = generateSessionCacheMd(tasks, dateLabel);

    // Write to date-specific subdirectories
    const reconDir = path.join(outputDir, "reconstructed", date);
    fs.mkdirSync(reconDir, { recursive: true });

    fs.writeFileSync(path.join(reconDir, "tasks.md"), tasksMd);
    fs.writeFileSync(path.join(reconDir, "activeContext.md"), activeContextMd);
    fs.writeFileSync(path.join(reconDir, "edit_history.md"), editHistoryMd);
    fs.writeFileSync(path.join(reconDir, "session_cache.md"), sessionCacheMd);

    console.error(`  Written to ${reconDir}/`);
  }

  console.error(`\n✅ Reconstruction complete.`);

  if (db && typeof db.close === "function") {
    db.close();
  }
}

main();

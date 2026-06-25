#!/usr/bin/env node
/**
 * calendar-ingestor.cjs
 * ─────────────────────────────────────────────
 * Reads calendar events from .ics files and inserts them as entities
 * into the graph database. Links events to people (attendees/organizer)
 * and projects (via summary/description keyword matching).
 *
 * Entity types: event, person
 * Relationship types: attended, organized, event_related_to_project
 *
 * Usage:
 *   node scripts/calendar-ingestor.cjs                    # search workspace for .ics
 *   node scripts/calendar-ingestor.cjs --path ./events.ics # specific file
 *   node scripts/calendar-ingestor.cjs --dir ~/calendars  # specific directory
 *   node scripts/calendar-ingestor.cjs --dry-run           # print, don't write
 */

const fs = require("fs");
const path = require("path");

/* ── Paths ───────────────────────────────────── */
const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, ".openclaw_memory");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

let customPath = null;
let customDir = null;
const pathIdx = args.indexOf("--path");
if (pathIdx !== -1 && args[pathIdx + 1]) {
  customPath = args[pathIdx + 1];
}
const dirIdx = args.indexOf("--dir");
if (dirIdx !== -1 && args[dirIdx + 1]) {
  customDir = args[dirIdx + 1];
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

/* ── ICS Parser ──────────────────────────────── */
function parseIcsFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const events = [];
  const lines = text.split(/\r?\n/);

  let currentEvent = null;
  let currentKey = null;
  let currentValue = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Handle line folding (lines starting with space/tab continue previous line)
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (currentValue !== null) {
        currentValue += line.substring(1);
      }
      continue;
    }

    // Save previous key-value if we were building one
    if (currentKey && currentEvent) {
      if (currentKey === "SUMMARY") currentEvent.summary = currentValue;
      if (currentKey === "DTSTART") currentEvent.dtstart = currentValue;
      if (currentKey === "DTEND") currentEvent.dtend = currentValue;
      if (currentKey === "DESCRIPTION") currentEvent.description = currentValue;
      if (currentKey === "LOCATION") currentEvent.location = currentValue;
      if (currentKey.startsWith("ATTENDEE")) {
        const email = extractEmail(currentValue) || currentValue;
        if (email) currentEvent.attendees.push(email);
      }
      if (currentKey.startsWith("ORGANIZER")) {
        const email = extractEmail(currentValue) || currentValue;
        if (email) currentEvent.organizer = email;
      }
    }

    // Parse new line
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      currentKey = null;
      currentValue = null;
      continue;
    }

    currentKey = line.substring(0, colonIdx);
    currentValue = line.substring(colonIdx + 1);

    if (line === "BEGIN:VEVENT") {
      currentEvent = {
        summary: "",
        dtstart: "",
        dtend: "",
        description: "",
        location: "",
        attendees: [],
        organizer: "",
        uid: ""
      };
    } else if (line === "END:VEVENT") {
      if (currentEvent) {
        events.push(currentEvent);
      }
      currentEvent = null;
      currentKey = null;
      currentValue = null;
    } else if (currentKey === "UID" && currentEvent) {
      currentEvent.uid = currentValue;
    }
  }

  return events;
}

function extractEmail(str) {
  const match = str.match(/mailto:([^\s;]+)/i);
  return match ? match[1] : null;
}

function escapeName(str) {
  return str.replace(/[^a-zA-Z0-9_\-.@]/g, "_").substring(0, 100);
}

/* ── File discovery ──────────────────────────── */
function findIcsFiles(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        files.push(...findIcsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".ics")) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Ignore permission errors
  }
  return files;
}

/* ── Project keyword matching ──────────────── */
const PROJECT_KEYWORDS = {
  "cjp-website": ["cjp", "citizen", "justice", "constitution"],
  "arxivite": ["arxiv", "paper", "arxivite"],
  "bot2bot": ["bot2bot", "sage", "bot"],
  "chimera-chat": ["chimera", "chat"],
  "cron-digests": ["cron", "digest"],
  "med-docs-v2": ["med", "docs", "med-docs"],
  "website": ["quantumofgravity", "blog", "website"],
  "graph-memory": ["graph", "memory", "knowledge"],
  "hanyu-xue": ["hanyu", "chinese", "language"],
  "quantum-dungeon": ["quantum", "dungeon", "game"],
};

function findProjectsForEvent(event) {
  const text = (event.summary + " " + event.description).toLowerCase();
  const matches = [];
  for (const [project, keywords] of Object.entries(PROJECT_KEYWORDS)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        matches.push(project);
        break;
      }
    }
  }
  return matches;
}

/* ── Main ────────────────────────────────────── */
function main() {
  const today = new Date().toISOString().split("T")[0];

  let icsFiles = [];
  if (customPath) {
    icsFiles = [customPath];
  } else if (customDir) {
    icsFiles = findIcsFiles(customDir);
  } else {
    // Search workspace and common calendar locations
    icsFiles = findIcsFiles(WORKSPACE_DIR);
    const homeDir = process.env.HOME;
    const commonDirs = [
      path.join(homeDir, "Maildir"),
      path.join(homeDir, ".calendars"),
      path.join(homeDir, "Calendars"),
    ];
    for (const dir of commonDirs) {
      if (fs.existsSync(dir)) {
        icsFiles.push(...findIcsFiles(dir));
      }
    }
  }

  // Deduplicate
  icsFiles = [...new Set(icsFiles)];

  console.log(`Found ${icsFiles.length} .ics file(s).`);
  if (icsFiles.length === 0) {
    console.log("No calendar files found. Searched workspace and common calendar directories.");
    console.log("Use --path or --dir to specify a specific file or directory.");
    process.exit(0);
  }

  if (dryRun) {
    console.log("\n--- DRY RUN ---\n");
  }

  let eventCount = 0;
  let personCount = 0;
  let relCount = 0;

  for (const file of icsFiles) {
    let events;
    try {
      events = parseIcsFile(file);
    } catch (e) {
      console.error(`Failed to parse ${file}:`, e.message);
      continue;
    }

    console.log(`  ${file}: ${events.length} event(s)`);

    for (const event of events) {
      const eventName = event.summary || "Untitled Event";
      const eventId = `event:${escapeName(event.uid || eventName + "_" + event.dtstart)}`;
      const eventDesc = [
        event.summary,
        event.dtstart ? `Start: ${event.dtstart}` : "",
        event.dtend ? `End: ${event.dtend}` : "",
        event.location ? `Location: ${event.location}` : "",
        event.description ? event.description.substring(0, 200) : ""
      ].filter(Boolean).join(" | ");

      upsertEntity(eventId, eventName, "event", today, eventDesc);
      eventCount++;

      // Organizer
      if (event.organizer) {
        const orgId = `person:${escapeName(event.organizer)}`;
        upsertEntity(orgId, event.organizer, "person", today, `Organizer: ${eventName}`);
        personCount++;
        upsertRelationship(eventId, orgId, "organized_by", eventName, today);
        relCount++;
      }

      // Attendees
      for (const attendee of event.attendees) {
        const attId = `person:${escapeName(attendee)}`;
        upsertEntity(attId, attendee, "person", today, `Attendee: ${eventName}`);
        personCount++;
        upsertRelationship(eventId, attId, "attended_by", eventName, today);
        relCount++;
      }

      // Project links
      const linkedProjects = findProjectsForEvent(event);
      for (const proj of linkedProjects) {
        const projId = `repo:${proj}`;
        upsertEntity(projId, proj, "project", today);
        upsertRelationship(eventId, projId, "event_related_to_project", eventName, today);
        relCount++;
      }
    }
  }

  if (!dryRun) {
    console.log(`\nIngested ${eventCount} events, ${personCount} people, ${relCount} relationships.`);
  } else {
    console.log(`\n[DRY-RUN] Would ingest ${eventCount} events, ${personCount} people, ${relCount} relationships.`);
  }

  if (db && typeof db.close === "function") {
    db.close();
  }
}

main();

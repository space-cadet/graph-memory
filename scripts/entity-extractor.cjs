#!/usr/bin/env node
/**
 * entity-extractor.js
 * ─────────────────────────────────────────────
 * Extracts entities and relationships from OpenClaw journal files
 * and populates the SQLite entity graph database.
 *
 * Entity types: person, project, tool, concept, error, file,
 *               research_paper, institution, collaborator, advisor
 * Relationship types: mentioned_with, file_belongs_to_project,
 *                       tool_uses_file, session_mentions, error_in_tool,
 *                       concept_related_to, project_uses_tool,
 *                       authored_by, collaborated_with, advised_by,
 *                       affiliated_with, cites, implements
 *
 * Usage:
 *   node entity-extractor.js                    # process all journal files
 *   node entity-extractor.js --date 2026-05-21  # process specific date
 *   node entity-extractor.js --dry-run          # print, don't write
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
const JOURNAL_DIR = path.join(MEMORY_DIR, "journal");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dateOverride = args.includes("--date")
  ? args[args.indexOf("--date") + 1]
  : null;

/* ── SQLite setup ────────────────────────────── */
let db;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  console.error("better-sqlite3 not available, trying sqlite3...");
  try {
    const sqlite3 = require("sqlite3");
    db = new sqlite3.Database(DB_PATH);
  } catch (e2) {
    console.error("No SQLite module available. Install with:");
    console.error("  npm install better-sqlite3");
    process.exit(1);
  }
}

/* ── Entity canonicalization ─────────────────── */
const NAME_ALIASES = {
  // Person variants (replace with your own aliases)
  "user": "User Name",
  "user name": "User Name",
  "u.name": "User Name",
  "u. name": "User Name",
  "name": "User Name",
  // Agent variants
  "agent": "Agent Name",
  "agent name": "Agent Name",
  // Institutions (replace with your own)
  "institution1": "Institution One",
  "institution2": "Institution Two",
  // Advisors/collaborators (replace with your own)
  "advisor1": "Advisor One",
  "advisor2": "Advisor Two",
  "collaborator1": "Collaborator One",
  "collaborator2": "Collaborator Two",
  // Research areas (replace with your own)
  "research_area1": "Research Area One",
  "research_area2": "Research Area Two",
};

function canonicalizeName(name) {
  const lower = name.toLowerCase().trim();
  return NAME_ALIASES[lower] || name.trim();
}

/* ── Ensure schema ───────────────────────────── */
function ensureSchema() {
  const schema = `
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      canonical_name TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1,
      entity_type TEXT,
      confidence REAL,
      description TEXT,
      strength REAL,
      context TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relation_type TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1,
      context TEXT,
      UNIQUE(source, target, relation_type)
    );
    CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target);
    CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(relation_type);
  `;

  if (dryRun) {
    console.log("[DRY RUN] Would ensure schema");
    return;
  }

  // Execute each statement separately for compatibility
  const statements = schema.split(/;\s*\n/).filter(s => s.trim());
  for (const stmt of statements) {
    try {
      if (typeof db.exec === 'function') {
        db.exec(stmt);
      } else if (typeof db.run === 'function') {
        db.run(stmt);
      }
    } catch (e) {
      // Ignore "already exists" errors
      if (!e.message.includes("already exists")) {
        console.error("Schema error:", e.message);
      }
    }
  }
}

/* ── Entity extraction patterns ──────────────── */
const PATTERNS = {
  // [[Entity Name]] — explicit wiki-style links
  explicitLink: /\[\[([^\]]+)\]\]/g,

  // Projects: paths like ~/code/project-name/ or src/lib/Thing/
  projectPath: /(?:~\/code\/|src\/|workspace\/|projects\/)([a-zA-Z][a-zA-Z0-9_-]*)/g,

  // Tools: command names, package names
  tool: /\b(?:npm|pnpm|yarn|npx|git|curl|node|python|docker|vercel|supabase|clerk|esbuild|vite|tsc|playwright|qiskit|qutip|julia|sagemath|pytorch)\b/gi,

  // Files: *.md, *.ts, *.tsx, *.js, *.json
  file: /\b([A-Z][a-zA-Z]*\.md|[a-z][a-z0-9_-]*\.(?:ts|tsx|js|jsx|json|py|sh|yml|yaml|css|html))\b/g,

  // Decisions: "decided to X", "agreed on X", "chose X", "opted for X"
  decision: /(?:decided to|agreed on|chose|opted for|settled on|committed to|voted for|approved)\s+([a-z][a-z0-9_\s-]{3,40})/gi,

  // Topics: "topic: X", "about X", "regarding X", "on the subject of X"
  topic: /(?:topic|subject|theme|area|field)\s*(?::|——|→|of)\s*([A-Z][a-zA-Z]*(?:\s+[a-zA-Z]+){0,5})/gi,

  // Questions: "question: X", "asked X", "wondered X", "how to X", "why X"
  question: /(?:question|asked|wondered|how to|why|what if|should we|can we|will we)\s*[:]?\s*([A-Z][a-zA-Z]*(?:\s+[a-zA-Z]+){0,8}[?]?)/gi,

  // Concepts: Capitalized multi-word phrases in thinking blocks
  concept: /(?:thinking|thought|idea|concept|pattern|convention|protocol)\s*(?::|——|→)\s*([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+)/g,

  // People: known names + "X said/suggests" patterns
  person: /\b(User|Agent|Alice|Bob|Charlie|User Name|Agent Name|Collaborator One|Advisor One|Advisor Two)\b/g,

  // Institutions
  institution: /\b(Pennsylvania State University|Penn State|PSU|NITK|IIT|IUCAA|Perimeter Institute|ICGC)\b/gi,

  // Research papers: arXiv IDs
  arxivId: /\b(\d{4}\.\d{4,5}(?:v\d+)?)\b/g,

  // arXiv references
  arxivRef: /arXiv:\s*(\d{4}\.\d{4,5})/gi,

  // Errors: "Error: ..." or "Failed to ..."
  error: /Error:\s*([^\n]+)|Failed to\s+([^\n]+)/g,

  // GitHub repos / projects
  githubRepo: /github\.com\/[^\/\s]+\/([a-zA-Z0-9_-]+)/g,

  // URLs (as concepts/tools)
  url: /https?:\/\/([^\s]+)/g,
};

/* ── Extract entities from text ─────────────── */
function extractEntities(text, sessionDate) {
  const entities = new Map(); // name -> {type, count}
  const relationships = []; // {source, target, type, context}

  // Explicit [[Entity]] links
  let match;
  while ((match = PATTERNS.explicitLink.exec(text)) !== null) {
    const name = match[1].trim();
    const type = guessEntityType(name);
    addEntity(entities, name, type);
  }

  // Projects from paths
  PATTERNS.projectPath.lastIndex = 0;
  while ((match = PATTERNS.projectPath.exec(text)) !== null) {
    const name = match[1];
    if (name.length > 2 && !isCommonWord(name)) {
      addEntity(entities, name, "project");
    }
  }

  // GitHub repos
  PATTERNS.githubRepo.lastIndex = 0;
  while ((match = PATTERNS.githubRepo.exec(text)) !== null) {
    addEntity(entities, match[1], "project");
  }

  // Tools
  PATTERNS.tool.lastIndex = 0;
  while ((match = PATTERNS.tool.exec(text)) !== null) {
    addEntity(entities, match[0].toLowerCase(), "tool");
  }

  // Files
  PATTERNS.file.lastIndex = 0;
  while ((match = PATTERNS.file.exec(text)) !== null) {
    const name = match[1];
    addEntity(entities, name, "file");
  }

  // Decisions
  PATTERNS.decision.lastIndex = 0;
  while ((match = PATTERNS.decision.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length > 3 && !isCommonWord(name)) {
      addEntity(entities, name, "decision");
    }
  }

  // Topics
  PATTERNS.topic.lastIndex = 0;
  while ((match = PATTERNS.topic.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length > 3 && !isCommonWord(name)) {
      addEntity(entities, name, "topic");
    }
  }

  // Questions
  PATTERNS.question.lastIndex = 0;
  while ((match = PATTERNS.question.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length > 3 && !isCommonWord(name)) {
      addEntity(entities, name, "question");
    }
  }

  // Concepts
  PATTERNS.concept.lastIndex = 0;
  while ((match = PATTERNS.concept.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length > 3) {
      addEntity(entities, name, "concept");
    }
  }

  // People
  PATTERNS.person.lastIndex = 0;
  while ((match = PATTERNS.person.exec(text)) !== null) {
    addEntity(entities, match[1], "person");
  }

  // Institutions
  PATTERNS.institution.lastIndex = 0;
  while ((match = PATTERNS.institution.exec(text)) !== null) {
    addEntity(entities, match[1], "institution");
  }

  // arXiv IDs (as research_papers)
  PATTERNS.arxivId.lastIndex = 0;
  while ((match = PATTERNS.arxivId.exec(text)) !== null) {
    addEntity(entities, `arXiv:${match[1]}`, "research_paper");
  }

  PATTERNS.arxivRef.lastIndex = 0;
  while ((match = PATTERNS.arxivRef.exec(text)) !== null) {
    addEntity(entities, `arXiv:${match[1]}`, "research_paper");
  }

  // Errors
  PATTERNS.error.lastIndex = 0;
  while ((match = PATTERNS.error.exec(text)) !== null) {
    const errorText = match[1] || match[2];
    addEntity(entities, `Error: ${errorText.trim()}`, "error");
  }

  // Extract relationships
  // Session mentions: session date -> entity
  const sessionKey = `date:${sessionDate}`;
  for (const [name, info] of entities) {
    relationships.push({
      source: sessionKey,
      target: canonicalizeName(name),
      type: "session_mentions",
      context: null
    });
  }

  // File belongs to project
  const projects = Array.from(entities.entries())
    .filter(([_, info]) => info.type === "project")
    .map(([name, _]) => canonicalizeName(name));
  const files = Array.from(entities.entries())
    .filter(([_, info]) => info.type === "file")
    .map(([name, _]) => canonicalizeName(name));

  for (const file of files) {
    for (const project of projects) {
      if (text.includes(file) && text.includes(project)) {
        relationships.push({
          source: file,
          target: project,
          type: "file_belongs_to_project",
          context: null
        });
      }
    }
  }

  // Tool uses file
  const tools = Array.from(entities.entries())
    .filter(([_, info]) => info.type === "tool")
    .map(([name, _]) => canonicalizeName(name));
  for (const tool of tools) {
    for (const file of files) {
      if (text.includes(tool) && text.includes(file)) {
        relationships.push({
          source: tool,
          target: file,
          type: "tool_uses_file",
          context: null
        });
      }
    }
  }

  // Person-affiliated_with-Institution
  const people = Array.from(entities.entries())
    .filter(([_, info]) => info.type === "person")
    .map(([name, _]) => canonicalizeName(name));
  const institutions = Array.from(entities.entries())
    .filter(([_, info]) => info.type === "institution")
    .map(([name, _]) => canonicalizeName(name));
  for (const person of people) {
    for (const inst of institutions) {
      if (text.includes(person) && text.includes(inst)) {
        relationships.push({
          source: person,
          target: inst,
          type: "affiliated_with",
          context: null
        });
      }
    }
  }

  // Co-occurrence = mentioned_with (with context)
  const entityList = Array.from(entities.entries()).map(([name, info]) => ({
    name: canonicalizeName(name),
    type: info.type
  }));
  for (let i = 0; i < entityList.length; i++) {
    for (let j = i + 1; j < entityList.length; j++) {
      const ei = entityList[i].name;
      const ej = entityList[j].name;
      // Find a sentence containing both entities
      const context = extractContext(text, ei) || extractContext(text, ej) || null;
      relationships.push({
        source: ei,
        target: ej,
        type: "mentioned_with",
        context: context
      });
    }
  }

  return { entities, relationships };
}

function addEntity(entities, name, type) {
  const canonical = canonicalizeName(name);
  const key = canonical.toLowerCase();
  if (entities.has(key)) {
    entities.get(key).count++;
  } else {
    entities.set(key, { name: canonical, original: name, type, count: 1 });
  }
}

function guessEntityType(name) {
  if (/\.(md|ts|tsx|js|json|py)$/.test(name)) return "file";
  if (/^(npm|pnpm|yarn|git|curl|node|docker|vercel|supabase|clerk)$/.test(name)) return "tool";
  if (/\?$/.test(name)) return "question";
  if (/^(decided to|agreed on|chose|opted for|settled on|committed to)/i.test(name)) return "decision";
  if (/^(topic|subject|theme|area|field)\s*[:]/i.test(name)) return "topic";
  if (name.includes(" ") && name[0] === name[0].toUpperCase()) return "concept";
  if (/^(User|Agent|Alice|Bob|Charlie|User Name|Agent Name|Collaborator One|Advisor One|Advisor Two)$/.test(name)) return "person";
  return "concept";
}

function extractContext(text, entityName, windowSize = 80) {
  const idx = text.indexOf(entityName);
  if (idx === -1) return null;
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + entityName.length + windowSize);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function isCommonWord(word) {
  const common = new Set([
    "src", "lib", "dist", "build", "node_modules", "public", "assets",
    "components", "pages", "hooks", "utils", "types", "contexts",
    "test", "spec", "docs", "config", "scripts", "api", "code",
    "workspace", "projects", "tmp", "temp", "cache", "data"
  ]);
  return common.has(word.toLowerCase());
}

/* ── Database operations ─────────────────────── */
function upsertEntity(name, canonicalName, type, date) {
  if (dryRun) return;

  const stmt = `
    INSERT INTO entities (name, canonical_name, first_seen, last_seen, mention_count, entity_type, confidence, description, strength, context)
    VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, NULL, NULL)
    ON CONFLICT(name) DO UPDATE SET
      last_seen = ?,
      mention_count = mention_count + 1
  `;

  try {
    if (typeof db.prepare === 'function') {
      const prepared = db.prepare(stmt);
      prepared.run(name, canonicalName, date, date, type, date);
    } else if (typeof db.run === 'function') {
      db.run(stmt, [name, canonicalName, date, date, type, date]);
    }
  } catch (e) {
    console.error(`Failed to upsert entity ${name}:`, e.message);
  }
}

function upsertRelationship(source, target, type, context, date) {
  if (dryRun) return;

  const stmt = `
    INSERT INTO relationships (source, target, relation_type, first_seen, last_seen, mention_count, context)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(source, target, relation_type) DO UPDATE SET
      last_seen = ?,
      mention_count = mention_count + 1
  `;

  try {
    if (typeof db.prepare === 'function') {
      const prepared = db.prepare(stmt);
      prepared.run(source, target, type, date, date, context, date);
    } else if (typeof db.run === 'function') {
      db.run(stmt, [source, target, type, date, date, context, date]);
    }
  } catch (e) {
    // Ignore duplicate relationship errors
    if (!e.message.includes("UNIQUE constraint failed")) {
      console.error(`Failed to upsert relationship ${source}->${target}:`, e.message);
    }
  }
}

/* ── Process a single journal file ───────────── */
function processJournalFile(journalFile) {
  const basename = path.basename(journalFile, ".md");
  const sessionDate = basename; // YYYY-MM-DD

  console.error(`Processing journal: ${basename}`);

  let text;
  try {
    text = fs.readFileSync(journalFile, "utf8");
  } catch (e) {
    console.error(`  Failed to read: ${e.message}`);
    return { entities: 0, relationships: 0 };
  }

  const { entities, relationships } = extractEntities(text, sessionDate);

  if (dryRun) {
    console.log(`\n=== ${basename} ===`);
    console.log(`Entities found: ${entities.size}`);
    for (const [key, info] of entities) {
      console.log(`  [${info.type}] ${info.name} (${info.count}x)`);
    }
    console.log(`Relationships: ${relationships.length}`);
    for (const rel of relationships.slice(0, 10)) {
      console.log(`  ${rel.source} --[${rel.type}]--> ${rel.target}`);
    }
    if (relationships.length > 10) {
      console.log(`  ... and ${relationships.length - 10} more`);
    }
  }

  // Upsert to database
  for (const [key, info] of entities) {
    upsertEntity(key, info.name, info.type, sessionDate);
  }

  for (const rel of relationships) {
    upsertRelationship(rel.source, rel.target, rel.type, rel.context, sessionDate);
  }

  return {
    entities: entities.size,
    relationships: relationships.length
  };
}

/* ── Main ────────────────────────────────────── */
function main() {
  ensureSchema();

  let journalFiles;
  if (dateOverride) {
    const file = path.join(JOURNAL_DIR, `${dateOverride}.md`);
    if (!fs.existsSync(file)) {
      console.error(`Journal file not found: ${file}`);
      process.exit(1);
    }
    journalFiles = [file];
  } else {
    try {
      journalFiles = fs.readdirSync(JOURNAL_DIR)
        .filter(f => f.endsWith(".md"))
        .map(f => path.join(JOURNAL_DIR, f))
        .sort();
    } catch (e) {
      console.error(`No journal directory found: ${JOURNAL_DIR}`);
      process.exit(1);
    }
  }

  console.error(`Found ${journalFiles.length} journal file(s)`);

  let totalEntities = 0;
  let totalRelationships = 0;

  for (const file of journalFiles) {
    const result = processJournalFile(file);
    totalEntities += result.entities;
    totalRelationships += result.relationships;
  }

  console.error(`\nDone. Total: ${totalEntities} entities, ${totalRelationships} relationships.`);

  if (db && typeof db.close === 'function') {
    db.close();
  }
}

main();

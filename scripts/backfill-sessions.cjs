#!/usr/bin/env node
/**
 * backfill-sessions.cjs
 * ─────────────────────────────────────────────
 * Resumable backfill script that reprocesses historical session JSONL files
 * with LLM entity extraction. Saves progress to a checkpoint file.
 *
 * Features:
 *   - Batch processing with configurable size
 *   - Resumable via checkpoint file
 *   - Dry-run mode (print, no DB writes)
 *   - Random sample mode for testing
 *   - Rate limiting between batches
 *   - Progress reporting with ETA
 *   - Graceful SIGINT handling (saves checkpoint before exit)
 *   - Per-file error handling (logs and continues)
 *
 * Usage:
 *   node backfill-sessions.cjs
 *   node backfill-sessions.cjs --resume
 *   node backfill-sessions.cjs --dry-run
 *   node backfill-sessions.cjs --sample 3
 *   node backfill-sessions.cjs --batch-size 20 --delay 2
 *   node backfill-sessions.cjs --help
 */

const fs = require("fs");
const path = require("path");
const { extractWithLLM } = require("./llm-extractor.cjs");

/* ── Paths ───────────────────────────────────── */
const SESSIONS_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "agents",
  "main",
  "sessions"
);
const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const CHECKPOINT_PATH = path.join(MEMORY_DIR, ".backfill-checkpoint.json");

/* ── CLI args ────────────────────────────────── */
function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
backfill-sessions.cjs — Resumable session backfill with LLM extraction

Usage:
  node backfill-sessions.cjs [options]

Options:
  --resume              Continue from last checkpoint
  --dry-run             Print results, do not write to database
  --sample N            Process only N random sessions (for testing)
  --batch-size N        Process N sessions per batch (default: 10)
  --delay N             Seconds to wait between batches (default: 1)
  --help, -h            Show this help message

Examples:
  node backfill-sessions.cjs --dry-run --sample 3
  node backfill-sessions.cjs --batch-size 5 --delay 2
  node backfill-sessions.cjs --resume --batch-size 20
`);
    process.exit(0);
  }

  const getInt = (flag, def) => {
    const idx = args.indexOf(flag);
    if (idx === -1 || !args[idx + 1]) return def;
    const val = parseInt(args[idx + 1], 10);
    return isNaN(val) || val < 0 ? def : val;
  };

  return {
    resume: args.includes("--resume"),
    dryRun: args.includes("--dry-run"),
    sample: getInt("--sample", null),
    batchSize: getInt("--batch-size", 10) || 10,
    delay: getInt("--delay", 1),
  };
}

/* ── SQLite setup ────────────────────────────── */
let db;
let isBetterSqlite;

function initDb() {
  try {
    const Database = require("better-sqlite3");
    db = new Database(DB_PATH);
    isBetterSqlite = true;
  } catch (e) {
    try {
      const sqlite3 = require("sqlite3");
      db = new sqlite3.Database(DB_PATH);
      isBetterSqlite = false;
    } catch (e2) {
      console.error("No SQLite module available. Install with:");
      console.error("  npm install better-sqlite3");
      process.exit(1);
    }
  }
}

function dbClose() {
  if (db && typeof db.close === "function") {
    db.close();
  }
}

/* ── Schema ──────────────────────────────────── */
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

  const statements = schema
    .split(/;\s*\n/)
    .filter((s) => s.trim());

  for (const stmt of statements) {
    try {
      if (isBetterSqlite) {
        db.exec(stmt);
      } else {
        db.run(stmt);
      }
    } catch (e) {
      if (!e.message.includes("already exists") && !e.message.includes("duplicate column name")) {
        console.error("Schema error:", e.message);
      }
    }
  }
}

/* ── Entity canonicalization ─────────────────── */
const NAME_ALIASES = {
  "user": "User Name",
  "user name": "User Name",
  "agent": "Agent Name",
};

function canonicalizeName(name) {
  const lower = name.toLowerCase().trim();
  return NAME_ALIASES[lower] || name.trim();
}

/* ── Text extraction from JSONL ──────────────── */
function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function extractThinking(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "thinking")
    .map((c) => c.thinking)
    .join("\n");
}

/* ── Regex extraction patterns ───────────────── */
const PATTERNS = {
  explicitLink: /\[\[([^\]]+)\]\]/g,
  projectPath: /(?:~\/code\/|src\/|workspace\/|projects\/)([a-zA-Z][a-zA-Z0-9_-]*)/g,
  tool: /\b(?:npm|pnpm|yarn|npx|git|curl|node|python|docker|vercel|supabase|clerk|esbuild|vite|tsc|playwright|qiskit|qutip|julia|sagemath|pytorch)\b/gi,
  file: /\b([A-Z][a-zA-Z]*\.md|[a-z][a-z0-9_-]*\.(?:ts|tsx|js|jsx|json|py|sh|yml|yaml|css|html))\b/g,
  arxivId: /\b(\d{4}\.\d{4,5}(?:v\d+)?)\b/g,
  arxivRef: /arXiv:\s*(\d{4}\.\d{4,5})/gi,
  error: /Error:\s*([^\n]+)|Failed to\s+([^\n]+)/g,
  githubRepo: /github\.com\/[^\/\s]+\/([a-zA-Z0-9_-]+)/g,
  taskRef: /\b(T\d{1,3})\b/g,
  decision: /(?:decision|decided|agreed|concluded)\s*:?\s*([^\n]+)/gi,
  fileChange: /\b(write|edit|create|delete)\b\s+(?:file\s+)?[`"']?([a-zA-Z0-9_\-\/]+\.(?:ts|tsx|js|jsx|json|py|md|sh|yml|yaml|css|html))[`"']?/gi,
  blockerPhrase: /(?:blocker|blocked because|blocked on|waiting on|stuck on)\s*:?\s*([^\n]+)/gi,
  nextAction: /(?:next action|next step|need to|TODO:|todo:)\s*:?\s*([^\n]+)/gi,
  editChunk: /edits\/(\d{4}-\d{2}-\d{2})\/([\w-]+\.md)/g,
};

function guessEntityType(name) {
  if (/\.(md|ts|tsx|js|json|py)$/.test(name)) return "file";
  if (/^(npm|pnpm|yarn|git|curl|node|docker|vercel|supabase|clerk)$/.test(name)) return "tool";
  if (/^arXiv:/.test(name)) return "research_paper";
  if (/^T\d+$/.test(name)) return "task";
  if (/^Error:/.test(name)) return "error";
  if (/^[A-Z][a-z]+(\s+[A-Z][a-z]+)*$/.test(name) && name.includes(" ")) return "concept";
  return "project";
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

function addEntity(entities, name, type) {
  const canonical = canonicalizeName(name);
  const key = canonical.toLowerCase();
  if (entities.has(key)) {
    entities.get(key).count++;
  } else {
    entities.set(key, { name: canonical, original: name, type, count: 1 });
  }
}

/* ── Extract standard entities from text ─────── */
function extractEntities(text, sessionDate) {
  const entities = new Map();
  const relationships = [];
  let match;

  while ((match = PATTERNS.explicitLink.exec(text)) !== null) {
    const name = match[1].trim();
    const type = guessEntityType(name);
    addEntity(entities, name, type);
  }

  PATTERNS.projectPath.lastIndex = 0;
  while ((match = PATTERNS.projectPath.exec(text)) !== null) {
    const name = match[1];
    if (name.length > 2 && !isCommonWord(name)) {
      addEntity(entities, name, "project");
    }
  }

  PATTERNS.githubRepo.lastIndex = 0;
  while ((match = PATTERNS.githubRepo.exec(text)) !== null) {
    addEntity(entities, match[1], "project");
  }

  PATTERNS.tool.lastIndex = 0;
  while ((match = PATTERNS.tool.exec(text)) !== null) {
    addEntity(entities, match[0].toLowerCase(), "tool");
  }

  PATTERNS.file.lastIndex = 0;
  while ((match = PATTERNS.file.exec(text)) !== null) {
    addEntity(entities, match[1], "file");
  }

  PATTERNS.arxivId.lastIndex = 0;
  while ((match = PATTERNS.arxivId.exec(text)) !== null) {
    addEntity(entities, `arXiv:${match[1]}`, "research_paper");
  }

  PATTERNS.arxivRef.lastIndex = 0;
  while ((match = PATTERNS.arxivRef.exec(text)) !== null) {
    addEntity(entities, `arXiv:${match[1]}`, "research_paper");
  }

  PATTERNS.error.lastIndex = 0;
  while ((match = PATTERNS.error.exec(text)) !== null) {
    const errorText = match[1] || match[2];
    addEntity(entities, `Error: ${errorText.trim()}`, "error");
  }

  const sessionKey = `session:${sessionDate}`;
  const entityList = Array.from(entities.entries()).map(([name, info]) => ({
    name: info.name,
    type: info.type,
  }));

  for (const e of entityList) {
    relationships.push({
      source: sessionKey,
      target: e.name,
      type: "session_mentions",
      context: null,
    });
  }

  for (let i = 0; i < entityList.length; i++) {
    for (let j = i + 1; j < entityList.length; j++) {
      relationships.push({
        source: entityList[i].name,
        target: entityList[j].name,
        type: "mentioned_with",
        context: null,
      });
    }
  }

  return { entities, relationships };
}

/* ── Extract protocol entities from text ─────── */
function extractProtocolEntities(text, sessionDate) {
  const entities = new Map();
  const relationships = [];
  let match;

  // Task references
  PATTERNS.taskRef.lastIndex = 0;
  while ((match = PATTERNS.taskRef.exec(text)) !== null) {
    const taskName = match[1].toUpperCase();
    addEntity(entities, taskName, "task");
  }

  // Decisions
  PATTERNS.decision.lastIndex = 0;
  while ((match = PATTERNS.decision.exec(text)) !== null) {
    const decisionText = match[1].trim();
    if (decisionText.length > 10) {
      const decisionId = `decision:${decisionText.slice(0, 100)}`;
      addEntity(entities, decisionId, "decision");
      relationships.push({
        source: decisionId,
        target: `session:${sessionDate}`,
        type: "decision_made_in_session",
        context: decisionText,
      });
    }
  }

  // File changes
  PATTERNS.fileChange.lastIndex = 0;
  while ((match = PATTERNS.fileChange.exec(text)) !== null) {
    const operation = match[1].toLowerCase();
    const filepath = match[2];
    const changeId = `change:${operation}:${filepath}`;
    addEntity(entities, changeId, "file_change");
    relationships.push({
      source: changeId,
      target: `session:${sessionDate}`,
      type: "file_changed_in_session",
      context: `${operation} ${filepath}`,
    });
  }

  // Blockers
  PATTERNS.blockerPhrase.lastIndex = 0;
  while ((match = PATTERNS.blockerPhrase.exec(text)) !== null) {
    const blockerText = match[1].trim();
    if (blockerText.length > 5) {
      const blockerId = `blocker:${blockerText.slice(0, 80)}`;
      addEntity(entities, blockerId, "blocker");
      relationships.push({
        source: blockerId,
        target: `session:${sessionDate}`,
        type: "blocker_found_in_session",
        context: blockerText,
      });
    }
  }

  // Next actions
  PATTERNS.nextAction.lastIndex = 0;
  while ((match = PATTERNS.nextAction.exec(text)) !== null) {
    const actionText = match[1].trim();
    if (actionText.length > 5) {
      const actionId = `next:${actionText.slice(0, 80)}`;
      addEntity(entities, actionId, "next_action");
      relationships.push({
        source: actionId,
        target: `session:${sessionDate}`,
        type: "next_action_in_session",
        context: actionText,
      });
    }
  }

  // Edit chunks
  PATTERNS.editChunk.lastIndex = 0;
  while ((match = PATTERNS.editChunk.exec(text)) !== null) {
    const date = match[1];
    const filename = match[2];
    const chunkId = `edit:${date}/${filename}`;
    addEntity(entities, chunkId, "edit_chunk");
    relationships.push({
      source: chunkId,
      target: `session:${sessionDate}`,
      type: "edit_chunk_in_session",
      context: null,
    });
  }

  return { entities, relationships };
}

/* ── Database operations ─────────────────────── */
function upsertEntity(name, canonicalName, type, date, confidence, description, context) {
  const stmt = `
    INSERT INTO entities (name, canonical_name, first_seen, last_seen, mention_count, entity_type, confidence, description, context)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      last_seen = ?,
      mention_count = mention_count + 1,
      confidence = COALESCE(MAX(confidence, excluded.confidence), confidence),
      description = COALESCE(description, excluded.description),
      context = COALESCE(context, excluded.context)
  `;
  try {
    if (isBetterSqlite) {
      db.prepare(stmt).run(
        name, canonicalName, date, date, type,
        confidence || null, description || null, context || null,
        date
      );
    } else {
      db.run(stmt, [
        name, canonicalName, date, date, type,
        confidence || null, description || null, context || null,
        date,
      ]);
    }
  } catch (e) {
    console.error(`Failed to upsert entity ${name}:`, e.message);
  }
}

function upsertRelationship(source, target, type, context, date) {
  const stmt = `
    INSERT INTO relationships (source, target, relation_type, first_seen, last_seen, mention_count, context)
    VALUES (?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(source, target, relation_type) DO UPDATE SET
      last_seen = ?,
      mention_count = mention_count + 1
  `;
  try {
    if (isBetterSqlite) {
      db.prepare(stmt).run(source, target, type, date, date, context || null, date);
    } else {
      db.run(stmt, [source, target, type, date, date, context || null, date]);
    }
  } catch (e) {
    if (!e.message.includes("UNIQUE constraint failed")) {
      console.error(`Failed to upsert relationship ${source}->${target}:`, e.message);
    }
  }
}

/* ── Process a single session file ───────────── */
async function processSessionFile(sessionPath, dryRun) {
  const basename = path.basename(sessionPath, ".jsonl");

  let entries;
  try {
    const content = fs.readFileSync(sessionPath, "utf8");
    entries = content
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter((e) => e !== null);
  } catch (e) {
    throw new Error(`Failed to read: ${e.message}`);
  }

  let sessionDate = basename.split("T")[0];
  const sessionEntry = entries.find((e) => e.type === "session");
  if (sessionEntry && sessionEntry.timestamp) {
    sessionDate = sessionEntry.timestamp.split("T")[0];
  }

  let allText = "";
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      if (msg.role === "user" || msg.role === "assistant") {
        allText += extractText(msg.content) + "\n" + extractThinking(msg.content) + "\n";
      }
    }
  }

  if (!allText.trim()) {
    return { entities: 0, relationships: 0, sessionDate };
  }

  // LLM extraction
  const llmResult = await extractWithLLM(allText, { silent: true });

  // Regex extraction (supplement)
  const { entities: regexEntities, relationships: regexRelationships } =
    extractEntities(allText, sessionDate);
  const { entities: protoEntities, relationships: protoRelationships } =
    extractProtocolEntities(allText, sessionDate);

  // Merge all entities
  const entities = new Map();

  // LLM entities
  if (llmResult && llmResult.entities) {
    for (const ent of llmResult.entities) {
      const key = ent.name.toLowerCase().trim();
      if (!key) continue;
      if (entities.has(key)) {
        const existing = entities.get(key);
        existing.count++;
        existing.confidence = Math.max(existing.confidence || 0, ent.confidence || 0);
        if (ent.description && !existing.description) existing.description = ent.description;
        if (ent.context && !existing.context) existing.context = ent.context;
      } else {
        entities.set(key, {
          name: canonicalizeName(ent.name),
          type: ent.type || "concept",
          count: 1,
          confidence: ent.confidence || 0.5,
          description: ent.description || null,
          context: ent.context || null,
        });
      }
    }
  }

  // LLM decisions
  for (const dec of llmResult.decisions || []) {
    const key = `decision:${dec.text.slice(0, 80).toLowerCase()}`;
    if (!entities.has(key)) {
      entities.set(key, {
        name: `decision:${dec.text.slice(0, 100)}`,
        type: "decision",
        count: 1,
        confidence: dec.confidence || 0.5,
        description: dec.text,
        context: dec.context || null,
      });
    }
  }

  // LLM topics
  for (const topic of llmResult.topics || []) {
    const key = topic.name.toLowerCase().trim();
    if (!key) continue;
    if (!entities.has(key)) {
      entities.set(key, {
        name: canonicalizeName(topic.name),
        type: "topic",
        count: 1,
        confidence: topic.confidence || 0.5,
        description: null,
        context: topic.context || null,
      });
    }
  }

  // LLM questions
  for (const q of llmResult.questions || []) {
    const key = `question:${q.text.slice(0, 80).toLowerCase()}`;
    if (!entities.has(key)) {
      entities.set(key, {
        name: `question:${q.text.slice(0, 100)}`,
        type: "question",
        count: 1,
        confidence: q.confidence || 0.5,
        description: q.text,
        context: q.context || null,
      });
    }
  }

  // Merge regex and protocol entities
  for (const [key, info] of regexEntities) {
    if (entities.has(key)) {
      entities.get(key).count += info.count;
    } else {
      entities.set(key, info);
    }
  }
  for (const [key, info] of protoEntities) {
    if (entities.has(key)) {
      entities.get(key).count += info.count;
    } else {
      entities.set(key, info);
    }
  }

  // Build relationships
  const relationships = [];
  relationships.push(...regexRelationships);
  relationships.push(...protoRelationships);

  // Session mentions for all entities
  const sessionKey = `session:${sessionDate}`;
  for (const [key, info] of entities) {
    relationships.push({
      source: sessionKey,
      target: info.name,
      type: "session_mentions",
      context: info.context,
    });
  }

  // Dry-run output
  if (dryRun) {
    console.log(`\n=== ${basename} ===`);
    console.log(`Text length: ${allText.length} chars`);
    console.log(`Entities: ${entities.size}`);
    const byType = {};
    for (const [key, info] of entities) {
      byType[info.type] = (byType[info.type] || 0) + 1;
    }
    for (const [type, count] of Object.entries(byType).sort()) {
      console.log(`  ${type}: ${count}`);
    }
    console.log(`Relationships: ${relationships.length}`);
    for (const rel of relationships.slice(0, 8)) {
      console.log(`  ${rel.source} --[${rel.type}]--> ${rel.target}`);
    }
    if (relationships.length > 8) {
      console.log(`  ... and ${relationships.length - 8} more`);
    }
    return { entities: entities.size, relationships: relationships.length, sessionDate };
  }

  // Upsert to DB
  for (const [key, info] of entities) {
    upsertEntity(key, info.name, info.type, sessionDate, info.confidence, info.description, info.context);
  }
  for (const rel of relationships) {
    upsertRelationship(rel.source, rel.target, rel.type, rel.context, sessionDate);
  }

  return { entities: entities.size, relationships: relationships.length, sessionDate };
}

/* ── Checkpoint ────────────────────────────────── */
function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
    }
  } catch (e) {
    console.error("Checkpoint read error:", e.message);
  }
  return {
    lastProcessedIndex: -1,
    totalEntities: 0,
    totalRelationships: 0,
    startTime: null,
    lastUpdated: null,
  };
}

function saveCheckpoint(checkpoint) {
  checkpoint.lastUpdated = new Date().toISOString();
  try {
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
  } catch (e) {
    console.error("Checkpoint write error:", e.message);
  }
}

/* ── Format ETA ──────────────────────────────── */
function formatETA(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/* ── Main ────────────────────────────────────── */
async function main() {
  const options = parseArgs();
  const runStartTime = Date.now();

  initDb();
  if (!options.dryRun) {
    ensureSchema();
  }

  // Find all session files (excluding trajectory)
  let sessionFiles;
  try {
    sessionFiles = fs
      .readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".trajectory.jsonl"))
      .map((f) => path.join(SESSIONS_DIR, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  } catch (e) {
    console.error(`No sessions directory found: ${SESSIONS_DIR}`);
    process.exit(1);
  }

  if (sessionFiles.length === 0) {
    console.error("No session files found.");
    process.exit(0);
  }

  const originalTotal = sessionFiles.length;

  // Random sample mode
  if (options.sample !== null && options.sample > 0) {
    if (options.sample < sessionFiles.length) {
      // Fisher-Yates shuffle
      for (let i = sessionFiles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sessionFiles[i], sessionFiles[j]] = [sessionFiles[j], sessionFiles[i]];
      }
      sessionFiles = sessionFiles.slice(0, options.sample);
    }
    console.log(`📦 Sample mode: processing ${sessionFiles.length} random session(s) out of ${originalTotal}`);
  }

  // Load checkpoint
  const checkpoint = loadCheckpoint();

  if (options.resume && checkpoint.lastProcessedIndex >= 0) {
    const skipCount = checkpoint.lastProcessedIndex + 1;
    if (skipCount < sessionFiles.length) {
      console.log(`🔄 Resuming from checkpoint: skipping ${skipCount} already processed file(s)`);
      sessionFiles = sessionFiles.slice(skipCount);
    } else {
      console.log("✅ All files from checkpoint already processed.");
      dbClose();
      return;
    }
  } else if (!options.dryRun) {
    // Fresh start: reset checkpoint
    checkpoint.startTime = new Date().toISOString();
    checkpoint.lastProcessedIndex = -1;
    checkpoint.totalEntities = 0;
    checkpoint.totalRelationships = 0;
  }

  if (sessionFiles.length === 0) {
    console.log("No session files to process.");
    dbClose();
    return;
  }

  console.log(`📂 Total sessions to process: ${sessionFiles.length}`);
  console.log(`⚙️  Batch size: ${options.batchSize}, Delay: ${options.delay}s`);
  if (options.dryRun) console.log("🧪 DRY RUN — no DB writes");
  console.log();

  let processedCount = 0;
  let totalEntities = checkpoint.totalEntities || 0;
  let totalRelationships = checkpoint.totalRelationships || 0;
  let interrupted = false;

  // SIGINT handler
  function onSigint() {
    console.log("\n\n⚠️  Interrupted! Saving checkpoint...");
    interrupted = true;
    saveCheckpoint(checkpoint);
    dbClose();
    const runElapsed = (Date.now() - runStartTime) / 1000;
    console.log(`💾 Checkpoint saved at index ${checkpoint.lastProcessedIndex}.`);
    console.log(`   Processed ${processedCount} session(s) in this run (${formatETA(runElapsed)}).`);
    process.exit(0);
  }
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  // Process in batches
  const totalToProcess = sessionFiles.length;
  for (let i = 0; i < totalToProcess; i += options.batchSize) {
    const batch = sessionFiles.slice(i, i + options.batchSize);

    for (let j = 0; j < batch.length; j++) {
      if (interrupted) break;
      const file = batch[j];
      const basename = path.basename(file);

      try {
        const result = await processSessionFile(file, options.dryRun);
        totalEntities += result.entities;
        totalRelationships += result.relationships;
        processedCount++;
      } catch (e) {
        console.error(`❌ ${basename}: ${e.message}`);
      }
    }

    // Update checkpoint
    if (!options.dryRun) {
      checkpoint.lastProcessedIndex =
        (checkpoint.lastProcessedIndex >= 0 ? checkpoint.lastProcessedIndex : -1) + batch.length;
      checkpoint.totalEntities = totalEntities;
      checkpoint.totalRelationships = totalRelationships;
      saveCheckpoint(checkpoint);
    }

    // Progress report
    const elapsed = (Date.now() - runStartTime) / 1000;
    const rate = elapsed > 0 ? processedCount / elapsed : 0;
    const remaining = rate > 0 ? (totalToProcess - processedCount) / rate : 0;
    const pct = totalToProcess > 0 ? ((processedCount / totalToProcess) * 100).toFixed(1) : "0.0";
    console.log(
      `Processed ${processedCount}/${totalToProcess} (${pct}%) - ETA: ${formatETA(remaining)} | ` +
      `Entities: ${totalEntities}, Relationships: ${totalRelationships}`
    );

    if (interrupted) break;

    // Rate limit between batches
    if (i + options.batchSize < totalToProcess && options.delay > 0) {
      await new Promise((r) => setTimeout(r, options.delay * 1000));
    }
  }

  // Final save
  if (!options.dryRun) {
    saveCheckpoint(checkpoint);
  }
  dbClose();

  const totalElapsed = (Date.now() - runStartTime) / 1000;
  console.log(`\n✅ Done. Processed ${processedCount} session(s) in ${formatETA(totalElapsed)}`);
  console.log(`   Total entities: ${totalEntities}`);
  console.log(`   Total relationships: ${totalRelationships}`);
  if (!options.dryRun) {
    console.log(`   Checkpoint: ${CHECKPOINT_PATH}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

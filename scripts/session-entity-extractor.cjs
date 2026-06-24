#!/usr/bin/env node
/**
 * session-entity-extractor.js  (v2 — Protocol-Aware)
 * ─────────────────────────────────────────────
 * Extracts entities and relationships from raw OpenClaw session JSONL files.
 * Reads FULL conversation text (not truncated journal summaries).
 *
 * v2 adds memory-bank protocol extraction:
 *   - Task lifecycle (T19, T20…) with status, blockers, next actions
 *   - Edit chunk detection (edits/YYYY-MM-DD/…)
 *   - Decisions and protocol actions
 *
 * Usage:
 *   node session-entity-extractor.js                    # process all new sessions
 *   node session-entity-extractor.js --all              # force full rebuild
 *   node session-entity-extractor.js --dry-run          # print, don't write
 *   node session-entity-extractor.js --file <path>      # process specific file
 */

const { extractWithLLM } = require('./llm-extractor.cjs');
const fs = require("fs");
const path = require("path");

/* ── Paths ───────────────────────────────────── */
const MEMORY_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory"
);
const SESSIONS_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "agents",
  "main",
  "sessions"
);
const DB_PATH = path.join(MEMORY_DIR, "graph.db");
const WATERMARK_PATH = path.join(MEMORY_DIR, ".session-watermark.json");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const processAll = args.includes("--all");
const specificFile = args.includes("--file")
  ? args[args.indexOf("--file") + 1]
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
  "user": "User Name",
  "user name": "User Name",
  "u.name": "User Name",
  "u. name": "User Name",
  "name": "User Name",
  "agent": "Agent Name",
  "agent name": "Agent Name",
  "institution1": "Institution One",
  "institution2": "Institution Two",
  "advisor1": "Advisor One",
  "advisor2": "Advisor Two",
  "collaborator1": "Collaborator One",
  "collaborator2": "Collaborator Two",
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

  const statements = schema.split(/;\s*\n/).filter(s => s.trim());
  for (const stmt of statements) {
    try {
      if (typeof db.exec === 'function') {
        db.exec(stmt);
      } else if (typeof db.run === 'function') {
        db.run(stmt);
      }
    } catch (e) {
      if (!e.message.includes("already exists")) {
        console.error("Schema error:", e.message);
      }
    }
  }
}

/* ── Watermark management ────────────────────── */
function loadWatermark() {
  try {
    if (fs.existsSync(WATERMARK_PATH)) {
      return JSON.parse(fs.readFileSync(WATERMARK_PATH, "utf8"));
    }
  } catch (e) {
    console.error("Watermark read error:", e.message);
  }
  return { lastProcessedMtime: 0, processedCount: 0, lastRun: null };
}

function saveWatermark(watermark) {
  if (dryRun) return;
  try {
    fs.writeFileSync(WATERMARK_PATH, JSON.stringify(watermark, null, 2));
  } catch (e) {
    console.error("Watermark write error:", e.message);
  }
}

/* ── Entity extraction patterns ──────────────── */
const PATTERNS = {
  // --- Standard entities ---
  explicitLink: /\[\[([^\]]+)\]\]/g,
  projectPath: /(?:~\/code\/|src\/|workspace\/|projects\/)([a-zA-Z][a-zA-Z0-9_-]*)/g,
  tool: /\b(?:npm|pnpm|yarn|npx|git|curl|node|python|docker|vercel|supabase|clerk|esbuild|vite|tsc|playwright|qiskit|qutip|julia|sagemath|pytorch)\b/gi,
  file: /\b([A-Z][a-zA-Z]*\.md|[a-z][a-z0-9_-]*\.(?:ts|tsx|js|jsx|json|py|sh|yml|yaml|css|html))\b/g,
  concept: /(?:thinking|thought|idea|concept|pattern|convention|protocol)\s*(?::|——|→)\s*([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)+)/g,
  person: /\b(User|Agent|Alice|Bob|Charlie|User Name|Agent Name|Collaborator One|Advisor One|Advisor Two)\b/g,
  institution: /\b(Pennsylvania State University|Penn State|PSU|NITK|IIT|IUCAA|Perimeter Institute|ICGC)\b/gi,
  arxivId: /\b(\d{4}\.\d{4,5}(?:v\d+)?)\b/g,
  arxivRef: /arXiv:\s*(\d{4}\.\d{4,5})/gi,
  error: /Error:\s*([^\n]+)|Failed to\s+([^\n]+)/g,
  githubRepo: /github\.com\/[^\/\s]+\/([a-zA-Z0-9_-]+)/g,
  url: /https?:\/\/([^\s]+)/g,

  // --- Memory-bank protocol entities ---
  taskRef: /\b(T\d{1,3})\b/g,
  taskStatus: /\b(T\d{1,3})\b.*?\b(?:is\s+)?(blocked|in_progress|in progress|completed|complete|pending|paused|done)\b/gi,
  blockerPhrase: /(?:blocker|blocked because|blocked on|waiting on|stuck on)\s*:?\s*([^\n]+)/gi,
  nextAction: /(?:next action|next step|need to|TODO:|todo:)\s*:?\s*([^\n]+)/gi,
  editChunk: /edits\/(\d{4}-\d{2}-\d{2})\/([\w-]+\.md)/g,
  editChunkCreate: /(?:created|wrote)\s+(?:an?\s+)?edit\s*chunk\s+(?:in\s+)?(?:edits\/)?(\d{4}-\d{2}-\d{2})?\/?([\w-]+\.md)?/gi,
  decision: /(?:decision|decided|agreed|concluded)\s*:?\s*([^\n]+)/gi,
  fileChange: /\b(write|edit|create|delete)\b\s+(?:file\s+)?[`\"']?([a-zA-Z0-9_\-\/]+\.(?:ts|tsx|js|jsx|json|py|md|sh|yml|yaml|css|html))[`\"']?/gi,
};

/* ── Extract text from JSONL content ─────────── */
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

/* ── Extract protocol entities from text ─────── */
function extractProtocolEntities(text, sessionDate) {
  const entities = new Map();
  const relationships = [];
  let match;

  // --- Task references (T19, T20, etc.) ---
  PATTERNS.taskRef.lastIndex = 0;
  while ((match = PATTERNS.taskRef.exec(text)) !== null) {
    const taskName = match[1].toUpperCase();
    addEntity(entities, taskName, "task");
  }

  // --- Task status transitions ---
  PATTERNS.taskStatus.lastIndex = 0;
  while ((match = PATTERNS.taskStatus.exec(text)) !== null) {
    const taskName = match[1].toUpperCase();
    const status = match[2].toLowerCase().replace(/\s+/g, "_");
    addEntity(entities, taskName, "task");
    relationships.push({
      source: taskName,
      target: `status:${status}`,
      type: "task_has_status",
      context: match[0]
    });
  }

  // --- Blockers ---
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
        context: blockerText
      });

      // Link blocker to any task mentioned nearby (within 200 chars)
      const nearbyText = text.slice(Math.max(0, match.index - 200), match.index + 200);
      const nearbyTasks = [...nearbyText.matchAll(/\b(T\d{1,3})\b/g)].map(m => m[1].toUpperCase());
      for (const task of new Set(nearbyTasks)) {
        relationships.push({
          source: task,
          target: blockerId,
          type: "task_blocked_by",
          context: blockerText
        });
      }
    }
  }

  // --- Next actions ---
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
        context: actionText
      });

      // Link next action to nearby tasks
      const nearbyText = text.slice(Math.max(0, match.index - 200), match.index + 200);
      const nearbyTasks = [...nearbyText.matchAll(/\b(T\d{1,3})\b/g)].map(m => m[1].toUpperCase());
      for (const task of new Set(nearbyTasks)) {
        relationships.push({
          source: task,
          target: actionId,
          type: "task_next_action",
          context: actionText
        });
      }
    }
  }

  // --- Edit chunks ---
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
      context: null
    });

    // Link to nearby tasks
    const nearbyText = text.slice(Math.max(0, match.index - 300), match.index + 300);
    const nearbyTasks = [...nearbyText.matchAll(/\b(T\d{1,3})\b/g)].map(m => m[1].toUpperCase());
    for (const task of new Set(nearbyTasks)) {
      relationships.push({
        source: chunkId,
        target: task,
        type: "edit_chunk_for_task",
        context: null
      });
    }
  }

  // --- Decisions ---
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
        context: decisionText
      });
    }
  }

  // --- File changes from tool calls ---
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
      context: `${operation} ${filepath}`
    });

    // Link to nearby tasks
    const nearbyText = text.slice(Math.max(0, match.index - 300), match.index + 300);
    const nearbyTasks = [...nearbyText.matchAll(/\b(T\d{1,3})\b/g)].map(m => m[1].toUpperCase());
    for (const task of new Set(nearbyTasks)) {
      relationships.push({
        source: changeId,
        target: task,
        type: "file_change_for_task",
        context: null
      });
    }
  }

  return { entities, relationships };
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

  PATTERNS.concept.lastIndex = 0;
  while ((match = PATTERNS.concept.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length > 3) addEntity(entities, name, "concept");
  }

  PATTERNS.person.lastIndex = 0;
  while ((match = PATTERNS.person.exec(text)) !== null) {
    addEntity(entities, match[1], "person");
  }

  PATTERNS.institution.lastIndex = 0;
  while ((match = PATTERNS.institution.exec(text)) !== null) {
    addEntity(entities, match[1], "institution");
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
    name: canonicalizeName(name),
    type: info.type
  }));

  for (const e of entityList) {
    relationships.push({
      source: sessionKey,
      target: e.name,
      type: "session_mentions",
      context: null
    });
  }

  const projects = entityList.filter(e => e.type === "project").map(e => e.name);
  const files = entityList.filter(e => e.type === "file").map(e => e.name);
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

  const tools = entityList.filter(e => e.type === "tool").map(e => e.name);
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

  const people = entityList.filter(e => e.type === "person").map(e => e.name);
  const institutions = entityList.filter(e => e.type === "institution").map(e => e.name);
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

  for (let i = 0; i < entityList.length; i++) {
    for (let j = i + 1; j < entityList.length; j++) {
      relationships.push({
        source: entityList[i].name,
        target: entityList[j].name,
        type: "mentioned_with",
        context: null
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
  if (name.includes(" ") && name[0] === name[0].toUpperCase()) return "concept";
  if (/^(User|Agent|Alice|Bob|Charlie|User Name|Agent Name|Collaborator One|Advisor One|Advisor Two)$/.test(name)) return "person";
  return "concept";
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
function upsertEntity(name, canonicalName, type, date, confidence, description, context) {
  if (dryRun) return;
  const stmt = `
    INSERT INTO entities (name, canonical_name, first_seen, last_seen, mention_count, entity_type, confidence, description, strength, context)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)
    ON CONFLICT(name) DO UPDATE SET
      last_seen = ?,
      mention_count = mention_count + 1,
      confidence = COALESCE(MAX(confidence, excluded.confidence), confidence),
      description = COALESCE(description, excluded.description),
      context = COALESCE(context, excluded.context)
  `;
  try {
    if (typeof db.prepare === 'function') {
      db.prepare(stmt).run(name, canonicalName, date, date, type, confidence || null, description || null, context || null, date);
    } else if (typeof db.run === 'function') {
      db.run(stmt, [name, canonicalName, date, date, type, confidence || null, description || null, context || null, date]);
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
      db.prepare(stmt).run(source, target, type, date, date, context, date);
    } else if (typeof db.run === 'function') {
      db.run(stmt, [source, target, type, date, date, context, date]);
    }
  } catch (e) {
    if (!e.message.includes("UNIQUE constraint failed")) {
      console.error(`Failed to upsert relationship ${source}->${target}:`, e.message);
    }
  }
}

/* ── Process a single session file ───────────── */
async function processSessionFile(sessionPath) {
  const basename = path.basename(sessionPath, ".jsonl");
  console.error(`Processing session: ${basename}`);

  let entries;
  try {
    const content = fs.readFileSync(sessionPath, "utf8");
    entries = content
      .trim()
      .split("\n")
      .map((line) => {
        try { return JSON.parse(line); } catch (e) { return null; }
      })
      .filter(e => e !== null);
  } catch (e) {
    console.error(`  Failed to read: ${e.message}`);
    return { entities: 0, relationships: 0, sessionDate: null };
  }

  let sessionDate = basename.split("T")[0];
  const sessionEntry = entries.find(e => e.type === "session");
  if (sessionEntry && sessionEntry.timestamp) {
    sessionDate = sessionEntry.timestamp.split("T")[0];
  }

  let allText = "";
  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      if (msg.role === "user" || msg.role === "assistant") {
        const text = extractText(msg.content);
        const thinking = extractThinking(msg.content);
        allText += text + "\n" + thinking + "\n";
      }
    }
  }

  if (!allText.trim()) {
    console.error(`  No text content found`);
    return { entities: 0, relationships: 0, sessionDate };
  }

  const llmResult = await extractWithLLM(allText, { silent: true });

  // Extract standard entities (regex fallback + supplement)
  const { entities, relationships } = extractEntities(allText, sessionDate);

  // Extract protocol entities
  const { entities: protoEntities, relationships: protoRelationships } = extractProtocolEntities(allText, sessionDate);

  // Merge LLM entities (primary source)
  if (llmResult && llmResult.entities && llmResult.entities.length > 0) {
    for (const ent of llmResult.entities) {
      const key = ent.name.toLowerCase().trim();
      if (entities.has(key)) {
        const existing = entities.get(key);
        existing.count++;
        existing.confidence = Math.max(existing.confidence || 0, ent.confidence || 0);
        if (ent.description && !existing.description) existing.description = ent.description;
        if (ent.context && !existing.context) existing.context = ent.context;
      } else {
        entities.set(key, {
          name: canonicalizeName(ent.name),
          original: ent.name,
          type: ent.type || 'concept',
          count: 1,
          confidence: ent.confidence || 0.5,
          description: ent.description || null,
          context: ent.context || null,
        });
      }
    }

    // Add LLM decisions as entities
    for (const dec of llmResult.decisions || []) {
      const key = `decision:${dec.text.slice(0, 80).toLowerCase()}`;
      if (!entities.has(key)) {
        entities.set(key, {
          name: `decision:${dec.text.slice(0, 100)}`,
          original: dec.text,
          type: 'decision',
          count: 1,
          confidence: dec.confidence || 0.5,
          description: dec.text,
          context: dec.context || null,
        });
      }
    }

    // Add LLM topics as entities
    for (const topic of llmResult.topics || []) {
      const key = topic.name.toLowerCase().trim();
      if (!entities.has(key)) {
        entities.set(key, {
          name: canonicalizeName(topic.name),
          original: topic.name,
          type: 'topic',
          count: 1,
          confidence: topic.confidence || 0.5,
          description: null,
          context: topic.context || null,
        });
      }
    }

    // Add LLM questions as entities
    for (const q of llmResult.questions || []) {
      const key = `question:${q.text.slice(0, 80).toLowerCase()}`;
      if (!entities.has(key)) {
        entities.set(key, {
          name: `question:${q.text.slice(0, 100)}`,
          original: q.text,
          type: 'question',
          count: 1,
          confidence: q.confidence || 0.5,
          description: q.text,
          context: q.context || null,
        });
      }
    }
  }

  // Merge protocol entities into main entities map
  for (const [key, info] of protoEntities) {
    if (entities.has(key)) {
      entities.get(key).count += info.count;
    } else {
      entities.set(key, info);
    }
  }
  relationships.push(...protoRelationships);

  if (dryRun) {
    console.log(`\n=== ${basename} ===`);
    console.log(`Text length: ${allText.length} chars`);
    console.log(`Entities found: ${entities.size}`);
    const taskEntities = Array.from(entities.values()).filter(e => e.type === "task");
    const editChunks = Array.from(entities.values()).filter(e => e.type === "edit_chunk");
    const decisions = Array.from(entities.values()).filter(e => e.type === "decision");
    if (taskEntities.length) console.log(`  Tasks: ${taskEntities.map(e => e.name).join(", ")}`);
    if (editChunks.length) console.log(`  Edit chunks: ${editChunks.length}`);
    if (decisions.length) console.log(`  Decisions: ${decisions.length}`);
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

  for (const [key, info] of entities) {
    upsertEntity(key, info.name, info.type, sessionDate, info.confidence, info.description, info.context);
  }
  for (const rel of relationships) {
    upsertRelationship(rel.source, rel.target, rel.type, rel.context, sessionDate);
  }

  return { entities: entities.size, relationships: relationships.length, sessionDate };
}

/* ── Main ────────────────────────────────────── */
async function main() {
  ensureSchema();

  let sessionFiles;

  if (specificFile) {
    if (!fs.existsSync(specificFile)) {
      console.error(`File not found: ${specificFile}`);
      process.exit(1);
    }
    sessionFiles = [specificFile];
  } else {
    try {
      sessionFiles = fs
        .readdirSync(SESSIONS_DIR)
        .filter(f => f.endsWith(".jsonl"))
        .filter(f => !f.includes(".deleted.") && !f.includes(".reset."))
        .map(f => {
          const full = path.join(SESSIONS_DIR, f);
          return { name: f, path: full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => a.mtime - b.mtime);
    } catch (e) {
      console.error(`No sessions directory found: ${SESSIONS_DIR}`);
      process.exit(1);
    }

    if (!processAll) {
      const watermark = loadWatermark();
      const beforeCount = sessionFiles.length;
      sessionFiles = sessionFiles.filter(f => f.mtime > watermark.lastProcessedMtime);
      console.error(`Watermark: ${watermark.lastProcessedMtime} (${watermark.lastRun || "never"})`);
      console.error(`Files to process: ${sessionFiles.length} (skipped ${beforeCount - sessionFiles.length})`);
    } else {
      console.error(`Full rebuild mode — processing all ${sessionFiles.length} files`);
    }

    sessionFiles = sessionFiles.map(f => f.path);
  }

  if (sessionFiles.length === 0) {
    console.error("No new session files to process.");
    if (db && typeof db.close === 'function') db.close();
    return;
  }

  let totalEntities = 0;
  let totalRelationships = 0;
  let maxMtime = 0;

  for (const file of sessionFiles) {
    const result = await processSessionFile(file);
    totalEntities += result.entities;
    totalRelationships += result.relationships;
    const mtime = fs.statSync(file).mtimeMs;
    if (mtime > maxMtime) maxMtime = mtime;
  }

  if (!dryRun && !specificFile) {
    const watermark = loadWatermark();
    watermark.lastProcessedMtime = maxMtime;
    watermark.processedCount += sessionFiles.length;
    watermark.lastRun = new Date().toISOString();
    saveWatermark(watermark);
  }

  console.error(`\nDone. Total: ${totalEntities} entities, ${totalRelationships} relationships from ${sessionFiles.length} session(s).`);

  if (db && typeof db.close === 'function') db.close();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

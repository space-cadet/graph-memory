#!/usr/bin/env node
/**
 * generate-startup-context.cjs
 * ─────────────────────────────────────────────
 * Generates memory/graph-startup-context.md from the knowledge graph.
 * Intended to be called during agent startup or via cron/heartbeat.
 * Caches results — only regenerates if cache is > 1 hour old.
 *
 * Usage:
 *   node generate-startup-context.cjs
 *   node generate-startup-context.cjs --force   # bypass cache
 */

const fs = require("fs");
const path = require("path");

const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, "memory");
const CACHE_FILE = path.join(WORKSPACE_DIR, ".openclaw_memory", ".graph-context-cache");
const OUTPUT_FILE = path.join(MEMORY_DIR, "graph-startup-context.md");
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/* ── Check cache ─────────────────────────────── */
const force = process.argv.includes("--force");

if (!force && fs.existsSync(CACHE_FILE)) {
  const cacheTime = parseInt(fs.readFileSync(CACHE_FILE, "utf8").trim(), 10);
  const ageMs = Date.now() - cacheTime;
  if (ageMs < CACHE_TTL_MS) {
    const mins = Math.round(ageMs / 60000);
    console.log(`Cache fresh (${mins}m old). Skipping regeneration.`);
    process.exit(0);
  }
}

/* ── Load query bridge ───────────────────────── */
const QUERY_BRIDGE_PATH = path.join(__dirname, "query-bridge.cjs");
let queryBridge;
try {
  const mod = require(QUERY_BRIDGE_PATH);
  queryBridge = mod.queryBridge;
} catch (e) {
  console.error("Failed to load query bridge:", e.message);
  process.exit(1);
}

/* ── Noise filters ───────────────────────────── */
const NOISE_PATTERNS = [
  /^check-mail/i,
  /^mail-setup/i,
  /^heartbeat/i,
  /^next:/i,
  /heartbeat-log/,
  /heartbeat-state/,
  /heartbeat-failures/,
];

function isNoise(name) {
  return NOISE_PATTERNS.some(p => p.test(name));
}

/* ── Query graph ─────────────────────────────── */
const RECENT_DAYS = 7;
const recentCutoff = new Date();
recentCutoff.setDate(recentCutoff.getDate() - RECENT_DAYS);

// 1. Recent entities (last seen within 7 days)
const allRecent = queryBridge.search("", { limit: 200, deep: false })
  .filter(e => {
    if (isNoise(e.name)) return false;
    if (!e.lastSeen) return false;
    const d = new Date(e.lastSeen);
    return d >= recentCutoff;
  })
  .sort((a, b) => {
    // Sort by last seen desc, then mentions desc
    const d = new Date(b.lastSeen) - new Date(a.lastSeen);
    if (d !== 0) return d;
    return (b.mentions || 0) - (a.mentions || 0);
  });

// 2. Top projects
const topProjects = queryBridge.search("", { type: "project", limit: 20, deep: false })
  .filter(e => !isNoise(e.name))
  .sort((a, b) => (b.mentions || 0) - (a.mentions || 0));

// 3. Top persons
const topPersons = queryBridge.search("", { type: "person", limit: 20, deep: false })
  .filter(e => !isNoise(e.name))
  .sort((a, b) => (b.mentions || 0) - (a.mentions || 0));

// 4. Research papers
const papers = queryBridge.search("", { type: "research_paper", limit: 20, deep: false })
  .filter(e => !isNoise(e.name))
  .sort((a, b) => (b.mentions || 0) - (a.mentions || 0));

/* ── Generate markdown ───────────────────────── */
let md = `# Graph Startup Context\n\n`;
md += `*Auto-generated from knowledge graph. Updated: ${new Date().toISOString()}*\n\n`;

if (allRecent.length > 0) {
  md += `## Recent Activity (last ${RECENT_DAYS} days)\n\n`;
  for (const e of allRecent.slice(0, 15)) {
    md += `- **${e.name}** [${e.type}] — ${e.mentions || 0} mentions`;
    if (e.description) md += ` — ${e.description.slice(0, 100)}${e.description.length > 100 ? "..." : ""}`;
    md += `\n`;
  }
  md += `\n`;
}

if (topProjects.length > 0) {
  md += `## Active Projects\n\n`;
  for (const e of topProjects.slice(0, 10)) {
    md += `- **${e.name}** — ${e.mentions || 0} mentions`;
    if (e.description) md += ` — ${e.description.slice(0, 100)}${e.description.length > 100 ? "..." : ""}`;
    md += `\n`;
  }
  md += `\n`;
}

if (topPersons.length > 0) {
  md += `## Key People\n\n`;
  for (const e of topPersons.slice(0, 10)) {
    md += `- **${e.name}** — ${e.mentions || 0} mentions`;
    if (e.description) md += ` — ${e.description.slice(0, 100)}${e.description.length > 100 ? "..." : ""}`;
    md += `\n`;
  }
  md += `\n`;
}

if (papers.length > 0) {
  md += `## Research Papers\n\n`;
  for (const e of papers.slice(0, 10)) {
    md += `- **${e.name}** — ${e.mentions || 0} mentions`;
    if (e.description) md += ` — ${e.description.slice(0, 100)}${e.description.length > 100 ? "..." : ""}`;
    md += `\n`;
  }
  md += `\n`;
}

md += `---\n`;
md += `*To refresh: \`node code/graph-memory/scripts/generate-startup-context.cjs\`*\n`;

/* ── Write output ────────────────────────────── */
fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.writeFileSync(OUTPUT_FILE, md);
fs.writeFileSync(CACHE_FILE, String(Date.now()));

console.log(`Wrote ${OUTPUT_FILE} (${allRecent.length} recent, ${topProjects.length} projects, ${topPersons.length} persons, ${papers.length} papers).`);

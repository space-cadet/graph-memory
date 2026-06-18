#!/usr/bin/env node
/**
 * read-session.js
 * ─────────────────────────────────────────────
 * Reads the most recent JSONL session file from
 * ~/.openclaw/agents/main/sessions/
 * and outputs a structured markdown summary.
 *
 * Safety:
 *   • Read-only access to JSONL files — NEVER writes
 *   • Skips .deleted.* and .reset.* files
 *   • Does NOT touch MEMORY.md, SOUL.md, USER.md, TOOLS.md, AGENTS.md
 *
 * Usage:
 *   node ~/.openclaw/workspace/.openclaw_memory/scripts/read-session.js
 *   node ... --format json        # output raw JSON
 *   node ... --file <path>        # read specific file
 *   node ... --limit 50           # only last N messages
 */

const fs = require("fs");
const path = require("path");

const SESSIONS_DIR = path.join(
  process.env.HOME,
  ".openclaw",
  "agents",
  "main",
  "sessions"
);

/* ── CLI args ───────────────────────────────── */
const args = process.argv.slice(2);
const format = args.includes("--format") ? args[args.indexOf("--format") + 1] : "markdown";
const filePath = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;
const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : Infinity;

/* ── Find most recent valid session file ────── */
function findLatestSession(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .filter((f) => !f.includes(".deleted.") && !f.includes(".reset."))
    .map((f) => {
      const full = path.join(dir, f);
      return { name: f, path: full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) throw new Error("No valid session files found in " + dir);
  return files[0];
}

/* ── Read & parse JSONL ───────────────────────── */
function readSession(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (err) {
      entries.push({ type: "parse_error", line: i + 1, error: err.message, raw: line.slice(0, 200) });
    }
  }
  return entries;
}

/* ── Extract structured data ──────────────────── */
function extractData(entries) {
  const summary = {
    sessionId: null,
    startedAt: null,
    model: null,
    userMessages: [],
    assistantMessages: [],
    toolCalls: [],
    toolResults: [],
    errors: [],
    thinkingBlocks: 0,
    totalEntries: entries.length,
  };

  for (const e of entries) {
    if (e.type === "session") {
      summary.sessionId = e.id;
      summary.startedAt = e.timestamp;
    }
    if (e.type === "model_change") {
      summary.model = e.modelId || e.model;
    }
    if (e.type === "message" && e.message) {
      const msg = e.message;
      const ts = e.timestamp;
      const id = e.id;

      if (msg.role === "user") {
        const text = extractText(msg.content);
        summary.userMessages.push({ id, timestamp: ts, text });
      }
      if (msg.role === "assistant") {
        const text = extractText(msg.content);
        const thinking = extractThinking(msg.content);
        const calls = extractToolCalls(msg.content);
        summary.assistantMessages.push({ id, timestamp: ts, text, thinking, toolCalls: calls.length });
        summary.toolCalls.push(...calls.map((c) => ({ ...c, parentId: id, timestamp: ts })));
        if (thinking) summary.thinkingBlocks++;
      }
      if (msg.role === "toolResult") {
        summary.toolResults.push({
          id,
          timestamp: ts,
          toolCallId: msg.toolCallId || msg.toolCall_id,
          toolName: msg.toolName,
          status: msg.details?.status || "unknown",
          isError: msg.isError || false,
          contentPreview: extractText(msg.content)?.slice(0, 300),
        });
      }
    }
    if (e.type === "error" || e.type === "parse_error") {
      summary.errors.push({
        type: e.type,
        timestamp: e.timestamp,
        message: e.error || e.message,
        ...(e.line ? { line: e.line } : {}),
      });
    }
  }

  return summary;
}

/* ── Helpers ──────────────────────────────────── */
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
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((c) => c.type === "thinking");
  if (!blocks.length) return null;
  return blocks.map((b) => b.thinking).join("\n").slice(0, 500);
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c.type === "toolCall")
    .map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.arguments,
    }));
}

/* ── Formatters ───────────────────────────────── */
function toMarkdown(s) {
  const lines = [
    `# Session Summary`,
    ``,
    `- **Session ID:** \`${s.sessionId}\``,
    `- **Started:** ${s.startedAt || "unknown"}`,
    `- **Model:** ${s.model || "unknown"}`,
    `- **Total entries:** ${s.totalEntries}`,
    ``,
    `## Messages`,
    ``,
    `| Role | Count |`,
    `|------|-------|`,
    `| User | ${s.userMessages.length} |`,
    `| Assistant | ${s.assistantMessages.length} |`,
    `| Tool Results | ${s.toolResults.length} |`,
    `| Thinking blocks | ${s.thinkingBlocks} |`,
    ``,
    `## Tool Calls`,
    ``,
    `| # | Name | Args |`,
    `|---|------|------|`,
  ];

  s.toolCalls.forEach((tc, i) => {
    const argKeys = Object.keys(tc.arguments || {}).join(", ") || "none";
    lines.push(`| ${i + 1} | \`${tc.name}\` | ${argKeys} |`);
  });

  if (!s.toolCalls.length) lines.push(`_(none)_`);

  lines.push(
    ``,
    `## Errors`,
    ``
  );

  if (s.errors.length) {
    s.errors.forEach((err) => {
      lines.push(`- **${err.type}** @ ${err.timestamp || "?"}: ${err.message}`);
    });
  } else {
    lines.push(`_(none detected)_`);
  }

  lines.push(
    ``,
    `## User Messages (last ${Math.min(s.userMessages.length, limit === Infinity ? s.userMessages.length : limit)})`,
    ``
  );

  const shownUser = limit === Infinity ? s.userMessages : s.userMessages.slice(-limit);
  shownUser.forEach((m, i) => {
    const preview = m.text?.slice(0, 200).replace(/\n/g, " ");
    lines.push(`${i + 1}. **${m.timestamp || "?"}** — ${preview}${m.text?.length > 200 ? "…" : ""}`);
  });

  lines.push(
    ``,
    `## Assistant Messages (last ${Math.min(s.assistantMessages.length, limit === Infinity ? s.assistantMessages.length : limit)})`,
    ``
  );

  const shownAsst = limit === Infinity ? s.assistantMessages : s.assistantMessages.slice(-limit);
  shownAsst.forEach((m, i) => {
    const preview = m.text?.slice(0, 200).replace(/\n/g, " ");
    lines.push(`${i + 1}. **${m.timestamp || "?"}** — ${preview}${m.text?.length > 200 ? "…" : ""}`);
    if (m.toolCalls) lines.push(`   - Tools: ${m.toolCalls}`);
  });

  lines.push(``, `---`, `*Generated by OpenClaw Memory System*`, ``);
  return lines.join("\n");
}

/* ── Main ────────────────────────────────────── */
function main() {
  try {
    const target = filePath || findLatestSession(SESSIONS_DIR).path;
    console.error(`Reading: ${target}`);
    const entries = readSession(target);
    const summary = extractData(entries);

    if (format === "json") {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(toMarkdown(summary));
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
/**
 * journal-writer.js
 * ─────────────────────────────────────────────
 * Automatic journal capture for OpenClaw sessions.
 * Reads the current session's JSONL file, extracts new entries
 * since the last run (tracked via watermark), and appends a
 * structured markdown summary to the daily journal.
 *
 * Safety:
 *   • Read-only access to JSONL files — NEVER writes
 *   • Does NOT touch MEMORY.md, SOUL.md, USER.md, TOOLS.md, AGENTS.md
 *   • Journal files are append-only — never overwrites existing content
 *   • Watermark file tracks last processed line count
 *
 * Usage:
 *   node ~/.openclaw/workspace/.openclaw_memory/scripts/journal-writer.js
 *   node ... --dry-run              # print what would be written, no writes
 *   node ... --session <id>         # process specific session
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
const SESSIONS_REGISTRY = path.join(
  process.env.HOME,
  ".openclaw",
  "agents",
  "main",
  "sessions",
  "sessions.json"
);
const JOURNAL_DIR = path.join(MEMORY_DIR, "journal");
const WATERMARK_FILE = path.join(MEMORY_DIR, ".watermark");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const sessionIdOverride = args.includes("--session")
  ? args[args.indexOf("--session") + 1]
  : null;
const fileOverride = args.includes("--file")
  ? args[args.indexOf("--file") + 1]
  : null;

/* ── Load watermark ──────────────────────────── */
function loadWatermark() {
  try {
    const raw = fs.readFileSync(WATERMARK_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return {}; // no watermark → start from beginning
  }
}

function saveWatermark(wm) {
  if (dryRun) return;
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(WATERMARK_FILE, JSON.stringify(wm, null, 2) + "\n");
}

/* ── Find current session from registry ──────── */
function findCurrentSession() {
  const registry = JSON.parse(fs.readFileSync(SESSIONS_REGISTRY, "utf8"));
  // The registry keys are like "agent:main:main", "agent:main:telegram:..."
  // Find the most recently updated session
  const sessions = Object.values(registry).filter((s) => s.sessionFile && fs.existsSync(s.sessionFile));
  if (!sessions.length) throw new Error("No active sessions found in registry");
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions[0];
}

/* ── Read JSONL ────────────────────────────────── */
function readJsonl(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      entries.push({ lineNum: i + 1, data: JSON.parse(line) });
    } catch {
      entries.push({ lineNum: i + 1, data: { type: "parse_error", raw: line.slice(0, 200) } });
    }
  }
  return entries;
}

/* ── Extract text from content ─────────────────── */
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
  return blocks.map((b) => b.thinking).join("\n");
}

function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c.type === "toolCall");
}

function extractFilesFromArgs(args) {
  if (!args || typeof args !== "object") return [];
  const files = [];
  // Common file-related keys in tool arguments
  const fileKeys = ["file_path", "path", "filePath", "filepath", "file", "dest", "source", "target", "fileName"];
  for (const key of fileKeys) {
    if (args[key]) files.push(args[key]);
  }
  // Handle array of paths (e.g. for git add, etc.)
  if (args.paths && Array.isArray(args.paths)) files.push(...args.paths);
  return [...new Set(files)].filter((f) => typeof f === "string");
}

/* ── Summarize user message ──────────────────── */
const SYSTEM_MSG_PATTERNS = [
  /^A new session was started via \/new or \/reset/,
  /^User Message From Kimi:/,
  /^Conversation info \(untrusted metadata\):/,
  /^\[Sat\s+\d{4}-\d{2}-\d{2}/, // [Sat 2026-05-16 ...] OpenClaw runtime context
  /^OpenClaw runtime context \(internal\):/,
  /^Pre-compaction memory flush\./,
  /^Note: The previous agent run was aborted/,
  /^\[media attached:/,
  /^\[Queued messages while agent was busy\]/,
  /^System:/,
  /^\[Post-compaction context refresh\]/,
];

function isSystemMessage(text) {
  if (!text) return true;
  return SYSTEM_MSG_PATTERNS.some((p) => p.test(text.trim()));
}

function summarizeUser(text) {
  if (!text) return "(empty)";
  if (isSystemMessage(text)) return null; // skip
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 100) return clean;
  return clean.slice(0, 100) + "…";
}

/* ── Format timestamp ─────────────────────────── */
function fmtTime(iso) {
  if (!iso) return "??:??:??";
  const d = new Date(iso);
  return d.toISOString().slice(11, 19); // HH:MM:SS
}
function fmtDate(iso) {
  if (!iso) return "????-??-??";
  return iso.slice(0, 10);
}

/* ── Process entries ──────────────────────────── */
function processEntries(entries, sessionId) {
  const events = [];
  let currentUserMsg = null;
  let currentAssistantMsg = null;

  for (const { lineNum, data } of entries) {
    // Session metadata
    if (data.type === "session") {
      events.push({
        kind: "session_start",
        timestamp: data.timestamp,
        sessionId: data.id,
        cwd: data.cwd,
      });
      continue;
    }

    // Error
    if (data.type === "error" || data.type === "parse_error") {
      events.push({
        kind: "error",
        timestamp: data.timestamp,
        type: data.type,
        message: data.error || data.message || "(unknown error)",
        line: data.line,
      });
      continue;
    }

    // Message
    if (data.type === "message" && data.message) {
      const msg = data.message;
      const ts = data.timestamp;

      if (msg.role === "user") {
        const text = extractText(msg.content);
        const summary = summarizeUser(text);
        if (!summary) continue; // skip system/runtime messages

        currentUserMsg = {
          kind: "user_message",
          timestamp: ts,
          id: data.id,
          summary,
        };
        events.push(currentUserMsg);
        currentAssistantMsg = null;
      }

      if (msg.role === "assistant") {
        const thinking = extractThinking(msg.content);
        const toolCalls = extractToolCalls(msg.content);
        const text = extractText(msg.content);

        // Skip purely system-text turns with no tools or thinking
        if (!thinking && !toolCalls.length && isSystemMessage(text)) {
          continue;
        }

        currentAssistantMsg = {
          kind: "assistant_turn",
          timestamp: ts,
          id: data.id,
          text: text?.slice(0, 200),
          thinking: thinking
            ? thinking.slice(0, 300).replace(/\s+/g, " ")
            : null,
          tools: toolCalls.map((tc) => ({
            name: tc.name,
            args: tc.arguments,
            files: extractFilesFromArgs(tc.arguments),
          })),
        };
        events.push(currentAssistantMsg);
      }

      if (msg.role === "toolResult") {
        const isError = msg.isError || false;
        const status = msg.details?.status || "unknown";
        // Only log tool results if they're errors
        if (!isError && status !== "error") continue;
        const preview = extractText(msg.content)?.slice(0, 100);
        events.push({
          kind: "tool_result",
          timestamp: ts,
          id: data.id,
          toolCallId: msg.toolCallId || msg.toolCall_id,
          toolName: msg.toolName,
          status,
          isError,
          contentPreview: preview,
        });
      }
    }
  }

  return events;
}

/* ── Render events to markdown ───────────────── */
function renderMarkdown(events, sessionId) {
  if (!events.length) return ""; // nothing new

  const lines = [];
  const now = new Date().toISOString();

  lines.push(`---`);
  lines.push(`**${fmtTime(now)}** · Session \`${sessionId}\``);
  lines.push(``);

  let userMsgCount = 0;
  let toolCount = 0;
  let errorCount = 0;

  for (const ev of events) {
    switch (ev.kind) {
      case "session_start":
        lines.push(`📂 Session started @ ${fmtTime(ev.timestamp)} — cwd: \`${ev.cwd || "?"}\``);
        lines.push(``);
        break;

      case "user_message":
        userMsgCount++;
        lines.push(`**User** · ${ev.summary}`);
        lines.push(``);
        break;

      case "assistant_turn": {
        const toolNames = ev.tools.map((t) => `\`${t.name}\``).join(", ");
        const allFiles = ev.tools.flatMap((t) => t.files);
        const uniqueFiles = [...new Set(allFiles)].map((f) => `\`${path.basename(f)}\``);

        if (toolNames) {
          lines.push(`🛠 Tools: ${toolNames}`);
          toolCount += ev.tools.length;
        }
        if (uniqueFiles.length) {
          lines.push(`📁 Files: ${uniqueFiles.join(", ")}`);
        }
        if (ev.thinking) {
          lines.push(`💡 ${ev.thinking}`);
        }
        if (toolNames || uniqueFiles.length || ev.thinking) {
          lines.push(``);
        }
        break;
      }

      case "tool_result":
        if (ev.isError || ev.status === "error") {
          lines.push(`❌ **Error** · \`${ev.toolName}\`: ${ev.contentPreview || "failed"}`);
          errorCount++;
          lines.push(``);
        }
        break;

      case "error":
        lines.push(`❌ **${ev.type}** @ ${fmtTime(ev.timestamp)}: ${ev.message}`);
        errorCount++;
        lines.push(``);
        break;
    }
  }

  // Summary line
  lines.push(`_(${userMsgCount} user msg${userMsgCount !== 1 ? "s" : ""}, ${toolCount} tool call${toolCount !== 1 ? "s" : ""}, ${errorCount} error${errorCount !== 1 ? "s" : ""})_`);
  lines.push(``);

  return lines.join("\n");
}

/* ── Main ────────────────────────────────────── */
function main() {
  try {
    // Ensure directories exist
    if (!dryRun) {
      fs.mkdirSync(JOURNAL_DIR, { recursive: true });
    }

    // Find session
    let sessionFile, sessionId;
    
    if (fileOverride) {
      sessionFile = fileOverride;
      sessionId = sessionIdOverride || path.basename(sessionFile).replace(/\.jsonl.*$/, "");
    } else if (sessionIdOverride) {
      const sessionInfo = { sessionFile: path.join(path.dirname(SESSIONS_REGISTRY), `${sessionIdOverride}.jsonl`), sessionId: sessionIdOverride };
      sessionFile = sessionInfo.sessionFile;
      sessionId = sessionInfo.sessionId;
    } else {
      const sessionInfo = findCurrentSession();
      sessionFile = sessionInfo.sessionFile;
      sessionId = sessionInfo.sessionId || path.basename(sessionFile, ".jsonl");
    }

    if (!fs.existsSync(sessionFile)) {
      throw new Error(`Session file not found: ${sessionFile}`);
    }

    // Load watermark
    const wm = loadWatermark();
    const prevLine = wm[sessionId] || 0;

    // Read JSONL
    const allEntries = readJsonl(sessionFile);
    const totalLines = allEntries.length;

    if (totalLines <= prevLine) {
      console.error(`No new entries. Session ${sessionId}: ${totalLines} lines, watermark at ${prevLine}.`);
      return;
    }

    const newEntries = allEntries.slice(prevLine);
    console.error(
      `Processing session ${sessionId}: ${newEntries.length} new entries (lines ${prevLine + 1}–${totalLines})`
    );

    // Process
    const events = processEntries(newEntries, sessionId);
    const markdown = renderMarkdown(events, sessionId);

    if (!markdown.trim()) {
      console.error("Nothing to journal.");
      // Still update watermark so we don't re-check
      wm[sessionId] = totalLines;
      saveWatermark(wm);
      return;
    }

    // Determine journal file
    const today = new Date().toISOString().slice(0, 10);
    const journalFile = path.join(JOURNAL_DIR, `${today}.md`);

    // Check if journal header exists
    let needsHeader = false;
    try {
      const existing = fs.readFileSync(journalFile, "utf8");
      needsHeader = !existing.includes(`# Journal — ${today}`);
    } catch {
      needsHeader = true;
    }

    let output = "";
    if (needsHeader) {
      output += `# Journal — ${today}\n\n`;
      output += `> Auto-generated by OpenClaw Memory System\n\n`;
    }
    output += markdown;

    if (dryRun) {
      console.log("=== DRY RUN ===");
      console.log(`Would append to: ${journalFile}`);
      console.log("---");
      console.log(output);
      console.log("---");
    } else {
      fs.appendFileSync(journalFile, output);
      console.error(`Appended to ${journalFile}`);
    }

    // Update watermark
    wm[sessionId] = totalLines;
    saveWatermark(wm);
    console.error(`Watermark updated: ${sessionId} → line ${totalLines}`);
  } catch (err) {
    console.error("Journal writer error:", err.message);
    process.exit(1);
  }
}

main();

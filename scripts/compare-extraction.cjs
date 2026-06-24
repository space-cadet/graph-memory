#!/usr/bin/env node
/**
 * compare-extraction.cjs
 * ─────────────────────────────────────────────
 * Compare regex-only vs LLM+regex entity extraction on a sample session file.
 * Run as: node compare-extraction.cjs <session-file>
 */

const fs = require("fs");
const path = require("path");
const { extractWithLLM, extractWithRegex } = require("./llm-extractor.cjs");

/* ── Extract text from JSONL ────────────────── */
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

function readSessionText(sessionPath) {
  const content = fs.readFileSync(sessionPath, "utf8");
  const entries = content
    .trim()
    .split("\n")
    .map((line) => {
      try { return JSON.parse(line); } catch (e) { return null; }
    })
    .filter(e => e !== null);

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
  return allText;
}

/* ── Count entities by type ──────────────────── */
function countByType(entities) {
  const counts = {};
  for (const ent of entities) {
    const type = ent.type || ent.entity_type || "unknown";
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

/* ── Compare two entity sets ────────────────── */
function compareEntities(regexResult, llmResult) {
  const regexNames = new Set(regexResult.entities.map(e => e.name.toLowerCase()));
  const llmNames = new Set(llmResult.entities.map(e => e.name.toLowerCase()));

  const onlyInRegex = [...regexNames].filter(n => !llmNames.has(n));
  const onlyInLLM = [...llmNames].filter(n => !regexNames.has(n));
  const inBoth = [...regexNames].filter(n => llmNames.has(n));

  return { onlyInRegex, onlyInLLM, inBoth };
}

/* ── Main ───────────────────────────────────── */
async function main() {
  const sessionPath = process.argv[2] || 
    path.join(process.env.HOME, ".openclaw", "agents", "main", "sessions", "0d77f105-81ca-4b49-a053-872b698351d7.jsonl");

  if (!fs.existsSync(sessionPath)) {
    console.error(`Session file not found: ${sessionPath}`);
    process.exit(1);
  }

  console.error(`Reading session: ${path.basename(sessionPath)}`);
  const allText = readSessionText(sessionPath);
  const textSize = Buffer.byteLength(allText, "utf8");
  console.error(`Extracted ${textSize} bytes of text (${allText.split("\n").length} lines)`);

  if (textSize < 5000) {
    console.error("Warning: Session text is < 5KB, results may not be representative");
  }

  console.error("\n--- Running regex-only extraction ---");
  const regexResult = extractWithRegex(allText);
  console.error(`Regex entities: ${regexResult.entities.length}`);
  console.error(`Regex decisions: ${regexResult.decisions.length}`);
  console.error(`Regex questions: ${regexResult.questions.length}`);
  console.error(`Regex topics: ${regexResult.topics.length}`);

  console.error("\n--- Running LLM extraction ---");
  const llmResult = await extractWithLLM(allText, { silent: false, maxChunkSize: 8000 });
  console.error(`LLM entities: ${llmResult.entities.length}`);
  console.error(`LLM decisions: ${llmResult.decisions.length}`);
  console.error(`LLM questions: ${llmResult.questions.length}`);
  console.error(`LLM topics: ${llmResult.topics.length}`);
  console.error(`LLM fallback: ${llmResult.fallback}`);
  if (llmResult.error) console.error(`LLM error: ${llmResult.error}`);

  console.error("\n--- Comparison ---");
  const comparison = compareEntities(regexResult, llmResult);
  console.error(`Entities in both: ${comparison.inBoth.length}`);
  console.error(`Only in regex: ${comparison.onlyInRegex.length}`);
  console.error(`Only in LLM: ${comparison.onlyInLLM.length}`);

  console.error("\n--- Entity type breakdown ---");
  console.error("Regex:", JSON.stringify(countByType(regexResult.entities), null, 2));
  console.error("LLM:", JSON.stringify(countByType(llmResult.entities), null, 2));

  // Output full JSON for analysis
  const report = {
    sessionFile: path.basename(sessionPath),
    textSize,
    regex: {
      entityCount: regexResult.entities.length,
      decisionCount: regexResult.decisions.length,
      questionCount: regexResult.questions.length,
      topicCount: regexResult.topics.length,
      typeBreakdown: countByType(regexResult.entities),
      entities: regexResult.entities.slice(0, 50), // limit output
    },
    llm: {
      entityCount: llmResult.entities.length,
      decisionCount: llmResult.decisions.length,
      questionCount: llmResult.questions.length,
      topicCount: llmResult.topics.length,
      fallback: llmResult.fallback,
      error: llmResult.error || null,
      typeBreakdown: countByType(llmResult.entities),
      entities: llmResult.entities.slice(0, 50), // limit output
    },
    comparison: {
      inBoth: comparison.inBoth.length,
      onlyInRegex: comparison.onlyInRegex.slice(0, 20),
      onlyInLLM: comparison.onlyInLLM.slice(0, 20),
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

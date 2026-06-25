#!/usr/bin/env node
/**
 * multi-source-ingestor.cjs
 * ─────────────────────────────────────────────
 * Integration script that runs all graph-memory ingestion sources
 * (git commits, file modifications, calendar events, arXiv papers)
 * and reports aggregated stats. Each source runs independently,
 * and deduplication is handled by the individual ingestors via
 * SQLite ON CONFLICT upserts.
 *
 * Usage:
 *   node scripts/multi-source-ingestor.cjs              # run all sources
 *   node scripts/multi-source-ingestor.cjs --git-only  # git + file status only
 *   node scripts/multi-source-ingestor.cjs --dry-run    # all sources in dry-run mode
 *   node scripts/multi-source-ingestor.cjs --arxiv "loop quantum gravity" --max 5
 */

const { execSync } = require("child_process");
const path = require("path");

const SCRIPT_DIR = __dirname;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const gitOnly = args.includes("--git-only");

// Optional arXiv override
let arxivKeyword = null;
let arxivMax = 10;
const arxivIdx = args.indexOf("--arxiv");
if (arxivIdx !== -1 && args[arxivIdx + 1]) {
  arxivKeyword = args[arxivIdx + 1];
}
const maxIdx = args.indexOf("--max");
if (maxIdx !== -1 && args[maxIdx + 1]) {
  arxivMax = args[maxIdx + 1];
}

function runSource(name, command) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Running: ${name}`);
  console.log("=".repeat(60));
  
  try {
    const output = execSync(command, {
      cwd: path.dirname(SCRIPT_DIR),
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120000, // 2 min per source
    });
    console.log(output);
    return true;
  } catch (e) {
    console.error(`Failed to run ${name}:`, e.stderr || e.message);
    return false;
  }
}

function main() {
  console.log("Graph Memory — Multi-Source Ingestion");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  if (gitOnly) {
    console.log("Scope: Git sources only");
  }
  console.log();

  let results = [];

  // Git commit ingestion
  results.push({
    name: "Git Commits",
    success: runSource(
      "Git Commit Ingestor",
      `node scripts/git-commit-ingestor.cjs${dryRun ? " --dry-run" : ""}`
    ),
  });

  // File modification tracking
  results.push({
    name: "File Modifications",
    success: runSource(
      "Git Status Ingestor",
      `node scripts/git-status-ingestor.cjs${dryRun ? " --dry-run" : ""}`
    ),
  });

  if (!gitOnly) {
    // Calendar events
    results.push({
      name: "Calendar Events",
      success: runSource(
        "Calendar Ingestor",
        `node scripts/calendar-ingestor.cjs${dryRun ? " --dry-run" : ""}`
      ),
    });

    // arXiv papers
    const arxivCmd = arxivKeyword
      ? `node scripts/arxiv-ingestor.cjs --keyword "${arxivKeyword}" --max ${arxivMax}${dryRun ? " --dry-run" : ""}`
      : `node scripts/arxiv-ingestor.cjs --keyword "loop quantum gravity" --max 5${dryRun ? " --dry-run" : ""}`;
    
    results.push({
      name: "arXiv Papers",
      success: runSource("arXiv Ingestor", arxivCmd),
    });
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log("=".repeat(60));
  
  let successCount = 0;
  let failCount = 0;
  
  for (const r of results) {
    const status = r.success ? "✓" : "✗";
    console.log(`  ${status} ${r.name}`);
    if (r.success) successCount++;
    else failCount++;
  }
  
  console.log(`\n${successCount}/${results.length} sources completed successfully.`);
  if (failCount > 0) {
    console.log(`${failCount} source(s) failed. Check logs above.`);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
/**
 * arxiv-ingestor.cjs
 * ─────────────────────────────────────────────
 * Fetches recent arXiv papers by author or keyword and inserts them
 * as research_paper entities in the graph database. Links papers to
 * authors (person entities) and topics.
 *
 * Entity types: research_paper, person, concept
 * Relationship types: authored, paper_about_topic
 *
 * Usage:
 *   node scripts/arxiv-ingestor.cjs --author "Sundance Bilson-Thompson"  # by author
 *   node scripts/arxiv-ingestor.cjs --keyword "loop quantum gravity"     # by keyword
 *   node scripts/arxiv-ingestor.cjs --keyword "quantum gravity" --max 10 # limit results
 *   node scripts/arxiv-ingestor.cjs --dry-run                              # print, don't write
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

/* ── Paths ───────────────────────────────────── */
const WORKSPACE_DIR = path.join(process.env.HOME, ".openclaw", "workspace");
const MEMORY_DIR = path.join(WORKSPACE_DIR, ".openclaw_memory");
const DB_PATH = path.join(MEMORY_DIR, "graph.db");

/* ── CLI args ────────────────────────────────── */
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

let author = null;
let keyword = null;
let maxResults = 20;

const authorIdx = args.indexOf("--author");
if (authorIdx !== -1 && args[authorIdx + 1]) {
  author = args[authorIdx + 1];
}
const keywordIdx = args.indexOf("--keyword");
if (keywordIdx !== -1 && args[keywordIdx + 1]) {
  keyword = args[keywordIdx + 1];
}
const maxIdx = args.indexOf("--max");
if (maxIdx !== -1 && args[maxIdx + 1]) {
  maxResults = parseInt(args[maxIdx + 1], 10);
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

/* ── arXiv API ───────────────────────────────── */
function fetchArxiv(query) {
  return new Promise((resolve, reject) => {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://export.arxiv.org/api/query?search_query=${encodedQuery}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
    
    console.log(`Fetching: ${url}`);
    
    https.get(url, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    }).on("error", (e) => reject(e));
  });
}

/* ── Lightweight Atom XML parser ─────────────── */
function parseAtomXml(xml) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryText = match[1];
    
    const entry = {
      id: extractTag(entryText, "id"),
      title: extractTag(entryText, "title"),
      summary: extractTag(entryText, "summary"),
      published: extractTag(entryText, "published"),
      updated: extractTag(entryText, "updated"),
      authors: extractAuthors(entryText),
      categories: extractCategories(entryText),
      link: extractLink(entryText),
      doi: extractTag(entryText, "arxiv:doi"),
    };
    
    entries.push(entry);
  }
  
  return entries;
}

function extractTag(text, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : "";
}

function extractAuthors(text) {
  const authors = [];
  const authorRegex = /<author>([\s\S]*?)<\/author>/g;
  let match;
  
  while ((match = authorRegex.exec(text)) !== null) {
    const name = extractTag(match[1], "name");
    if (name) authors.push(name);
  }
  
  return authors;
}

function extractCategories(text) {
  const categories = [];
  const catRegex = /<category term="([^"]+)"/g;
  let match;
  
  while ((match = catRegex.exec(text)) !== null) {
    categories.push(match[1]);
  }
  
  return categories;
}

function extractLink(text) {
  const linkRegex = /<link href="([^"]+)" rel="alternate"/;
  const match = text.match(linkRegex);
  return match ? match[1] : "";
}

function escapeName(str) {
  return str.replace(/[^a-zA-Z0-9_\-.@]/g, "_").substring(0, 100);
}

/* ── Main ────────────────────────────────────── */
async function main() {
  if (!author && !keyword) {
    console.log("Usage: node scripts/arxiv-ingestor.cjs --author <name> | --keyword <term> [--max <n>] [--dry-run]");
    process.exit(0);
  }

  const today = new Date().toISOString().split("T")[0];
  
  let query;
  if (author) {
    query = `au:"${author}"`;
  } else {
    query = `all:"${keyword}"`;
  }
  
  let xml;
  try {
    xml = await fetchArxiv(query);
  } catch (e) {
    console.error("Failed to fetch from arXiv:", e.message);
    process.exit(1);
  }
  
  const entries = parseAtomXml(xml);
  console.log(`Found ${entries.length} paper(s).`);
  
  if (entries.length === 0) {
    console.log("No papers found.");
    process.exit(0);
  }
  
  if (dryRun) {
    console.log("\n--- DRY RUN ---\n");
  }
  
  let paperCount = 0;
  let personCount = 0;
  let topicCount = 0;
  let relCount = 0;
  
  for (const entry of entries) {
    const arxivId = entry.id.replace(/.*\//, ""); // Extract arXiv ID from URL
    const paperId = `paper:${arxivId}`;
    const paperDesc = [
      entry.title,
      entry.published ? `Published: ${entry.published}` : "",
      entry.link ? `URL: ${entry.link}` : "",
      entry.summary ? entry.summary.substring(0, 300) : ""
    ].filter(Boolean).join(" | ");
    
    upsertEntity(paperId, entry.title, "research_paper", today, paperDesc);
    paperCount++;
    
    // Authors
    for (const authorName of entry.authors) {
      const authorId = `person:${escapeName(authorName)}`;
      upsertEntity(authorId, authorName, "person", today, `Author: ${entry.title}`);
      personCount++;
      upsertRelationship(paperId, authorId, "authored_by", entry.title, today);
      relCount++;
    }
    
    // Categories / topics
    for (const category of entry.categories) {
      const topicId = `topic:${escapeName(category)}`;
      upsertEntity(topicId, category, "concept", today, `arXiv category: ${category}`);
      topicCount++;
      upsertRelationship(paperId, topicId, "paper_about_topic", entry.title, today);
      relCount++;
    }
  }
  
  if (!dryRun) {
    console.log(`\nIngested ${paperCount} papers, ${personCount} authors, ${topicCount} topics, ${relCount} relationships.`);
  } else {
    console.log(`\n[DRY-RUN] Would ingest ${paperCount} papers, ${personCount} authors, ${topicCount} topics, ${relCount} relationships.`);
  }
  
  if (db && typeof db.close === "function") {
    db.close();
  }
}

main();

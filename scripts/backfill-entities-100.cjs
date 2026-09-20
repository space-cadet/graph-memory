#!/usr/bin/env node
/**
 * backfill-entities-100.cjs
 * One-shot maintenance script (cron): embed up to 100 entities where
 * embedding IS NULL, using node:sqlite only (no better-sqlite3).
 *
 * Text convention (verified against 5417 existing embeddings):
 *   - non-empty description -> embed description
 *   - otherwise             -> embed name
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = path.join(
  process.env.HOME,
  ".openclaw",
  "workspace",
  ".openclaw_memory",
  "graph.db"
);

const { batchEmbedding } = require(path.join(__dirname, "embeddings.cjs"));

const main = async () => {
  const db = new DatabaseSync(DB_PATH);

  const before = db
    .prepare("SELECT COUNT(*) AS c FROM entities WHERE embedding IS NULL")
    .get().c;
  console.log(`[backfill] entities with NULL embedding (before): ${before}`);

  if (before === 0) {
    console.log("[backfill] nothing to do");
    db.close();
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, name, description FROM entities
       WHERE embedding IS NULL
       ORDER BY id
       LIMIT 100`
    )
    .all();

  const texts = rows.map((r) =>
    r.description && r.description.trim().length > 0
      ? r.description.trim()
      : r.name.trim()
  );

  console.log(`[backfill] generating ${texts.length} embeddings...`);
  const t0 = Date.now();
  const embeddings = await batchEmbedding(texts);
  console.log(`[backfill] generated in ${Date.now() - t0}ms`);

  const upd = db.prepare("UPDATE entities SET embedding = ? WHERE id = ?");
  const writeT0 = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const buf = Buffer.from(embeddings[i].buffer, embeddings[i].byteOffset, embeddings[i].byteLength);
    upd.run(buf, rows[i].id);
  }
  console.log(`[backfill] wrote ${rows.length} embeddings in ${Date.now() - writeT0}ms`);

  const after = db
    .prepare("SELECT COUNT(*) AS c FROM entities WHERE embedding IS NULL")
    .get().c;
  const withEmb = db
    .prepare("SELECT COUNT(*) AS c FROM entities WHERE embedding IS NOT NULL")
    .get().c;
  console.log(
    `[backfill] entities with NULL embedding (after): ${after}; with embedding: ${withEmb}`
  );

  db.close();
};

main().catch((err) => {
  console.error(`[backfill] FAILED: ${err.stack || err.message}`);
  process.exit(1);
});

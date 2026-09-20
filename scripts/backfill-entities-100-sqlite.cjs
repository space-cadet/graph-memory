#!/usr/bin/env node
/**
 * backfill-entities-100-sqlite.cjs
 * Backfill embeddings for up to 100 entities where embedding IS NULL.
 * Uses Node 22 built-in node:sqlite + scripts/embeddings.cjs (Xenova local cache).
 */
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const { generateEmbedding } = require(path.join(__dirname, "embeddings.cjs"));

const DB_PATH = "/home/cloudy/.openclaw/workspace/.openclaw_memory/graph.db";
const EMBEDDING_BYTES = 384 * 4;

async function main() {
  const db = new DatabaseSync(DB_PATH);
  const before = db.prepare("SELECT COUNT(*) c FROM entities WHERE embedding IS NULL").get().c;

  const rows = db.prepare(
    "SELECT id, name, description FROM entities WHERE embedding IS NULL ORDER BY mention_count DESC LIMIT 100"
  ).all();

  console.log(`before: ${before} NULL embeddings; processing ${rows.length}`);

  const update = db.prepare("UPDATE entities SET embedding = ? WHERE id = ?");
  let done = 0, failed = 0;

  for (const row of rows) {
    const text = row.description ? `${row.name}: ${row.description}` : row.name;
    try {
      const emb = await generateEmbedding(text);
      if (!emb || emb.length !== 384) throw new Error(`bad dim ${emb && emb.length}`);
      const buf = Buffer.from(new Float32Array(emb).buffer);
      if (buf.length !== EMBEDDING_BYTES) throw new Error("bad byte length");
      update.run(buf, row.id);
      done++;
      if (done % 10 === 0) console.log(`  progress: ${done}/${rows.length}`);
    } catch (e) {
      failed++;
      console.error(`  FAIL id=${row.id} name=${row.name}: ${e.message}`);
    }
  }

  const after = db.prepare("SELECT COUNT(*) c FROM entities WHERE embedding IS NULL").get().c;
  db.close();
  console.log(`after: ${after} NULL embeddings | done=${done} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * backfill-node-sqlite.cjs
 * Backfill entity embeddings using node:sqlite + embeddings.cjs (MiniLM-L6-v2).
 * Updates up to N entities where embedding IS NULL. No external APIs.
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DB_PATH = "/home/cloudy/.openclaw/workspace/.openclaw_memory/graph.db";
const LIMIT = parseInt(process.argv[2] || "100", 10);

const { batchEmbedding } = require(path.join(__dirname, "embeddings.cjs"));

function toBuffer(vec) {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

async function main() {
  const db = new DatabaseSync(DB_PATH);
  const before = db.prepare("SELECT COUNT(*) c FROM entities WHERE embedding IS NOT NULL").get().c;

  const rows = db
    .prepare("SELECT id, name, canonical_name, description FROM entities WHERE embedding IS NULL LIMIT ?")
    .all(LIMIT);

  if (rows.length === 0) {
    console.log(JSON.stringify({ before, after: before, processed: 0, note: "nothing to do" }));
    db.close();
    return;
  }

  const texts = rows.map((r) => {
    const parts = [r.canonical_name || r.name];
    if (r.description) parts.push(r.description);
    return parts.join(" — ");
  });

  const embeddings = await batchEmbedding(texts);

  const update = db.prepare("UPDATE entities SET embedding = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (let i = 0; i < rows.length; i++) {
      const emb = embeddings[i];
      if (!emb || emb.length !== 384) {
        console.warn(`Skipping id=${rows[i].id} (bad embedding dim ${emb && emb.length})`);
        continue;
      }
      update.run(toBuffer(emb), rows[i].id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const after = db.prepare("SELECT COUNT(*) c FROM entities WHERE embedding IS NOT NULL").get().c;
  db.close();
  console.log(JSON.stringify({ before, after, processed: rows.length }));
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});

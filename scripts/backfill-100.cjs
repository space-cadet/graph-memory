#!/usr/bin/env node
/**
 * Backfill up to 100 entity embeddings using node:sqlite
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { batchEmbedding } = require("./embeddings.cjs");

const DB_PATH = "/home/cloudy/.openclaw/workspace/.openclaw_memory/graph.db";
const BATCH_SIZE = 32;
const MAX_ENTITIES = 100;

async function main() {
  const db = new DatabaseSync(DB_PATH);

  // Get counts before
  const beforeTotal = db.prepare("SELECT COUNT(*) as count FROM entities").get();
  const beforeWith = db.prepare("SELECT COUNT(*) as count FROM entities WHERE embedding IS NOT NULL").get();
  const beforeWithout = db.prepare("SELECT COUNT(*) as count FROM entities WHERE embedding IS NULL").get();

  console.log(`Before: ${beforeWith.count}/${beforeTotal.count} entities have embeddings (${beforeWithout.count} missing)`);

  if (beforeWithout.count === 0) {
    console.log("NO_REPLY");
    db.close();
    return;
  }

  // Get up to MAX_ENTITIES without embeddings
  const entities = db.prepare(
    "SELECT id, name, canonical_name, description FROM entities WHERE embedding IS NULL LIMIT ?"
  ).all(MAX_ENTITIES);

  console.log(`Processing ${entities.length} entities...`);

  const texts = entities.map(e => e.description || e.canonical_name || e.name);
  let processed = 0;
  const startTime = Date.now();

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batchTexts = texts.slice(i, i + BATCH_SIZE);
    const batchEntities = entities.slice(i, i + BATCH_SIZE);

    try {
      const embeddings = await batchEmbedding(batchTexts);
      const updateStmt = db.prepare("UPDATE entities SET embedding = ? WHERE id = ?");

      for (let j = 0; j < batchEntities.length; j++) {
        const buffer = Buffer.from(embeddings[j].buffer);
        updateStmt.run(buffer, batchEntities[j].id);
      }

      processed += batchEntities.length;
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      console.log(`  Progress: ${processed}/${entities.length} entities (${rate.toFixed(1)} items/s)`);
    } catch (e) {
      console.error(`  Batch failed at offset ${i}:`, e.message);
    }
  }

  // Get counts after
  const afterWith = db.prepare("SELECT COUNT(*) as count FROM entities WHERE embedding IS NOT NULL").get();
  const afterWithout = db.prepare("SELECT COUNT(*) as count FROM entities WHERE embedding IS NULL").get();

  console.log(`\nAfter: ${afterWith.count}/${beforeTotal.count} entities have embeddings (${afterWithout.count} remaining)`);
  console.log(`Backfilled ${afterWith.count - beforeWith.count} entities in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  db.close();
}

main().catch(err => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

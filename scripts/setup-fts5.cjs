const path = require("path");
const DB_PATH = path.join(process.env.HOME, ".openclaw", "workspace", ".openclaw_memory", "graph.db");
const Database = require("better-sqlite3");
const db = new Database(DB_PATH);

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
    name, 
    canonical_name, 
    description,
    content='entities',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS entities_fts_insert AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, name, canonical_name, description)
    VALUES (new.id, new.name, new.canonical_name, new.description);
  END;

  CREATE TRIGGER IF NOT EXISTS entities_fts_delete AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name, description)
    VALUES ('delete', old.id, old.name, old.canonical_name, old.description);
  END;

  CREATE TRIGGER IF NOT EXISTS entities_fts_update AFTER UPDATE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, name, canonical_name, description)
    VALUES ('delete', old.id, old.name, old.canonical_name, old.description);
    INSERT INTO entities_fts(rowid, name, canonical_name, description)
    VALUES (new.id, new.name, new.canonical_name, new.description);
  END;
`);

// Check if already backfilled
const count = db.prepare("SELECT COUNT(*) FROM entities_fts").pluck().get();
if (count === 0) {
  db.exec(`
    INSERT INTO entities_fts(rowid, name, canonical_name, description)
    SELECT id, name, canonical_name, description FROM entities;
  `);
  const newCount = db.prepare("SELECT COUNT(*) FROM entities_fts").pluck().get();
  console.log(`Backfilled ${newCount} entities into FTS5.`);
} else {
  console.log(`FTS5 already has ${count} rows. No backfill needed.`);
}

db.close();

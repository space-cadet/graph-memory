#!/usr/bin/env node

/**
 * Phase A Schema Initialization
 * Creates fresh memory_bank.db with Phase A schema for T21 workflow testing
 */

import * as sqlite from './lib/sqlite.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function initializeDatabase() {
  const dbPath = join(__dirname, 'memory_bank.db');
  const schemaPath = join(__dirname, 'schema.sql');

  try {
    console.log('\n🔄 Initializing Phase A Database...\n');

    // Create database
    await sqlite.initSqlJsModule();
    await sqlite.openDb(dbPath);
    console.log('✅ Database file created:', dbPath);

    // Read and execute schema as single block (preserve index statements)
    const schema = readFileSync(schemaPath, 'utf-8');
    await sqlite.exec(schema);

    // Verify schema
    console.log('\n✅ Schema verification:\n');

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    console.log(`  📊 Tables created: ${tables.length}`);
    tables.forEach(t => console.log(`    - ${t.name}`));

    const indexes = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all();
    console.log(`\n  🔑 Indexes created: ${indexes.length}`);
    indexes.forEach(idx => console.log(`    - ${idx.name}`));

    // Show table schemas
    console.log('\n📋 Table Schemas:\n');
    tables.forEach(t => {
      const schema = sqlite.prepare('PRAGMA table_info(' + t.name + ')').all();
      console.log(`  ${t.name}:`);
      schema.forEach(col => {
        const notNull = col.notnull ? ' NOT NULL' : '';
        const pk = col.pk ? ' PRIMARY KEY' : '';
        console.log(`    - ${col.name} (${col.type})${notNull}${pk}`);
      });
    });

    await sqlite.closeDb();

    console.log('\n✅ Phase A Database initialized successfully!\n');
    console.log('📁 Database location:', dbPath);
    console.log('📊 Total tables:', tables.length);
    console.log('🔑 Total indexes:', indexes.length);
    console.log('\nReady for Phase B: Insert Functions\n');

  } catch (error) {
    console.error('\n❌ Initialization failed:', error.message);
    process.exit(1);
  }
}

await initializeDatabase();

#!/usr/bin/env node
/**
 * Apply SQL migrations in ./migrations (sorted by filename).
 * Tracks applied files in schema_migrations so re-runs are safe.
 * Usage: npm run db:migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function main() {
  const dir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(dir)) {
    console.log('No migrations folder found.');
    process.exit(0);
  }

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('No migration files.');
    process.exit(0);
  }

  const client = await db.pool.connect();
  try {
    await ensureLedger(client);

    const applied = await client.query('SELECT filename FROM schema_migrations');
    const done = new Set(applied.rows.map((r) => r.filename));

    let appliedCount = 0;
    for (const file of files) {
      if (done.has(file)) {
        console.log(`Skip ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      console.log(`Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(`Done. Applied ${appliedCount} new migration(s); ${done.size + appliedCount} total tracked.`);
  } finally {
    client.release();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Apply SQL migrations in ./migrations (sorted by filename).
 * Usage: npm run db:migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

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

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`Applying ${file}...`);
    await db.query(sql);
  }

  const check = await db.query(
    "SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name = 'saaspayments'"
  );
  console.log(`Done. SaaSPayments columns: ${check.rows[0].n}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

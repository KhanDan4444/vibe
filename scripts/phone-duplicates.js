#!/usr/bin/env node
/**
 * List active members that share the same phone suffix within a gym.
 * Usage: npm run db:phone-duplicates
 */
require('dotenv').config();
const db = require('../config/db');

async function main() {
  const result = await db.query(
    `
    SELECT
      m.gym_id,
      g.name AS gym_name,
      RIGHT(REGEXP_REPLACE(m.phone, '[^0-9]', '', 'g'), 9) AS phone_suffix,
      COUNT(*)::int AS member_count,
      ARRAY_AGG(m.id ORDER BY m.id) AS member_ids,
      ARRAY_AGG(m.name ORDER BY m.id) AS member_names,
      ARRAY_AGG(COALESCE(m.phone, '') ORDER BY m.id) AS phones
    FROM Members m
    INNER JOIN Gyms g ON g.id = m.gym_id
    WHERE m.deleted_at IS NULL
      AND m.phone IS NOT NULL
      AND RIGHT(REGEXP_REPLACE(m.phone, '[^0-9]', '', 'g'), 9) <> ''
    GROUP BY m.gym_id, g.name, phone_suffix
    HAVING COUNT(*) > 1
    ORDER BY g.name, phone_suffix
    `
  );

  if (!result.rows.length) {
    console.log('No duplicate member phones found.');
    process.exit(0);
  }

  console.log(`Found ${result.rows.length} duplicate phone group(s):\n`);
  for (const row of result.rows) {
    console.log(`${row.gym_name} (gym ${row.gym_id}) — …${row.phone_suffix}`);
    row.member_ids.forEach((id, i) => {
      console.log(`  • #${id} ${row.member_names[i]} (${row.phones[i]})`);
    });
    console.log('');
  }

  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

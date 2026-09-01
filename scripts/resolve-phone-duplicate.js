#!/usr/bin/env node
/**
 * Resolve one duplicate phone group: keep one member, clear phone on the rest.
 *
 * Usage (dry-run is default):
 *   node scripts/resolve-phone-duplicate.js --gym-id=2 --keep-name=Abera --suffix=964349075
 *   node scripts/resolve-phone-duplicate.js --gym-id=2 --keep-name=Abera --suffix=964349075 --execute
 *
 * Options:
 *   --gym-id       Required. Gym id (Iron Fist = 2).
 *   --suffix       Required. Last 9 digits of the shared phone.
 *   --keep-name    Keeper matched with ILIKE %name% (use one of keep-name / keep-id).
 *   --keep-id      Keeper member id.
 *   --execute      Apply changes (otherwise preview only).
 *   --archive      Soft-delete duplicates instead of clearing phone.
 */
require('dotenv').config();
const db = require('../config/db');

function parseArgs(argv) {
  const opts = { execute: false, archive: false };
  for (const arg of argv) {
    if (arg === '--execute') opts.execute = true;
    else if (arg === '--archive') opts.archive = true;
    else if (arg.startsWith('--gym-id=')) opts.gymId = parseInt(arg.slice(9), 10);
    else if (arg.startsWith('--suffix=')) opts.suffix = String(arg.slice(9)).replace(/\D/g, '').slice(-9);
    else if (arg.startsWith('--keep-name=')) opts.keepName = arg.slice(12);
    else if (arg.startsWith('--keep-id=')) opts.keepId = parseInt(arg.slice(10), 10);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.gymId || !opts.suffix) {
    console.error('Required: --gym-id= and --suffix=');
    process.exit(1);
  }
  if (!opts.keepName && !opts.keepId) {
    console.error('Required: --keep-name= or --keep-id=');
    process.exit(1);
  }

  const groupResult = await db.query(
    `
    SELECT m.id, m.name, m.phone, m.telegram_chat_id, m.telegram_linked_at
    FROM Members m
    WHERE m.gym_id = $1
      AND m.deleted_at IS NULL
      AND m.phone IS NOT NULL
      AND RIGHT(REGEXP_REPLACE(m.phone, '[^0-9]', '', 'g'), 9) = $2
    ORDER BY m.id
    `,
    [opts.gymId, opts.suffix]
  );

  const group = groupResult.rows;
  if (!group.length) {
    console.log('No active members found for that gym + phone suffix.');
    process.exit(0);
  }

  let keeper;
  if (opts.keepId) {
    keeper = group.find((row) => row.id === opts.keepId);
    if (!keeper) {
      console.error(`Keeper id ${opts.keepId} is not in this duplicate group.`);
      process.exit(1);
    }
  } else {
    const matches = group.filter((row) =>
      row.name.toLowerCase().includes(opts.keepName.toLowerCase())
    );
    if (matches.length === 0) {
      console.error(`No member in group matches keep-name "${opts.keepName}".`);
      console.error('Members in group:');
      group.forEach((row) => console.error(`  #${row.id} ${row.name} (${row.phone})`));
      process.exit(1);
    }
    if (matches.length > 1) {
      console.error(`Multiple members match keep-name "${opts.keepName}". Use --keep-id= instead.`);
      matches.forEach((row) => console.error(`  #${row.id} ${row.name} (${row.phone})`));
      process.exit(1);
    }
    keeper = matches[0];
  }

  const others = group.filter((row) => row.id !== keeper.id);
  const action = opts.archive ? 'archive (soft-delete)' : 'clear phone';

  console.log(`Gym ${opts.gymId} — suffix …${opts.suffix}`);
  console.log(`Keeper: #${keeper.id} ${keeper.name} (${keeper.phone})`);
  if (keeper.telegram_chat_id) console.log(`  Telegram linked: yes`);
  console.log(`Will ${action} on ${others.length} other member(s):\n`);

  for (const row of others) {
    const tg = row.telegram_chat_id ? ' [telegram linked]' : '';
    console.log(`  • #${row.id} ${row.name} (${row.phone})${tg}`);
  }

  if (!opts.execute) {
    console.log('\nDry run only. Re-run with --execute to apply.');
    process.exit(0);
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of others) {
      if (opts.archive) {
        await client.query(
          `UPDATE Members SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1 AND gym_id = $2`,
          [row.id, opts.gymId]
        );
      } else {
        await client.query(`UPDATE Members SET phone = NULL WHERE id = $1 AND gym_id = $2`, [
          row.id,
          opts.gymId,
        ]);
      }
    }

    await client.query('COMMIT');
    console.log(`\nDone. Kept #${keeper.id} ${keeper.name}; updated ${others.length} member(s).`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

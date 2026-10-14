/**
 * Per-user read and dismissed notification ids.
 * Shared by the web and the phone so Mark all read clears both.
 */

const db = require('../config/db');

const MAX_STORED = 800;

function cleanIds(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = String(raw || '');
    if (!/^[a-z]{2,12}-\d{1,12}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(-MAX_STORED);
}

function emptyInbox() {
  return { readIds: [], dismissedIds: [] };
}

function fromRow(row) {
  if (!row) return emptyInbox();
  return {
    readIds: Array.isArray(row.read_ids) ? row.read_ids : [],
    dismissedIds: Array.isArray(row.dismissed_ids) ? row.dismissed_ids : [],
  };
}

async function loadNotificationInbox(userId) {
  try {
    const result = await db.query(
      `SELECT read_ids, dismissed_ids FROM NotificationInbox WHERE user_id = $1`,
      [userId]
    );
    return fromRow(result.rows[0]);
  } catch (err) {
    if (err.code === '42P01') return emptyInbox();
    throw err;
  }
}

async function mergeNotificationInbox(userId, { readIds = [], dismissedIds = [] } = {}) {
  const current = await loadNotificationInbox(userId);
  const next = {
    readIds: cleanIds([...current.readIds, ...readIds, ...dismissedIds]),
    dismissedIds: cleanIds([...current.dismissedIds, ...dismissedIds]),
  };

  try {
    await db.query(
      `
      INSERT INTO NotificationInbox (user_id, read_ids, dismissed_ids)
      VALUES ($1, $2::jsonb, $3::jsonb)
      ON CONFLICT (user_id) DO UPDATE
        SET read_ids = EXCLUDED.read_ids,
            dismissed_ids = EXCLUDED.dismissed_ids,
            updated_at = CURRENT_TIMESTAMP
      `,
      [userId, JSON.stringify(next.readIds), JSON.stringify(next.dismissedIds)]
    );
  } catch (err) {
    if (err.code === '42P01') return { ...next, stored: false };
    throw err;
  }

  return { ...next, stored: true };
}

module.exports = {
  loadNotificationInbox,
  mergeNotificationInbox,
};

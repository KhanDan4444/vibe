/**
 * @file routes/publicMemberPass.js
 * @description Unauthenticated member QR pass page payload (SMS link target).
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const db = require('../config/db');
const {
  verifyMemberPass,
  signMemberPass,
  normalizePassPublicCode,
} = require('../utils/memberPass');
const { memberPhotoToDataUrl } = require('../utils/memberPhotos');
const { publicMemberPassLimiter } = require('../middleware/rateLimiters');
const { isTelegramConfigured, botUsername } = require('../utils/telegramBot');
const { createLinkToken } = require('../utils/telegramLink');

async function loadMemberByPassCode(code) {
  const result = await db.query(
    `
    SELECT m.id, m.gym_id, m.name, m.phone, m.photo_url, m.pass_version, m.deleted_at, m.status,
           m.end_date, m.telegram_chat_id, m.telegram_linked_at, m.preferred_channel,
           g.name AS gym_name, b.name AS branch_name
    FROM Members m
    JOIN Gyms g ON g.id = m.gym_id
    LEFT JOIN Branches b ON b.id = m.branch_id
    WHERE m.pass_public_code = $1
    `,
    [code]
  );
  return result.rows[0] || null;
}

async function buildPassPayload(member, gymId) {
  const passVersion = Number(member.pass_version) || 1;
  const token = signMemberPass({
    gymId,
    memberId: member.id,
    passVersion,
  });
  const qr_data_url = await QRCode.toDataURL(token, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
    color: { dark: '#0f172a', light: '#ffffff' },
  });

  return {
    pass_version: passVersion,
    qr_data_url,
    gym_name: member.gym_name || null,
    telegram: {
      configured: isTelegramConfigured(),
      bot_username: botUsername() || null,
      linked: Boolean(member.telegram_chat_id),
      linked_at: member.telegram_linked_at || null,
    },
    member: {
      id: member.id,
      name: member.name,
      phone: member.phone,
      photo_data_url: memberPhotoToDataUrl(member.photo_url),
      branch_name: member.branch_name || null,
      status: member.status,
      end_date: member.end_date,
    },
  };
}

/**
 * GET /api/public/member-pass?code=  (preferred short SMS link)
 * GET /api/public/member-pass?token= (legacy JWT query links)
 */
router.get('/member-pass', publicMemberPassLimiter, async (req, res, next) => {
  try {
    const code = normalizePassPublicCode(req.query.code);
    const rawToken = String(req.query.token || '').trim();

    if (code) {
      if (code.length < 6 || code.length > 16) {
        return res.status(400).json({ error: 'Invalid pass link.', code: 'PASS_INVALID' });
      }

      const member = await loadMemberByPassCode(code);
      if (!member || member.deleted_at) {
        return res.status(404).json({
          error: 'This pass is no longer valid.',
          code: 'PASS_MEMBER_MISSING',
        });
      }

      return res.json(await buildPassPayload(member, member.gym_id));
    }

    if (!rawToken) {
      return res.status(400).json({ error: 'Pass link is missing.', code: 'PASS_MISSING' });
    }

    const verified = verifyMemberPass(rawToken);
    if (!verified.ok) {
      return res.status(400).json({ error: verified.error, code: verified.code });
    }

    const result = await db.query(
      `
      SELECT m.id, m.name, m.phone, m.photo_url, m.pass_version, m.deleted_at, m.status,
             m.end_date, m.telegram_chat_id, m.telegram_linked_at, m.preferred_channel,
             g.name AS gym_name, b.name AS branch_name
      FROM Members m
      JOIN Gyms g ON g.id = m.gym_id
      LEFT JOIN Branches b ON b.id = m.branch_id
      WHERE m.id = $1 AND m.gym_id = $2
      `,
      [verified.memberId, verified.gymId]
    );
    const member = result.rows[0];
    if (!member || member.deleted_at) {
      return res.status(404).json({
        error: 'This pass is no longer valid.',
        code: 'PASS_MEMBER_MISSING',
      });
    }
    if (Number(member.pass_version) !== Number(verified.passVersion)) {
      return res.status(400).json({
        error: 'This pass was replaced. Ask the desk for a new link.',
        code: 'PASS_STALE',
      });
    }

    res.json(await buildPassPayload(member, verified.gymId));
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/public/member-pass/telegram-link?code=
 * Member self-service: create a one-time Telegram deep link from their pass page.
 */
router.post('/member-pass/telegram-link', publicMemberPassLimiter, async (req, res, next) => {
  try {
    if (!isTelegramConfigured()) {
      return res.status(503).json({ error: 'Telegram is not configured on this server.' });
    }

    const code = normalizePassPublicCode(req.query.code || req.body?.code);
    if (!code || code.length < 6 || code.length > 16) {
      return res.status(400).json({ error: 'Invalid pass link.', code: 'PASS_INVALID' });
    }

    const member = await loadMemberByPassCode(code);
    if (!member || member.deleted_at) {
      return res.status(404).json({
        error: 'This pass is no longer valid.',
        code: 'PASS_MEMBER_MISSING',
      });
    }

    if (member.telegram_chat_id) {
      return res.json({
        ok: true,
        already_linked: true,
        linked_at: member.telegram_linked_at,
        bot_username: botUsername() || null,
      });
    }

    const link = await createLinkToken(member.id);
    if (!link.link) {
      return res.status(503).json({ error: 'Telegram bot username is not configured on this server.' });
    }

    res.json({
      ok: true,
      link: link.link,
      token: link.token,
      expires_at: link.expires_at,
      expires_in_seconds: link.expires_in_seconds,
      bot_username: botUsername() || null,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

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

      const result = await db.query(
        `
        SELECT m.id, m.gym_id, m.name, m.phone, m.photo_url, m.pass_version, m.deleted_at, m.status,
               m.end_date, g.name AS gym_name, b.name AS branch_name
        FROM Members m
        JOIN Gyms g ON g.id = m.gym_id
        LEFT JOIN Branches b ON b.id = m.branch_id
        WHERE m.pass_public_code = $1
        `,
        [code]
      );
      const member = result.rows[0];
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
             m.end_date, g.name AS gym_name, b.name AS branch_name
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

module.exports = router;

/**
 * @file routes/publicMemberPass.js
 * @description Unauthenticated member QR pass page payload (SMS link target).
 */

const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const db = require('../config/db');
const { verifyMemberPass, signMemberPass } = require('../utils/memberPass');
const { memberPhotoToDataUrl } = require('../utils/memberPhotos');
const { publicMemberPassLimiter } = require('../middleware/rateLimiters');

/**
 * GET /api/public/member-pass?token=
 * Returns current QR + display fields if the token signature and pass_version are valid.
 */
router.get('/member-pass', publicMemberPassLimiter, async (req, res, next) => {
  try {
    const rawToken = String(req.query.token || '').trim();
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

    const passVersion = Number(member.pass_version) || 1;
    const token = signMemberPass({
      gymId: verified.gymId,
      memberId: member.id,
      passVersion,
    });
    const qr_data_url = await QRCode.toDataURL(token, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#0f172a', light: '#ffffff' },
    });

    res.json({
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
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

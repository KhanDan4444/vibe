/**
 * @file memberPhotos.js
 * @description Save and serve gym member profile photos on disk.
 */

const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads', 'members');
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

function memberPhotoDir(gymId) {
  return path.join(UPLOADS_ROOT, String(gymId));
}

function memberPhotoFilePath(gymId, memberId, ext) {
  return path.join(memberPhotoDir(gymId), `${memberId}${ext}`);
}

function parsePhotoDataUrl(dataUrl) {
  if (!dataUrl) return { ok: true };
  if (typeof dataUrl !== 'string') {
    return { ok: false, error: 'Photo must be an image file.' };
  }

  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) {
    return { ok: false, error: 'Photo must be a JPEG, PNG, or WebP image.' };
  }

  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, error: 'Photo must be a JPEG, PNG, or WebP image.' };
  }

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) {
    return { ok: false, error: 'Photo file is empty.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: 'Photo must be 2 MB or smaller.' };
  }

  return { ok: true, mime, buffer, ext: EXT_BY_MIME[mime] };
}

async function saveMemberPhoto(gymId, memberId, dataUrl) {
  const parsed = parsePhotoDataUrl(dataUrl);
  if (!parsed.ok) return parsed;
  if (!parsed.buffer) return { ok: true, photoUrl: null };

  const dir = memberPhotoDir(gymId);
  await fs.promises.mkdir(dir, { recursive: true });
  await removeMemberPhotoFiles(gymId, memberId);

  const filePath = memberPhotoFilePath(gymId, memberId, parsed.ext);
  await fs.promises.writeFile(filePath, parsed.buffer);

  const photoUrl = `members/${gymId}/${memberId}${parsed.ext}`;
  return { ok: true, photoUrl, filePath, mime: parsed.mime };
}

async function removeMemberPhotoFiles(gymId, memberId) {
  const dir = memberPhotoDir(gymId);
  for (const ext of Object.values(EXT_BY_MIME)) {
    const filePath = memberPhotoFilePath(gymId, memberId, ext);
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function resolveMemberPhotoOnDisk(photoUrl) {
  if (!photoUrl) return null;
  const normalized = String(photoUrl).replace(/^\/+/, '');
  if (!normalized.startsWith('members/')) return null;

  const absolute = path.resolve(UPLOADS_ROOT, '..', normalized);
  const uploadsRoot = path.resolve(UPLOADS_ROOT, '..');
  if (!absolute.startsWith(uploadsRoot + path.sep)) return null;

  if (!fs.existsSync(absolute)) return null;
  const ext = path.extname(absolute).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { absolute, mime };
}

module.exports = {
  parsePhotoDataUrl,
  saveMemberPhoto,
  removeMemberPhotoFiles,
  resolveMemberPhotoOnDisk,
};

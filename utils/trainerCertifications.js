/**
 * @file trainerCertifications.js
 * @description Save and serve optional trainer certification files on disk.
 */

const fs = require('fs');
const path = require('path');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads', 'trainers');
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

function trainerCertDir(gymId) {
  return path.join(UPLOADS_ROOT, String(gymId));
}

function trainerCertFilePath(gymId, trainerId, ext) {
  return path.join(trainerCertDir(gymId), `${trainerId}${ext}`);
}

function parseCertificationDataUrl(dataUrl) {
  if (!dataUrl) return { ok: true };
  if (typeof dataUrl !== 'string') {
    return { ok: false, error: 'Certification must be a PDF or image file.' };
  }

  const match =
    /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
      dataUrl.trim()
    );
  if (!match) {
    return { ok: false, error: 'Certification must be a JPEG, PNG, WebP, or PDF file.' };
  }

  const mime = match[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, error: 'Certification must be a JPEG, PNG, WebP, or PDF file.' };
  }

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) {
    return { ok: false, error: 'Certification file is empty.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, error: 'Certification must be 2 MB or smaller.' };
  }

  return { ok: true, mime, buffer, ext: EXT_BY_MIME[mime] };
}

async function saveTrainerCertification(gymId, trainerId, dataUrl) {
  const parsed = parseCertificationDataUrl(dataUrl);
  if (!parsed.ok) return parsed;
  if (!parsed.buffer) return { ok: true, certificationUrl: null };

  const dir = trainerCertDir(gymId);
  await fs.promises.mkdir(dir, { recursive: true });
  await removeTrainerCertificationFiles(gymId, trainerId);

  const filePath = trainerCertFilePath(gymId, trainerId, parsed.ext);
  await fs.promises.writeFile(filePath, parsed.buffer);

  const certificationUrl = `trainers/${gymId}/${trainerId}${parsed.ext}`;
  return { ok: true, certificationUrl, filePath, mime: parsed.mime };
}

async function removeTrainerCertificationFiles(gymId, trainerId) {
  const dir = trainerCertDir(gymId);
  for (const ext of Object.values(EXT_BY_MIME)) {
    const filePath = trainerCertFilePath(gymId, trainerId, ext);
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function resolveTrainerCertificationOnDisk(certificationUrl) {
  if (!certificationUrl) return null;
  const normalized = String(certificationUrl).replace(/^\/+/, '');
  if (!normalized.startsWith('trainers/')) return null;

  const absolute = path.resolve(UPLOADS_ROOT, '..', normalized);
  const uploadsRoot = path.resolve(UPLOADS_ROOT, '..');
  if (!absolute.startsWith(uploadsRoot + path.sep)) return null;

  if (!fs.existsSync(absolute)) return null;
  const ext = path.extname(absolute).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.pdf'
          ? 'application/pdf'
          : 'image/jpeg';
  return { absolute, mime };
}

module.exports = {
  parseCertificationDataUrl,
  saveTrainerCertification,
  removeTrainerCertificationFiles,
  resolveTrainerCertificationOnDisk,
};

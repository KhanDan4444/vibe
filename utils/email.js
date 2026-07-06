/**
 * @file email.js
 * @description SMTP email delivery with console fallback when SMTP is not configured.
 */

const nodemailer = require('nodemailer');

let transporter = null;

function isEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
}

function getTransporter() {
  if (!isEmailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === '1',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS || '',
      },
    });
  }
  return transporter;
}

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} options
 */
async function sendEmail({ to, subject, text, html }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@vibesaas.local';

  const safeText = text.replace(/token=[a-f0-9]+/gi, 'token=[REDACTED]');

  if (!isEmailConfigured()) {
    console.log(`[Email] (SMTP not configured — logging only)\nTo: ${to}\nSubject: ${subject}\n---\n${safeText}\n---`);
    return { delivered: false, logged: true };
  }

  const transport = getTransporter();
  await transport.sendMail({
    from,
    to,
    subject,
    text,
    html: html || text.replace(/\n/g, '<br>'),
  });
  return { delivered: true };
}

module.exports = { sendEmail, isEmailConfigured };

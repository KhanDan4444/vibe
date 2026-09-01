/**
 * @file telegramMemberBot.js
 * @description Member-facing Telegram bot commands and lookups.
 */

const db = require('../config/db');
const { formatDisplayDateFromIso, todayLocalString, calendarDateString } = require('./localDate');
const { sendMessage, botUsername } = require('./telegramBot');
const { membershipPlanTypeLabel, memberFirstName } = require('./notificationSms');

const NOT_LINKED =
  'This Telegram account is not linked to a membership yet. Ask your gym for a link QR code.';

async function getLinkedMemberByChatId(chatId) {
  const normalizedChatId = Number(chatId);
  if (!Number.isFinite(normalizedChatId)) return null;

  const result = await db.query(
    `
    SELECT m.id, m.name, m.phone, m.end_date, m.status, m.pass_version, m.telegram_chat_id,
           g.id AS gym_id, g.name AS gym_name,
           p.name AS plan_name, p.duration AS plan_duration
    FROM Members m
    INNER JOIN Gyms g ON g.id = m.gym_id
    LEFT JOIN Plans p ON p.id = m.plan_id
    WHERE m.telegram_chat_id = $1 AND m.deleted_at IS NULL
    LIMIT 1
    `,
    [normalizedChatId]
  );

  return result.rows[0] || null;
}

function membershipStatusLabel(member) {
  const status = String(member?.status || 'active').toLowerCase();
  if (status === 'expired') return 'Expired';
  const endIso = calendarDateString(member?.end_date);
  const today = todayLocalString();
  if (endIso && endIso < today) return 'Expired';
  if (status === 'due soon') return 'Due soon';
  return 'Active';
}

function buildHelpMessage({ linked = false } = {}) {
  const username = botUsername();
  const botLine = username ? `@${username}` : 'this bot';

  const lines = [
    `Help — ${botLine}`,
    '',
    linked
      ? 'You receive check-in pass links and renewal reminders here.'
      : 'Link your membership at the gym to receive check-in pass links and renewal reminders.',
    '',
    'Commands:',
    '/pass — resend your check-in pass',
    '/status — membership details',
    '/help — show this message',
    '',
    'For billing, renewals, or account changes, contact your gym.',
  ];
  return lines.join('\n');
}

function buildUnknownMessage() {
  return [
    "I didn't understand that message.",
    '',
    'Try /pass for your check-in pass, /status for membership details, or /help for all commands.',
    '',
    'For billing or renewals, contact your gym.',
  ].join('\n');
}

function buildBareStartMessage() {
  const hint = 'Open the personal link from your gym or scan their QR code.';
  return [
    'Welcome!',
    '',
    hint,
    '',
    'After linking you will receive check-in pass links and renewal reminders here.',
    '',
    'Type /help to see available commands.',
  ].join('\n');
}

async function sendMemberStatus(chatId, member) {
  const firstName = memberFirstName(member.name);
  const planType = membershipPlanTypeLabel(member.plan_name, member.plan_duration);
  const endDisplay = formatDisplayDateFromIso(member.end_date) || '—';
  const status = membershipStatusLabel(member);

  const message = [
    `Hi ${firstName},`,
    '',
    `Gym: ${member.gym_name}`,
    `Plan: ${planType}`,
    `Status: ${status}`,
    `Valid until: ${endDisplay}`,
    '',
    'Use /pass for your check-in pass.',
  ].join('\n');

  await sendMessage(chatId, message);
}

function parseBotCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head.slice(1).split('@')[0].toLowerCase();
  if (!command) return null;
  return { command, args: rest.join(' ').trim() };
}

module.exports = {
  NOT_LINKED,
  getLinkedMemberByChatId,
  buildHelpMessage,
  buildUnknownMessage,
  buildBareStartMessage,
  sendMemberStatus,
  membershipStatusLabel,
  parseBotCommand,
};

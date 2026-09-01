/**
 * @file telegramBot.js
 * @description Telegram Bot API client for member notifications.
 * @see https://core.telegram.org/bots/api
 */

const BASE_URL = 'https://api.telegram.org';

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
}

function isTelegramConfigured() {
  return Boolean(botToken());
}

function botUsername() {
  return process.env.TELEGRAM_BOT_USERNAME?.trim() || '';
}

function apiUrl(method) {
  return `${BASE_URL}/bot${botToken()}/${method}`;
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} body
 */
async function callTelegramApi(method, body) {
  const token = botToken();
  if (!token) {
    console.log(`[Telegram] (not configured — logging only)\nMethod: ${method}\n---\n${JSON.stringify(body)}\n---`);
    return { ok: true, result: { message_id: `dev-${Date.now()}` } };
  }

  const res = await fetch(apiUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    const err = new Error(`Invalid response from Telegram (HTTP ${res.status}).`);
    err.statusCode = 502;
    throw err;
  }

  if (!payload?.ok) {
    const description = payload?.description || `Telegram API error (HTTP ${res.status}).`;
    const err = new Error(description);
    err.statusCode = res.status >= 400 && res.status < 500 ? 400 : 502;
    err.telegram = payload;
    throw err;
  }

  return payload;
}

/**
 * @param {number|string} chatId
 * @param {string} text
 * @param {{ reply_markup?: object, parse_mode?: string, disable_web_page_preview?: boolean }} [options]
 */
async function sendMessage(chatId, text, options = {}) {
  const message = String(text || '').trim();
  if (!message) {
    const err = new Error('Telegram message is empty.');
    err.statusCode = 400;
    throw err;
  }

  const body = {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: options.disable_web_page_preview ?? false,
  };
  if (options.reply_markup) body.reply_markup = options.reply_markup;
  if (options.parse_mode) body.parse_mode = options.parse_mode;

  const payload = await callTelegramApi('sendMessage', body);

  return {
    message_id: payload.result?.message_id != null ? String(payload.result.message_id) : null,
    chat_id: String(chatId),
  };
}

function passOpenKeyboard(passUrl) {
  const url = String(passUrl || '').trim();
  if (!url) return null;
  return {
    inline_keyboard: [[{ text: 'Open check-in pass', url }]],
  };
}

const BOT_COMMANDS = [
  { command: 'start', description: 'Link membership (use gym QR link)' },
  { command: 'pass', description: 'Resend check-in pass' },
  { command: 'status', description: 'Membership details' },
  { command: 'help', description: 'How to use this bot' },
];

async function setMyCommands() {
  if (!isTelegramConfigured()) return { ok: false, skipped: true };
  await callTelegramApi('setMyCommands', { commands: BOT_COMMANDS });
  return { ok: true };
}

/**
 * Register webhook when TELEGRAM_WEBHOOK_URL is set (HTTPS required in production).
 */
async function ensureWebhookRegistered() {
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL?.trim();
  if (!webhookUrl || !isTelegramConfigured()) return { ok: false, skipped: true };

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  const body = { url: webhookUrl, allowed_updates: ['message'] };
  if (secret) body.secret_token = secret;

  await callTelegramApi('setWebhook', body);
  await setMyCommands();
  return { ok: true, url: webhookUrl };
}

module.exports = {
  isTelegramConfigured,
  botUsername,
  sendMessage,
  passOpenKeyboard,
  setMyCommands,
  ensureWebhookRegistered,
};

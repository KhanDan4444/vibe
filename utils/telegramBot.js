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
 */
async function sendMessage(chatId, text) {
  const message = String(text || '').trim();
  if (!message) {
    const err = new Error('Telegram message is empty.');
    err.statusCode = 400;
    throw err;
  }

  const payload = await callTelegramApi('sendMessage', {
    chat_id: chatId,
    text: message,
    disable_web_page_preview: false,
  });

  return {
    message_id: payload.result?.message_id != null ? String(payload.result.message_id) : null,
    chat_id: String(chatId),
  };
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
  return { ok: true, url: webhookUrl };
}

module.exports = {
  isTelegramConfigured,
  botUsername,
  sendMessage,
  ensureWebhookRegistered,
};

/**
 * @file routes/telegram.js
 * @description Telegram Bot API webhook for member linking.
 */

const express = require('express');
const router = express.Router();
const { sendMessage, isTelegramConfigured, botUsername } = require('../utils/telegramBot');
const { consumeLinkToken, unlinkTelegramChat } = require('../utils/telegramLink');

function verifyWebhookSecret(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  const received = req.get('X-Telegram-Bot-Api-Secret-Token');
  return received === expected;
}

function linkErrorMessage(code) {
  switch (code) {
    case 'token_not_found':
      return 'That link code is invalid. Ask your gym for a new Telegram link.';
    case 'token_used':
      return 'That link was already used. Ask your gym for a new Telegram link.';
    case 'token_expired':
      return 'That link expired. Ask your gym for a new Telegram link.';
    case 'chat_already_linked':
      return 'This Telegram account is already linked to another member profile.';
    default:
      return 'Could not link your account. Ask your gym for a new Telegram link.';
  }
}

/**
 * POST /api/telegram/webhook
 * Telegram Bot API update handler.
 */
router.post('/webhook', async (req, res, next) => {
  try {
    if (!verifyWebhookSecret(req)) {
      return res.status(401).json({ error: 'Invalid webhook secret.' });
    }

    const message = req.body?.message;
    if (!message?.chat?.id || typeof message.text !== 'string') {
      return res.json({ ok: true });
    }

    const chatId = message.chat.id;
    const text = message.text.trim();

    if (text.startsWith('/start')) {
      const token = text.split(/\s+/)[1]?.trim();
      if (!token) {
        const username = botUsername();
        const hint = username
          ? `Open the link from your gym or visit t.me/${username} with your personal link code.`
          : 'Open the Telegram link from your gym to connect your membership.';
        await sendMessage(
          chatId,
          `Welcome! ${hint} Once linked, pass links and renewal reminders arrive here.`
        );
        return res.json({ ok: true });
      }

      const result = await consumeLinkToken(token, chatId);
      if (result.ok) {
        await sendMessage(
          chatId,
          `Linked to ${result.gymName}.\nHi ${result.memberName}, you'll get pass links and renewal reminders here.\nSend /stop anytime to unlink.`
        );
      } else {
        await sendMessage(chatId, linkErrorMessage(result.error));
      }
      return res.json({ ok: true });
    }

    if (text === '/stop') {
      const result = await unlinkTelegramChat(chatId);
      if (result.ok) {
        await sendMessage(
          chatId,
          `Unlinked from ${result.member.name}. Link again from your gym to receive messages on Telegram.`
        );
      } else {
        await sendMessage(chatId, 'This Telegram account is not linked to a membership.');
      }
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/telegram/status
 * Lightweight config probe for ops (no secrets).
 */
router.get('/status', (req, res) => {
  res.json({
    configured: isTelegramConfigured(),
    bot_username: botUsername() || null,
  });
});

module.exports = router;

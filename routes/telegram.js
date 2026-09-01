/**
 * @file routes/telegram.js
 * @description Telegram Bot API webhook for member linking.
 */

const express = require('express');
const router = express.Router();
const { sendMessage, isTelegramConfigured, botUsername } = require('../utils/telegramBot');
const { consumeLinkToken, unlinkTelegramChat } = require('../utils/telegramLink');
const { buildPublicPassUrl } = require('../utils/memberPass');
const { sendTelegramLinkWelcome, smsMemberPassLink } = require('../utils/notificationSms');
const {
  NOT_LINKED,
  getLinkedMemberByChatId,
  buildHelpMessage,
  buildUnknownMessage,
  buildBareStartMessage,
  sendMemberStatus,
  parseBotCommand,
} = require('../utils/telegramMemberBot');

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

async function handlePassCommand(chatId) {
  const member = await getLinkedMemberByChatId(chatId);
  if (!member) {
    await sendMessage(chatId, NOT_LINKED);
    return;
  }

  const passUrl = await buildPublicPassUrl({ memberId: member.id });
  if (!passUrl) {
    await sendMessage(chatId, 'Check-in pass links are not available right now. Please contact your gym.');
    return;
  }

  const result = await smsMemberPassLink(
    {
      id: member.id,
      name: member.name,
      phone: member.phone,
      telegram_chat_id: chatId,
    },
    member.gym_name || 'your gym',
    passUrl
  );

  if (!result?.ok && result?.error !== 'already_sent_today') {
    await sendMessage(chatId, 'Could not send your check-in pass. Please try again or contact your gym.');
  }
}

async function handleStatusCommand(chatId) {
  const member = await getLinkedMemberByChatId(chatId);
  if (!member) {
    await sendMessage(chatId, NOT_LINKED);
    return;
  }
  await sendMemberStatus(chatId, member);
}

async function handleHelpCommand(chatId) {
  const member = await getLinkedMemberByChatId(chatId);
  await sendMessage(chatId, buildHelpMessage({ linked: Boolean(member) }));
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
    const parsed = parseBotCommand(text);

    if (parsed?.command === 'start') {
      const token = parsed.args || text.split(/\s+/)[1]?.trim();
      if (!token) {
        await sendMessage(chatId, buildBareStartMessage());
        return res.json({ ok: true });
      }

      const result = await consumeLinkToken(token, chatId);
      if (result.ok) {
        const passUrl = await buildPublicPassUrl({ memberId: result.memberId });
        await sendTelegramLinkWelcome(
          {
            id: result.memberId,
            name: result.memberName,
            telegram_chat_id: chatId,
          },
          result.gymName,
          {
            planName: result.planName,
            planDuration: result.planDuration,
            endDate: result.endDate,
          },
          passUrl
        );
      } else {
        await sendMessage(chatId, linkErrorMessage(result.error));
      }
      return res.json({ ok: true });
    }

    if (parsed?.command === 'pass') {
      await handlePassCommand(chatId);
      return res.json({ ok: true });
    }

    if (parsed?.command === 'status') {
      await handleStatusCommand(chatId);
      return res.json({ ok: true });
    }

    if (parsed?.command === 'help') {
      await handleHelpCommand(chatId);
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

    if (text.startsWith('/')) {
      await sendMessage(chatId, buildUnknownMessage());
      return res.json({ ok: true });
    }

    await sendMessage(chatId, buildUnknownMessage());
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

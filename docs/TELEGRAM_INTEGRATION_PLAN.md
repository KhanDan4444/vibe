# Telegram integration plan

**Status:** Phase 4 complete (UI). Phase 5 optional / later.  
**Repos:** `/home/daniel/vibe` (backend first), then `vibe-frontend` + `vibe-mobile` (thin UI).

---

## Goal

Add **Telegram** as a member notification channel alongside SMS. Telegram handles pass links and expiry reminders reliably (URLs OK, free, scalable). **SMS stays** for OTP, non-Telegram members, and Afro when licensed.

---

## Why now

| Phone gateway (hahu) | Telegram |
|---------------------|----------|
| One SIM, rate limits | Unlimited linked members |
| URLs flagged as spam | Links work fine |
| Weak audit trail | Logged like SMS today |

**After Afro SMS is approved:** keep both — Telegram for opt-in members, Afro for SMS fallback + owner OTP.

---

## What stays SMS-only (for now)

- Owner gym signup OTP
- Owner forgot-password OTP
- Members who never link Telegram

---

## How member links & how `chat_id` is received

### Concepts

- Every Telegram user has a numeric **`chat_id`** (e.g. `4829103847`).
- Bot **cannot** message someone until they **start the bot** once.
- You **never** ask the member for their chat_id — Telegram sends it in the webhook.

### Link flow (first interaction)

1. **Backend** creates a short-lived token tied to `member_id` (e.g. `K7M2XP`, 15 min TTL, single-use).
2. **Show deep link** on pass page / staff desk / optional SMS:
   ```
   https://t.me/NikuGymBot?start=K7M2XP
   ```
3. **Member taps Start** → Telegram sends to your webhook:
   ```json
   {
     "message": {
       "chat": { "id": 4829103847 },
       "text": "/start K7M2XP"
     }
   }
   ```
4. **Webhook handler:**
   - Resolve token → `member_id`
   - Save `members.telegram_chat_id = 4829103847`
   - Set `preferred_channel = 'telegram'` (or `'both'`)
   - Mark token used
   - Reply: *"Linked to {gym name}. You'll get pass links and reminders here."*

5. **Later outbound:** `sendMessage(chat_id, text)` for pass links, expiry reminders, etc.

### Optional bot commands (Phase 4+)

| Command | Action |
|---------|--------|
| `/pass` | Resend pass link |
| `/status` | Show membership end date |
| `/stop` | Unlink; clear `telegram_chat_id`; fall back to SMS |

---

## Architecture

```
Triggers (cron, enroll, renew, pass resend)
        ↓
deliverMessage({ channel, to, body, type, entity })
        ↓
resolveChannel(member) → telegram | sms
        ↓
telegramBot.sendMessage(chat_id)  OR  smsProvider (Afro/hahu)
        ↓
MessageLog / SmsLog (channel column)
```

---

## Phase 1 — Bot + backend foundation

**Estimate:** 1–2 days

### Tasks

- [x] Create bot via [@BotFather](https://t.me/BotFather) → `TELEGRAM_BOT_TOKEN`
- [x] Add `utils/telegramBot.js` — `sendMessage(chatId, text)`, error handling
- [x] Add `routes/telegram.js` — `POST /api/telegram/webhook` (verify secret header)
- [x] Parse `/start <token>` and `/stop` in webhook handler
- [x] Refactor `utils/notificationSms.js`:
  - New `deliverMessage({ channel, to, body, messageType, ... })`
  - Keep `deliverSms()` as thin wrapper → `channel: 'sms'`
- [x] Extend logging: add `channel` to `SmsLog` **or** new `MessageLog` table
- [x] Migration `023_telegram.sql` + link-token endpoint for staff testing

### Env vars (`.env.example`)

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=NikuGymBot
TELEGRAM_WEBHOOK_SECRET=   # random string; validate on webhook POST
```

### Files to touch

| File | Change |
|------|--------|
| `utils/telegramBot.js` | **New** — Bot API client |
| `routes/telegram.js` | **New** — webhook |
| `utils/notificationSms.js` | Refactor → `deliverMessage` |
| `migrations/0xx_telegram.sql` | Schema (see below) |
| `server.js` or router index | Mount telegram routes |
| `.env.example` | Telegram vars |

---

## Phase 2 — Linking & data model

**Estimate:** 1 day

### Migration

```sql
-- members
ALTER TABLE members ADD COLUMN telegram_chat_id BIGINT;
ALTER TABLE members ADD COLUMN telegram_linked_at TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN preferred_channel TEXT DEFAULT 'sms';
  -- 'sms' | 'telegram' | 'both'

-- link tokens (single-use)
CREATE TABLE telegram_link_tokens (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- message log (if not extending SmsLog)
ALTER TABLE sms_log ADD COLUMN channel TEXT DEFAULT 'sms';
ALTER TABLE sms_log ADD COLUMN recipient_address TEXT; -- phone or chat_id as string
```

### API endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| `POST` | `/api/telegram/webhook` | Telegram | Inbound updates |
| `POST` | `/api/members/:id/telegram/link-token` | Staff | Generate link for desk/pass |
| `GET` | `/api/public/telegram/link/:token` | Public | Optional redirect → t.me bot |

### Link token rules

- 6–8 char alphanumeric, crypto-random
- TTL: 15 minutes
- Single-use
- One active token per member (invalidate old on new)

---

## Phase 3 — Route real messages

**Estimate:** 1 day

### Message types — MVP

| Type | Telegram | SMS fallback |
|------|----------|--------------|
| `member_pass_link` | ✅ Primary if linked | ✅ |
| `member_due_soon` | ✅ | ✅ |
| `member_expires_today` | ✅ | ✅ |
| `member_expired` | ✅ | ✅ |
| `member_enrolled` | Optional | ✅ default |
| `member_renewed` | Optional | ✅ default |

### Channel resolution

```js
function resolveChannel(member) {
  if (member.telegram_chat_id && member.preferred_channel !== 'sms') {
    return 'telegram';
  }
  return 'sms';
}
```

### Note on pass URLs

- SMS enroll/renew **omit URLs** today (spam filters).
- Telegram messages **can include pass URL** — good reason for members to link.

### Cron

- No scheduler changes — only swap `deliverSms` → `deliverMessage` inside existing send helpers in `jobs/expiryCheck.js` and member routes.

---

## Phase 4 — UI (web + mobile)

**Estimate:** 1–2 days

### Backend

- [x] `GET /api/gym/member-sms` → return `channel`; filter `?channel=telegram|sms`
- [x] Member detail API includes `telegram_linked_at`, `preferred_channel`

### Web (`vibe-frontend`)

- [x] Rename nav/i18n: "Member SMS" → **"Messages"**
- [x] `MemberMessages.jsx` — channel badge per row
- [x] Member drawer / pass modal — **"Link Telegram"** button (copy link + QR optional)
- [x] `src/utils/smsLogLabels.js` — add channel labels

### Mobile (`vibe-mobile`)

- [x] `app/messages.tsx` — channel badge
- [x] `MemberPassSheet` — "Get reminders on Telegram" CTA
- [x] `src/utils/smsLabels.ts` — channel filter

### Public pass page

- [x] `MemberPassPage.jsx` — Telegram CTA with deep link from link-token API

---

## Phase 5 — Later (not MVP)

- Owner Telegram for license/trial alerts (`gyms.telegram_chat_id`)
- `/pass`, `/status` bot commands
- Absence reminders (`member_absence_reminder`)
- Delivery receipts from Telegram
- Per-gym custom bot (multi-tenant) — start with **one platform bot**

---

## Testing checklist

- [ ] Webhook receives `/start TOKEN` and stores `chat_id`
- [ ] Expired / used / invalid token → friendly bot reply, no link
- [ ] Pass resend → Telegram if linked, SMS if not
- [ ] Expiry cron → correct channel per member
- [ ] `/stop` clears link; next message goes SMS
- [ ] Message log shows channel in admin + owner UI
- [ ] Webhook secret rejects unsigned POSTs

---

## Deployment notes

- Webhook URL must be **HTTPS** (same VPS as API):  
  `https://api.yourdomain.com/api/telegram/webhook`
- Register webhook once via Bot API or startup script
- Dev: polling mode optional if no public HTTPS

---

## First commit scope (when you start)

1. Migration (member columns + link tokens + log channel)
2. `telegramBot.js` + webhook route
3. Link-token endpoint for staff
4. Wire **`member_pass_link`** + **expiry reminders** through `deliverMessage`
5. Manual test with one real member + BotFather bot

---

## Reference — current SMS stack

```
notificationSms.js → smsProvider.js → afroMessage.js | hahuMessage.js
                                    → SmsLog
```

Key existing files:

- `/home/daniel/vibe/utils/notificationSms.js`
- `/home/daniel/vibe/utils/smsProvider.js`
- `/home/daniel/vibe/jobs/expiryCheck.js`
- `/home/daniel/vibe/migrations/010_sms.sql`

---

*Last updated: 2026-08-30 — pick up at Phase 1 when ready.*

-- Telegram member linking + multi-channel message log

ALTER TABLE Members
  ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT,
  ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preferred_channel VARCHAR(16) NOT NULL DEFAULT 'sms';

ALTER TABLE Members DROP CONSTRAINT IF EXISTS members_preferred_channel_check;
ALTER TABLE Members
  ADD CONSTRAINT members_preferred_channel_check
  CHECK (preferred_channel IN ('sms', 'telegram', 'both'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_telegram_chat_id
  ON Members (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS TelegramLinkTokens (
    id SERIAL PRIMARY KEY,
    member_id INT NOT NULL REFERENCES Members(id) ON DELETE CASCADE,
    token VARCHAR(16) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_member
  ON TelegramLinkTokens (member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_expires
  ON TelegramLinkTokens (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE SmsLog
  ADD COLUMN IF NOT EXISTS channel VARCHAR(16) NOT NULL DEFAULT 'sms';

ALTER TABLE SmsLog
  ADD COLUMN IF NOT EXISTS recipient_address VARCHAR(64);

ALTER TABLE SmsLog
  ALTER COLUMN recipient_phone DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_log_channel ON SmsLog (channel);

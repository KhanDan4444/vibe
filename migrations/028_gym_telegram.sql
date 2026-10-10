-- Gym owner Telegram for license / trial alerts (SMS reserved for OTP only).

ALTER TABLE Gyms
  ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT,
  ADD COLUMN IF NOT EXISTS telegram_linked_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_gyms_telegram_chat_id
  ON Gyms (telegram_chat_id)
  WHERE telegram_chat_id IS NOT NULL;

-- Link tokens may target a member OR a gym (exactly one).
ALTER TABLE TelegramLinkTokens
  ALTER COLUMN member_id DROP NOT NULL;

ALTER TABLE TelegramLinkTokens
  ADD COLUMN IF NOT EXISTS gym_id INT REFERENCES Gyms(id) ON DELETE CASCADE;

ALTER TABLE TelegramLinkTokens DROP CONSTRAINT IF EXISTS telegram_link_tokens_target_check;
ALTER TABLE TelegramLinkTokens
  ADD CONSTRAINT telegram_link_tokens_target_check
  CHECK (
    (member_id IS NOT NULL AND gym_id IS NULL)
    OR (member_id IS NULL AND gym_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_gym
  ON TelegramLinkTokens (gym_id, created_at DESC)
  WHERE gym_id IS NOT NULL;

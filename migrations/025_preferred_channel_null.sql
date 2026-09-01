-- Telegram unlink: preferred_channel may be NULL (no SMS fallback for Telegram-only members).

ALTER TABLE Members DROP CONSTRAINT IF EXISTS members_preferred_channel_check;
ALTER TABLE Members ALTER COLUMN preferred_channel DROP NOT NULL;
ALTER TABLE Members
  ADD CONSTRAINT members_preferred_channel_check
  CHECK (preferred_channel IS NULL OR preferred_channel IN ('sms', 'telegram', 'both'));

-- One active member per phone per gym (last 9 digits, Ethiopian mobile).
-- Run `npm run db:phone-duplicates` first if this migration fails.

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_gym_phone_suffix_unique
  ON Members (
    gym_id,
    (RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 9))
  )
  WHERE deleted_at IS NULL AND phone IS NOT NULL;

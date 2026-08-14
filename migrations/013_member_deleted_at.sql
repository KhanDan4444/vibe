-- Soft-delete members so payment history and reports stay intact.
ALTER TABLE Members
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_members_gym_live
  ON Members (gym_id)
  WHERE deleted_at IS NULL;

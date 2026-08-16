-- Soft-delete gyms so SaaS payment history and reports stay intact.
ALTER TABLE Gyms
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_gyms_live
  ON Gyms (id)
  WHERE deleted_at IS NULL;

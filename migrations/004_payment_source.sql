-- Tag how each member payment was recorded (enroll, collect, renew, change_plan).
ALTER TABLE Payments ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'collect';

ALTER TABLE Payments DROP CONSTRAINT IF EXISTS payments_source_check;
ALTER TABLE Payments ADD CONSTRAINT payments_source_check
  CHECK (source IN ('enroll', 'collect', 'renew', 'change_plan'));

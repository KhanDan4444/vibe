-- Tag how each platform SaaS payment was recorded (enroll, collect, renew, change_plan).
ALTER TABLE SaaSPayments ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'collect';

ALTER TABLE SaaSPayments DROP CONSTRAINT IF EXISTS saaspayments_source_check;
ALTER TABLE SaaSPayments ADD CONSTRAINT saaspayments_source_check
  CHECK (source IN ('enroll', 'collect', 'renew', 'change_plan'));

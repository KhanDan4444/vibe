-- Phase 3: member QR pass version (does not rotate on membership renew).
ALTER TABLE Members
  ADD COLUMN IF NOT EXISTS pass_version INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN Members.pass_version IS
  'Bumped only when staff regenerates the member QR pass; renewals keep the same version.';

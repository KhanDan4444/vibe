-- Short public codes for SMS pass links (keeps JWT only inside the QR payload).
ALTER TABLE Members
  ADD COLUMN IF NOT EXISTS pass_public_code VARCHAR(16);

CREATE UNIQUE INDEX IF NOT EXISTS idx_members_pass_public_code
  ON Members (pass_public_code)
  WHERE pass_public_code IS NOT NULL;

COMMENT ON COLUMN Members.pass_public_code IS
  'Opaque short code for /p/:code SMS links; rotated when pass_version is bumped.';

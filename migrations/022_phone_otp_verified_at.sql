-- Track OTP verified before multi-step flows complete (e.g. gym signup step 2).
ALTER TABLE PhoneOtpSessions
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

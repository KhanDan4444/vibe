-- Store OTP verification codes in SMS audit log (admin-only visibility)

ALTER TABLE SmsLog
  ADD COLUMN IF NOT EXISTS otp_code VARCHAR(8);

-- OTP digits must not be recoverable from the message log.
ALTER TABLE SmsLog DROP COLUMN IF EXISTS otp_code;

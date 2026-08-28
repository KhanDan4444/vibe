-- Hahu/local OTP providers store verification_id as "hahu:" + 64-char HMAC (69 chars).
-- Afro verification IDs can also exceed 64 characters.

ALTER TABLE PhoneOtpSessions
  ALTER COLUMN verification_id TYPE VARCHAR(255);

ALTER TABLE SmsLog
  ALTER COLUMN message_id TYPE VARCHAR(255);

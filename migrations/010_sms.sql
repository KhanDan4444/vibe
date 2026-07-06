-- SMS OTP sessions and outbound message log (deduplication)

CREATE TABLE IF NOT EXISTS PhoneOtpSessions (
    id UUID PRIMARY KEY,
    purpose VARCHAR(32) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    verification_id VARCHAR(64) NOT NULL,
    user_id INT REFERENCES Users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_phone_otp_sessions_expires ON PhoneOtpSessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_phone_otp_sessions_user ON PhoneOtpSessions (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS SmsLog (
    id SERIAL PRIMARY KEY,
    recipient_phone VARCHAR(20) NOT NULL,
    message_type VARCHAR(64) NOT NULL,
    entity_type VARCHAR(32),
    entity_id INT,
    message_id VARCHAR(64),
    sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_log_daily_dedupe
    ON SmsLog (message_type, entity_type, entity_id, ((sent_at AT TIME ZONE 'UTC')::date))
    WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_log_sent_at ON SmsLog (sent_at);

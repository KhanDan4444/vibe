-- Invalidate stale JWTs after password change/reset
ALTER TABLE Users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

UPDATE Users SET password_changed_at = CURRENT_TIMESTAMP WHERE password_changed_at IS NULL;

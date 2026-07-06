-- Password reset tokens for forgot-password flow
CREATE TABLE IF NOT EXISTS PasswordResetTokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON PasswordResetTokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires_at ON PasswordResetTokens(expires_at);

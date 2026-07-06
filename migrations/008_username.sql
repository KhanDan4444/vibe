ALTER TABLE Users ADD COLUMN IF NOT EXISTS username VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON Users (LOWER(username)) WHERE username IS NOT NULL;

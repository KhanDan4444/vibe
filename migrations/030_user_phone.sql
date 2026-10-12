-- Contact phone for staff logins. Not used to sign in.
ALTER TABLE Users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

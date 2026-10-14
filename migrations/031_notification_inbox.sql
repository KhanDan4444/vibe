-- Read and dismissed notification ids, per user, shared by web and phone.
CREATE TABLE IF NOT EXISTS NotificationInbox (
  user_id INTEGER PRIMARY KEY REFERENCES Users(id) ON DELETE CASCADE,
  read_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  dismissed_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

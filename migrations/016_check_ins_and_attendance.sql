-- Check-ins (desk attendance) + gym visit-cap settings.
CREATE TABLE IF NOT EXISTS CheckIns (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    branch_id INT NOT NULL REFERENCES Branches(id) ON DELETE RESTRICT,
    member_id INT NOT NULL REFERENCES Members(id) ON DELETE CASCADE,
    checked_in_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    checked_in_by_user_id INT REFERENCES Users(id) ON DELETE SET NULL,
    method VARCHAR(30) NOT NULL DEFAULT 'search'
      CHECK (method IN ('search', 'member_qr', 'station_qr')),
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_checkins_gym_branch_at
  ON CheckIns (gym_id, branch_id, checked_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_checkins_member_at
  ON CheckIns (member_id, checked_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_checkins_gym_at
  ON CheckIns (gym_id, checked_in_at DESC);

ALTER TABLE Gyms
  ADD COLUMN IF NOT EXISTS visits_per_week SMALLINT
    CHECK (visits_per_week IS NULL OR (visits_per_week >= 1 AND visits_per_week <= 7)),
  ADD COLUMN IF NOT EXISTS week_starts_on VARCHAR(10) NOT NULL DEFAULT 'monday'
    CHECK (week_starts_on IN ('monday', 'sunday')),
  ADD COLUMN IF NOT EXISTS one_checkin_per_day BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS over_limit_policy VARCHAR(20) NOT NULL DEFAULT 'block'
    CHECK (over_limit_policy IN ('block', 'warn_allow'));

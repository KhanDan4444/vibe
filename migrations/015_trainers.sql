-- Trainers are gym employees (no login). Members may be assigned one trainer.
CREATE TABLE IF NOT EXISTS Trainers (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    branch_id INT NOT NULL REFERENCES Branches(id) ON DELETE RESTRICT,
    name VARCHAR(200) NOT NULL,
    phone VARCHAR(30),
    specialty VARCHAR(120),
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_trainers_gym_live
  ON Trainers (gym_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trainers_gym_branch
  ON Trainers (gym_id, branch_id);

ALTER TABLE Members
  ADD COLUMN IF NOT EXISTS trainer_id INT REFERENCES Trainers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_members_trainer_id ON Members (trainer_id);

ALTER TABLE Payments DROP CONSTRAINT IF EXISTS payments_source_check;
ALTER TABLE Payments ADD CONSTRAINT payments_source_check
  CHECK (source IN ('enroll', 'collect', 'renew', 'change_plan', 'trainer'));

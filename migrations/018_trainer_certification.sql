-- Optional trainer certification attachment (PDF or image).
ALTER TABLE Trainers
  ADD COLUMN IF NOT EXISTS certification_url VARCHAR(512);

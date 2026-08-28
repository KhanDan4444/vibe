-- Gym location fields for self-service signup and admin reporting
ALTER TABLE Gyms ADD COLUMN IF NOT EXISTS city VARCHAR(100);
ALTER TABLE Gyms ADD COLUMN IF NOT EXISTS address TEXT;

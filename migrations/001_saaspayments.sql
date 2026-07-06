-- Migration: platform SaaS payments ledger
-- Safe to run on existing databases (CREATE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS SaaSPayments (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    saas_plan_id INT REFERENCES SaaSPlans(id) ON DELETE SET NULL,
    amount DECIMAL(10, 2) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    method VARCHAR(50) DEFAULT 'Bank Transfer',
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_saaspayments_gym_id ON SaaSPayments(gym_id);
CREATE INDEX IF NOT EXISTS idx_saaspayments_date ON SaaSPayments(date DESC);

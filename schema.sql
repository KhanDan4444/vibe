-- =========================================================================
-- @file schema.sql
-- @description Core multi-tenant database layout initialization and seeding.
-- Optimized for case-insensitive metric processing and sequence tracking synchronization.
-- =========================================================================

-- 1. Create Gyms (Tenants) Table
CREATE TABLE IF NOT EXISTS Gyms (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    owner_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    subscription_status VARCHAR(50) DEFAULT 'active', -- active, expired, suspended
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- Forces system-level tenant status values to remain uniform
    CONSTRAINT check_subscription_status_lowercase CHECK (subscription_status = LOWER(subscription_status))
);

-- 2. Create Users Table (System-wide logins)
CREATE TABLE IF NOT EXISTS Users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL, -- "Platform Admin", "Gym Owner", or staff job role e.g. "Help Desk"
    gym_id INT REFERENCES Gyms(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    password_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Create Membership Plans Table
CREATE TABLE IF NOT EXISTS Plans (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    duration INT NOT NULL, -- duration in months
    price DECIMAL(10, 2) NOT NULL
);

-- 3b. Gym branches (locations) — Phase 1 multi-branch
CREATE TABLE IF NOT EXISTS Branches (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    address TEXT,
    is_default BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_one_default_per_gym
    ON Branches (gym_id) WHERE is_default = true;

CREATE INDEX IF NOT EXISTS idx_branches_gym_id ON Branches(gym_id);

-- 4. Create Members Table
CREATE TABLE IF NOT EXISTS Members (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    branch_id INT REFERENCES Branches(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    plan_id INT REFERENCES Plans(id) ON DELETE SET NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'active', -- active, expired, due soon
    photo_url VARCHAR(512),
    -- Forces client-level member tracking records to remain uniform
    CONSTRAINT check_member_status_lowercase CHECK (status = LOWER(status))
);

-- 5. Create Payments Table
CREATE TABLE IF NOT EXISTS Payments (
    id SERIAL PRIMARY KEY,
    member_id INT NOT NULL REFERENCES Members(id) ON DELETE CASCADE,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    method VARCHAR(50) DEFAULT 'Cash',
    source VARCHAR(50) DEFAULT 'collect' CHECK (source IN ('enroll', 'collect', 'renew', 'change_plan'))
);

-- 6. Platform SaaS plan catalog (offered to gyms by platform admin)
CREATE TABLE IF NOT EXISTS SaaSPlans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    duration INT NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Create GymSubscriptions Table (SaaS Billing Layer — gym's platform license)
CREATE TABLE IF NOT EXISTS GymSubscriptions (
    gym_id INT PRIMARY KEY REFERENCES Gyms(id) ON DELETE CASCADE,
    saas_plan_id INT REFERENCES SaaSPlans(id) ON DELETE SET NULL,
    plan VARCHAR(100) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'active',
    CONSTRAINT check_gym_sub_status_lowercase CHECK (status = LOWER(status))
);

ALTER TABLE GymSubscriptions ADD COLUMN IF NOT EXISTS saas_plan_id INT REFERENCES SaaSPlans(id) ON DELETE SET NULL;

-- 8. Platform SaaS payments (gym → platform revenue)
CREATE TABLE IF NOT EXISTS SaaSPayments (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    saas_plan_id INT REFERENCES SaaSPlans(id) ON DELETE SET NULL,
    amount DECIMAL(10, 2) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    coverage_start_date DATE,
    method VARCHAR(50) DEFAULT 'Bank Transfer',
    notes TEXT,
    source VARCHAR(50) DEFAULT 'collect' CHECK (source IN ('enroll', 'collect', 'renew', 'change_plan'))
);

ALTER TABLE SaaSPayments ADD COLUMN IF NOT EXISTS coverage_start_date DATE;

-- 9. Password reset tokens (forgot-password flow)
CREATE TABLE IF NOT EXISTS PasswordResetTokens (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES Users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_id ON PasswordResetTokens(user_id);

-- 10. Gym activity audit log (owner-visible trail of staff + owner changes)
CREATE TABLE IF NOT EXISTS AuditLogs (
    id SERIAL PRIMARY KEY,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    branch_id INT REFERENCES Branches(id) ON DELETE SET NULL,
    actor_id INT REFERENCES Users(id) ON DELETE SET NULL,
    actor_name VARCHAR(255) NOT NULL,
    actor_email VARCHAR(255),
    actor_role VARCHAR(50) NOT NULL,
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id INT,
    entity_label VARCHAR(255),
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_gym_created ON AuditLogs(gym_id, created_at DESC);

ALTER TABLE Users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE Users ADD COLUMN IF NOT EXISTS username VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON Users (LOWER(username)) WHERE username IS NOT NULL;
ALTER TABLE Users ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES Branches(id) ON DELETE SET NULL;
ALTER TABLE Members ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES Branches(id) ON DELETE RESTRICT;
ALTER TABLE Members ADD COLUMN IF NOT EXISTS photo_url VARCHAR(512);
ALTER TABLE AuditLogs ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES Branches(id) ON DELETE SET NULL;

UPDATE Users SET is_active = true WHERE is_active IS NULL;

-- Default "Main" branch per gym + backfill existing rows
INSERT INTO Branches (gym_id, name, is_default, is_active)
SELECT g.id, 'Main', true, true
FROM Gyms g
WHERE NOT EXISTS (
    SELECT 1 FROM Branches b WHERE b.gym_id = g.id AND b.is_default = true
);

UPDATE Members m
SET branch_id = b.id
FROM Branches b
WHERE m.branch_id IS NULL AND b.gym_id = m.gym_id AND b.is_default = true;

UPDATE AuditLogs a
SET branch_id = b.id
FROM Branches b
WHERE a.branch_id IS NULL AND b.gym_id = a.gym_id AND b.is_default = true;

UPDATE Users u
SET branch_id = b.id
FROM Branches b
WHERE u.branch_id IS NULL
  AND u.gym_id = b.gym_id
  AND b.is_default = true
  AND u.role IN ('Help Desk');

-- Normalize legacy role/status values from earlier app versions
UPDATE Users SET role = 'Platform Admin' WHERE role IN ('Admin', 'admin');
UPDATE Users SET role = 'Help Desk' WHERE role = 'Gym Staff';
UPDATE Members SET status = LOWER(TRIM(status)) WHERE status IS NOT NULL AND status <> LOWER(TRIM(status));
UPDATE Gyms SET subscription_status = LOWER(TRIM(subscription_status))
  WHERE subscription_status IS NOT NULL AND subscription_status <> LOWER(TRIM(subscription_status));

-- SMS OTP sessions and outbound message log
CREATE TABLE IF NOT EXISTS PhoneOtpSessions (
    id UUID PRIMARY KEY,
    purpose VARCHAR(32) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    verification_id VARCHAR(64) NOT NULL,
    user_id INT REFERENCES Users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_phone_otp_sessions_expires ON PhoneOtpSessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_phone_otp_sessions_user ON PhoneOtpSessions (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS SmsLog (
    id SERIAL PRIMARY KEY,
    recipient_phone VARCHAR(20) NOT NULL,
    message_type VARCHAR(64) NOT NULL,
    entity_type VARCHAR(32),
    entity_id INT,
    message_id VARCHAR(64),
    otp_code VARCHAR(8),
    sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_log_daily_dedupe
    ON SmsLog (message_type, entity_type, entity_id, ((sent_at AT TIME ZONE 'UTC')::date))
    WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sms_log_sent_at ON SmsLog (sent_at);

-- Default SaaS plan catalog (production + fresh installs; skipped once plans exist)
INSERT INTO SaaSPlans (name, duration, price, description, is_active)
SELECT v.name, v.duration, v.price, v.description, v.is_active
FROM (VALUES
    ('Monthly Starter', 1, 99.00, 'Monthly platform license for a single gym.', true),
    ('Quarterly Pro', 3, 249.00, 'Quarterly billing with standard support.', true),
    ('Yearly Standard', 12, 899.00, 'Annual license — best value.', true)
) AS v(name, duration, price, description, is_active)
WHERE NOT EXISTS (SELECT 1 FROM SaaSPlans LIMIT 1);

-- =========================================================================
-- DEV-ONLY SEED DATA — never run in production (see server.js)
-- =========================================================================
-- Default credentials:
--   admin@saas.com / password  (Platform Admin)
-- Bcrypt hash for "password": $2b$10$kMHpnQrCszsINqWkbkqQAuv0D6tArcq3KXftPzWZMvb1dZvRqjqaO
-- =========================================================================

INSERT INTO Users (id, name, email, password, role, gym_id, is_active)
VALUES
(1, 'Platform Admin', 'admin@saas.com', '$2b$10$kMHpnQrCszsINqWkbkqQAuv0D6tArcq3KXftPzWZMvb1dZvRqjqaO', 'Platform Admin', NULL, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO SaaSPlans (id, name, duration, price, description, is_active)
VALUES
(1, 'Monthly Starter', 1, 99.00, 'Monthly platform license for a single gym.', true),
(2, 'Quarterly Pro', 3, 249.00, 'Quarterly billing with standard support.', true),
(3, 'Yearly Standard', 12, 899.00, 'Annual license — best value.', true)
ON CONFLICT (id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('Users', 'id'), COALESCE(MAX(id), 1)) FROM Users;
SELECT setval(pg_get_serial_sequence('SaaSPlans', 'id'), COALESCE(MAX(id), 1)) FROM SaaSPlans;

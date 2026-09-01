-- Self check-in via branch station QR + Telegram OTP + trusted device.

ALTER TABLE Branches
  ADD COLUMN IF NOT EXISTS station_version INT NOT NULL DEFAULT 1;

ALTER TABLE Gyms
  ADD COLUMN IF NOT EXISTS station_self_checkin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS StationCheckInOtpSessions (
    id UUID PRIMARY KEY,
    member_id INT NOT NULL REFERENCES Members(id) ON DELETE CASCADE,
    branch_id INT NOT NULL REFERENCES Branches(id) ON DELETE CASCADE,
    gym_id INT NOT NULL REFERENCES Gyms(id) ON DELETE CASCADE,
    phone VARCHAR(50) NOT NULL,
    otp_code_hash VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_station_checkin_otp_member
  ON StationCheckInOtpSessions (member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_station_checkin_otp_expires
  ON StationCheckInOtpSessions (expires_at);

CREATE TABLE IF NOT EXISTS StationCheckInDevices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id INT NOT NULL REFERENCES Members(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    telegram_linked_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_station_checkin_devices_member
  ON StationCheckInDevices (member_id);

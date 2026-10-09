-- Registration timestamp for "new members this month" (not renew start_date).
ALTER TABLE Members ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ;

UPDATE Members m
SET created_at = (e.enrolled_on + TIME '12:00') AT TIME ZONE 'Africa/Addis_Ababa'
FROM (
  SELECT member_id, MIN(date) AS enrolled_on
  FROM Payments
  WHERE source = 'enroll'
  GROUP BY member_id
) e
WHERE m.id = e.member_id AND m.created_at IS NULL;

UPDATE Members m
SET created_at = (f.first_on + TIME '12:00') AT TIME ZONE 'Africa/Addis_Ababa'
FROM (
  SELECT member_id, MIN(date) AS first_on
  FROM Payments
  WHERE COALESCE(source, 'collect') <> 'trainer'
  GROUP BY member_id
) f
WHERE m.id = f.member_id AND m.created_at IS NULL;

UPDATE Members m
SET created_at = (m.start_date + TIME '12:00') AT TIME ZONE 'Africa/Addis_Ababa'
WHERE m.created_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM Payments p
    WHERE p.member_id = m.id AND p.source IN ('renew', 'change_plan')
  );

UPDATE Members
SET created_at = TIMESTAMP WITH TIME ZONE '2000-01-01 00:00:00+00'
WHERE created_at IS NULL;

ALTER TABLE Members ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE Members ALTER COLUMN created_at SET NOT NULL;

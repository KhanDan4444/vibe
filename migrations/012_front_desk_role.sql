-- Rename staff job role Help Desk → Front Desk (same permissions).
UPDATE Users SET role = 'Front Desk' WHERE role = 'Help Desk';

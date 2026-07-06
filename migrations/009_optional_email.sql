-- Email optional for gym owners and help desk; username is the primary login identifier.
ALTER TABLE Users ALTER COLUMN email DROP NOT NULL;

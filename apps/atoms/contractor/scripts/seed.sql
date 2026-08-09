-- Matches the Contractor claim in apps/atoms/auth/scripts/seed.sql.
INSERT INTO contractors (id, name, email, is_active)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  'E2E Contractor',
  'aljunied@townops.dev',
  true
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    email = EXCLUDED.email,
    is_active = EXCLUDED.is_active,
    updated_at = now();

INSERT INTO contractor_categories (contractor_id, category_code)
VALUES ('22222222-2222-4222-8222-222222222222', 'LE')
ON CONFLICT (contractor_id, category_code) DO NOTHING;

INSERT INTO contractor_sectors (contractor_id, sector_code)
VALUES ('22222222-2222-4222-8222-222222222222', '38')
ON CONFLICT (contractor_id, sector_code) DO NOTHING;

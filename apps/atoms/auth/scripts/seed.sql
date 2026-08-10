-- Deterministic local E2E identities. These credentials are not production
-- secrets; docker-compose's e2e-seed service applies them only after migrations.
INSERT INTO "user" (
  id, name, email, email_verified, role, contractor_id
)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'E2E Officer', 'amk@townops.dev', true, 'OFFICER', null),
  ('22222222-2222-4222-8222-222222222222', 'E2E Contractor', 'aljunied@townops.dev', true, 'CONTRACTOR', '22222222-2222-4222-8222-222222222222'),
  ('aaaaaaaa-0001-4000-8000-000000000001', 'E2E Resident', 'resident@townops.dev', true, 'RESIDENT', null)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    email = EXCLUDED.email,
    email_verified = EXCLUDED.email_verified,
    role = EXCLUDED.role,
    contractor_id = EXCLUDED.contractor_id,
    updated_at = now();

DELETE FROM account
WHERE provider_id = 'credential'
  AND user_id IN (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'aaaaaaaa-0001-4000-8000-000000000001'
  );

INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at)
VALUES
  ('11111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111111', 'credential', '11111111-1111-4111-8111-111111111111', '809452904e5b0280e23df73ff8538c1b:4fde2770d8a91bcedc1f905de70cded9007483b1321e79969294a11f824d83dae8fd3c710ec2438aac21d3c2bd33c34e4d0231c56506afe15dcb14070cd22f1c', now()),
  ('22222222-2222-4222-8222-222222222223', '22222222-2222-4222-8222-222222222222', 'credential', '22222222-2222-4222-8222-222222222222', '3cfb27e4f14f181ef5b34ebf89cf598c:664583618203c50bfd768b71dea8f2b3028acf9e3d49bbeda16b266165da5f772cca0a1d8ee91bb79b452b0c82768ea12d34c5e9ca4f6a7ad2683730e4dbff19', now()),
  ('aaaaaaaa-0001-4000-8000-000000000002', 'aaaaaaaa-0001-4000-8000-000000000001', 'credential', 'aaaaaaaa-0001-4000-8000-000000000001', '6512b756b731c59477670b4cb0471d0d:7db07f5a026f6be2472ffdd312e049e6dacff3b65cf01ac8f92c3d59f9b52e94613c297b5b953708916e7048933cf65ddc899bc08ff5c13898e249e399917608', now());

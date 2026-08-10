-- Backfills `user.role` before `db:push` enforces `NOT NULL DEFAULT 'RESIDENT'`
-- and `CHECK (role in ('RESIDENT','OFFICER','CONTRACTOR'))` (see schema.ts).
-- Existing rows may still hold NULL or lowercase values (e.g. 'officer'),
-- which db:push will hard-fail on since this repo has no migration journal
-- and applies schema via push only. Idempotent — safe to run more than once.
-- Local/dev continuity only: the production cutover (PRS-154) performs a
-- fresh database reset instead of a backfill.
UPDATE "user" SET role = COALESCE(UPPER(role), 'RESIDENT');

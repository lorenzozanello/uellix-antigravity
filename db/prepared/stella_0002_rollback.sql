-- db/prepared/stella_0002_rollback.sql
-- Rollback for stella_0002_interactions_hardening.sql (gate G2).
--
-- PREPARED ONLY — manual execution by Lorenzo, staging first, following
-- docs/ops/gates/G2_PACKAGE.md.
--
-- WARNING — restoring a BUG-COMPATIBLE state:
--   Re-granting UPDATE/DELETE below does NOT restore a "correct" baseline; it
--   restores the state that db/migrations/0033_public_api_grants.sql:50 left
--   behind, which contradicted the documented append-only posture of
--   stella_interactions (db/policies/002_stella_interactions_rls.sql). Only
--   run this rollback to return the database to the exact pre-stella_0002
--   state (e.g. to bisect an incident); do not treat the resulting grants as
--   the intended security posture.

-- RUN AS ONE TRANSACTION, like the forward script:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Both statements are idempotent: re-running is a no-op.
--
-- ORDER HAZARD vs stella_0002b (added 2026-08-01):
-- If stella_0002b_append_only_truncate_hardening.sql has been applied, running
-- THIS rollback leaves stella_interactions in an asymmetric state — still
-- protected against TRUNCATE (0002b's statement trigger survives, by design),
-- but open to UPDATE/DELETE again for `authenticated`. It also makes a later
-- re-apply of 0002b ABORT, because that script's precondition 0c requires the
-- row-level trigger this file removes.
-- That is intentional, not a bug: 0002b's protection must not be undone by a
-- rollback aimed at a different unit. To return to a fully pre-G2 state, run
-- this file and then treat the 0002b hardening separately — see the four
-- meanings of "rollback" in stella_0002b_rollback.sql.

SET search_path = public;

-- 1. Detach the append-only trigger (the shared function
--    uellix_forbid_mutation() stays — it is owned by migration 0030 and used
--    by audit_logs / sroi_calculation_runs / sroi_calculation_line_items).
DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON public.stella_interactions;

-- 2. Restore grants exactly as 0033 left them (BUG-compatible: full CRUD for
--    authenticated on an append-only table; RLS still denies UPDATE/DELETE
--    because no such policies exist).
GRANT UPDATE, DELETE ON public.stella_interactions TO authenticated;

-- 3. The stella_role CHECK reconciliation is intentionally NOT reverted:
--    the 6-role set is the truth declared by db/schema.ts:635 and migration
--    0027. Narrowing it back would reintroduce schema drift and could break
--    inserts from the Fase 5b reviewer roles. If a revert to the 3-role 0012
--    CHECK were ever genuinely required, that is a separate, explicit decision
--    with its own gate — not part of this rollback.

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

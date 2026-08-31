-- FIBIU-28 — governed audit event contract, stage E (FIBC-029/FIBC-040/FIBDB-034).
--
-- Custom SQL migration: no schema.ts diff. Triggers are hand-authored in this
-- repo's migration chain (see 0030_immutability.sql), following the same
-- idempotent DROP TRIGGER IF EXISTS / CREATE TRIGGER pattern used there.
--
-- MEASURED STATE CORRECTION. trg_stella_interactions_append_only and all five
-- sibling trg_*_no_truncate triggers (on audit_logs, sroi_calculation_runs,
-- sroi_calculation_line_items, stella_interactions, stella_suggestion_decisions)
-- are already applied in the G2 environment (db/baseline/stella_g2_schema.sql),
-- installed there by the unapplied-to-Drizzle prepared units
-- db/prepared/stella_0002_interactions_hardening.sql and
-- db/prepared/stella_0002b_append_only_truncate_hardening.sql. This migration
-- SUPERSEDES those two prepared units' trigger objects with an idempotent
-- Drizzle form covering all SIX triggers, so a Drizzle-only environment ends
-- up with the exact same append-only/no-truncate protection G2 already has —
-- otherwise it would ship with audit_logs, calculation runs and calculation
-- line items unprotected against TRUNCATE.
--
-- trg_stella_suggestion_decisions_no_truncate (installed in G2 by prepared
-- stella_0003, not stella_0002b) is also covered here because FIBDB-034 names
-- it as one of the five no-truncate siblings. stella_0003 itself, and its OWN
-- append-only trigger (trg_stella_suggestion_decisions_append_only), remain
-- NO_COLLISION and untouched — only the no-truncate trigger on that table is
-- promoted to Drizzle here; nothing else about that prepared unit moves.
--
-- stella_0002 and stella_0002b are marked RETIRED_DO_NOT_APPLY — see
-- db/prepared/README.md and db/prepared-package-order.ts for the disposition
-- record.
--
-- Deploy-safety stage E (FIB §6.1), but idempotent and behaviorally a no-op
-- wherever the trigger already exists (G2) — it only ADDS protection in a
-- fresh Drizzle-only environment. FIBDB-034's own row in FIB §6.2 records
-- APPLICATION_PREREQUISITE: none, which is why this ships in wave 1 ahead of
-- the FIB's general D-before-E hardening order without opening an unsafe
-- window: there is no earlier stage this depends on, and no environment is
-- ever LESS protected after this migration than before it.
--
-- public.uellix_forbid_mutation() already exists (0030_immutability.sql) and
-- is reused unchanged.

DROP TRIGGER IF EXISTS trg_stella_interactions_append_only ON stella_interactions;
CREATE TRIGGER trg_stella_interactions_append_only
  BEFORE UPDATE OR DELETE ON stella_interactions
  FOR EACH ROW EXECUTE FUNCTION uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_sroi_calculation_runs_no_truncate ON sroi_calculation_runs;
CREATE TRIGGER trg_sroi_calculation_runs_no_truncate
  BEFORE TRUNCATE ON sroi_calculation_runs
  FOR EACH STATEMENT EXECUTE FUNCTION uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_sroi_calculation_line_items_no_truncate ON sroi_calculation_line_items;
CREATE TRIGGER trg_sroi_calculation_line_items_no_truncate
  BEFORE TRUNCATE ON sroi_calculation_line_items
  FOR EACH STATEMENT EXECUTE FUNCTION uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_stella_interactions_no_truncate ON stella_interactions;
CREATE TRIGGER trg_stella_interactions_no_truncate
  BEFORE TRUNCATE ON stella_interactions
  FOR EACH STATEMENT EXECUTE FUNCTION uellix_forbid_mutation();

DROP TRIGGER IF EXISTS trg_stella_suggestion_decisions_no_truncate ON stella_suggestion_decisions;
CREATE TRIGGER trg_stella_suggestion_decisions_no_truncate
  BEFORE TRUNCATE ON stella_suggestion_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION uellix_forbid_mutation();

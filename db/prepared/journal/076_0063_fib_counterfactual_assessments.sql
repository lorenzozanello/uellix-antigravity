-- ============================================================================
-- GENERATED — DO NOT EDIT. Unit 76/78: 0063_fib_counterfactual_assessments.sql
-- ============================================================================
--
-- Includes:      db/migrations/0063_fib_counterfactual_assessments.sql
-- Source SHA256: 66418b303421e3e9286b1b96d0eb03931f0d7c81a4caf67a4a1957af9497b188
--
-- This wrapper exists so the journal row and the unit COMMIT TOGETHER. psql
-- -1 wraps the whole invocation in one transaction and \ir splices the unit
-- into it, so a crash at any point leaves BOTH or NEITHER. The unit is not
-- copied here — it is included, so this file cannot drift from it.
--
--   psql -1 -v ON_ERROR_STOP=1 -v uellix_project_ref=<staging-ref> \
--        -f db/prepared/journal/076_0063_fib_counterfactual_assessments.sql
--
-- ============================================================================
\set ON_ERROR_STOP on

-- THE REFUSAL IS A SERVER-SIDE ERROR, NOT \quit.
--
-- The first version ended the refusal branch with `\quit 1`. Reviewer B read
-- exec_command_quit() in psql's command.c and found it takes NO ARGUMENT: the
-- 1 is not an exit code, and psql terminates with status 0. Any orchestration
-- checking $? would have read a refused unit as a successful one — the ledger
-- would be honest and the shell around it would not.
--
-- RAISE inside the branch produces a real error, so ON_ERROR_STOP exits 3 and
-- the transaction rolls back. It changes nothing: the include is in the OTHER
-- branch and never runs.
\if :{?uellix_project_ref}

-- SHAPE GUARD, BEFORE ANY UNIT SQL RUNS.
--
-- `\if :{?var}` tests whether the variable is DEFINED, not whether it holds
-- anything. `-v ref="$UNSET_SHELL_VAR"` defines it as the EMPTY STRING, so
-- the refusal branch below never fires and what actually stopped the unit was
-- the ledger's CHECK constraint — a third line of defence doing a first line's
-- job. Independent audit found it. The CHECK stays; this refuses earlier and
-- says why, and it catches empty, whitespace and malformed alike.
SET LOCAL uellix.project_ref = :'uellix_project_ref';
DO $guard$
BEGIN
  IF coalesce(current_setting('uellix.project_ref', true), '') !~ '^[a-z]{20}$' THEN
    RAISE EXCEPTION 'REFUSED: uellix_project_ref is absent, empty, whitespace or not a 20-lowercase-letter Supabase project ref. Nothing was applied.';
  END IF;
END $guard$;

\ir ../../../db/migrations/0063_fib_counterfactual_assessments.sql

-- The journal row. INSIDE this transaction, by construction.
INSERT INTO uellix_provisioning.applied_units
  (environment, project_ref, package_id, phase,
   source_sha256, derived_sha256, security_surface_digest, status)
VALUES
  ('staging', :'uellix_project_ref', '0063_fib_counterfactual_assessments.sql', 'PHASE_BASELINE',
   '66418b303421e3e9286b1b96d0eb03931f0d7c81a4caf67a4a1957af9497b188', NULL, NULL, 'APPLIED');

\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\echo 'The journal cannot record which project this unit was applied to,'
\echo 'and an unattributed row is a row that could describe any database.'
DO $refused$ BEGIN
  RAISE EXCEPTION 'REFUSED: uellix_project_ref was not supplied; nothing was applied.';
END $refused$;
\endif

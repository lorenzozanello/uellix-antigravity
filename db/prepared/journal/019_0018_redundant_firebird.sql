-- ============================================================================
-- GENERATED — DO NOT EDIT. Unit 19/50: 0018_redundant_firebird.sql
-- ============================================================================
--
-- Includes:      db/migrations/0018_redundant_firebird.sql
-- Source SHA256: 9705a5ae5bc2e49348cdfbcf22e4b3ab234b3e7f73f1cce48760f60c897ca1c4
--
-- This wrapper exists so the journal row and the unit COMMIT TOGETHER. psql
-- -1 wraps the whole invocation in one transaction and \ir splices the unit
-- into it, so a crash at any point leaves BOTH or NEITHER. The unit is not
-- copied here — it is included, so this file cannot drift from it.
--
--   psql -1 -v ON_ERROR_STOP=1 -v uellix_project_ref=<staging-ref> \
--        -f db/prepared/journal/019_0018_redundant_firebird.sql
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

\ir ../../../db/migrations/0018_redundant_firebird.sql

-- The journal row. INSIDE this transaction, by construction.
INSERT INTO uellix_provisioning.applied_units
  (environment, project_ref, package_id, phase,
   source_sha256, derived_sha256, security_surface_digest, status)
VALUES
  ('staging', :'uellix_project_ref', '0018_redundant_firebird.sql', 'PHASE_BASELINE',
   '9705a5ae5bc2e49348cdfbcf22e4b3ab234b3e7f73f1cce48760f60c897ca1c4', NULL, NULL, 'APPLIED');

\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\echo 'The journal cannot record which project this unit was applied to,'
\echo 'and an unattributed row is a row that could describe any database.'
DO $refused$ BEGIN
  RAISE EXCEPTION 'REFUSED: uellix_project_ref was not supplied; nothing was applied.';
END $refused$;
\endif

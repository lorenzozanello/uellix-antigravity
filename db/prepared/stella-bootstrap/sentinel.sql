-- ============================================================================
-- GENERATED — DO NOT EDIT. S2, the staging sentinel row.
-- Regenerate with `pnpm s2:sentinel:generate`; `pnpm s2:sentinel:verify`
-- compares bytes.
--
-- THIS IS THE ONE WRITE OF PHASE_STELLA_BOOTSTRAP, AND IT IS A HUMAN ACT.
-- stella_hosted_0001 creates the table and leaves it empty on purpose: a
-- bootstrap that minted its own sentinel would be certifying itself.
-- `planProvisioningPhase` refuses to write this row, in code, with its own
-- test. This file is a template a PERSON runs; the identity is a parameter, so
-- the repository can help someone make the claim but can never make it alone.
--
--   & $Psql -v ON_ERROR_STOP=1 -v uellix_project_ref=<ref> -f db/prepared/stella-bootstrap/sentinel.sql
--
-- NO `-1`, deliberately, and this is the one place in the programme where that
-- flag is wrong. This file opens and closes its own transaction so the
-- postcondition runs BEFORE the COMMIT. Adding -1 nests them and psql emits
-- three spurious warnings — "there is already a transaction in progress" twice
-- and "there is no transaction in progress" once — on a run that succeeded.
-- Measured. An operator who has just crossed a human boundary should not have
-- to decide whether warnings on the one write of the phase are benign.
--
-- The ref is the one you read from the Supabase dashboard. It is not a secret:
-- a project ref is public in every URL the project serves.
-- ============================================================================
\if :{?uellix_project_ref}
\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\echo 'The sentinel states which database this is. It cannot be written blind.'
\quit
\endif

BEGIN;
SET LOCAL search_path = '';

-- The ref reaches the guards through a transaction-local setting rather than
-- through :'uellix_project_ref' directly, and that is not style. psql's lexer
-- knows about dollar-quoting and does NOT substitute variables inside a
-- $$ ... $$ body, so the literal text ":'uellix_project_ref'" would reach the
-- server and fail as syntax. Measured, not assumed: the first draft of this
-- file did exactly that.
SELECT pg_catalog.set_config('uellix.sentinel_project_ref', :'uellix_project_ref', true);

DO $$
DECLARE
  v_ref text := pg_catalog.current_setting('uellix.sentinel_project_ref');
BEGIN
  -- (1) PRODUCTION DENY, by name, before anything is written.
  IF v_ref IN ('ctaxtgujyyprgynmnvtq') THEN
    RAISE EXCEPTION 'S2 REFUSED: % is a PRODUCTION project ref. The sentinel declares a database to be staging; writing it there would make production claim to be staging to every gate that reads it.', v_ref;
  END IF;

  -- (2) The shape the table's own CHECK enforces, refused here first so the
  --     message names the problem instead of quoting a constraint.
  IF v_ref !~ '^[a-z]{20}$' THEN
    RAISE EXCEPTION 'S2 REFUSED: % is not a Supabase project ref (20 lowercase letters).', v_ref;
  END IF;

  -- (3) S1 must have happened. Without the table there is nothing to write to,
  --     and with a row there is already an identity this would duplicate.
  IF to_regclass('uellix_bootstrap.staging_sentinel') IS NULL THEN
    RAISE EXCEPTION 'S2 REFUSED: uellix_bootstrap.staging_sentinel does not exist. Apply stella_hosted_0001 first (S1).';
  END IF;

  IF (SELECT count(*) FROM uellix_bootstrap.staging_sentinel) <> 0 THEN
    RAISE EXCEPTION 'S2 REFUSED: the sentinel already has a row. This is a ONE-SHOT act by construction — the singleton CHECK admits exactly one, and re-declaring an identity is not a thing that should be easy.';
  END IF;
END $$;

INSERT INTO uellix_bootstrap.staging_sentinel
  (environment, project_ref, bootstrap_version, owner_separation)
VALUES
  ('staging', :'uellix_project_ref', 'stella_hosted_0001',
   'auditable-obstacle: RR-02 applies, postgres retains ADMIN OPTION over uellix_owner');

-- Postcondition, INSIDE the transaction that wrote it. A row that fails this
-- is rolled back rather than left for CHECKPOINT A1 to discover.
DO $$
DECLARE
  v_count int;
  v_row   record;
  v_ref   text := pg_catalog.current_setting('uellix.sentinel_project_ref');
BEGIN
  SELECT count(*) INTO v_count FROM uellix_bootstrap.staging_sentinel;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'S2 FAILED: % row(s) after the insert; the sentinel is a singleton.', v_count;
  END IF;

  SELECT * INTO v_row FROM uellix_bootstrap.staging_sentinel;

  IF v_row.environment <> 'staging' THEN
    RAISE EXCEPTION 'S2 FAILED: environment is %, not staging.', v_row.environment;
  END IF;

  IF v_row.project_ref <> v_ref THEN
    RAISE EXCEPTION 'S2 FAILED: the row says % and you declared %.', v_row.project_ref, v_ref;
  END IF;

  IF v_row.bootstrap_version <> 'stella_hosted_0001' THEN
    RAISE EXCEPTION 'S2 FAILED: bootstrap_version is %, expected stella_hosted_0001.', v_row.bootstrap_version;
  END IF;

  IF position('RR-02' in v_row.owner_separation) = 0 THEN
    RAISE EXCEPTION 'S2 FAILED: owner_separation does not record RR-02. The residual risk is a live property of this database, and an operator reading the sentinel must see it without finding the package.';
  END IF;

  RAISE NOTICE 'S2: sentinel written — environment=staging, project_ref=%, bootstrap_version=%, RR-02 recorded, provisioned_at=%. CHECKPOINT A1 is next, and it is read-only.', v_row.project_ref, v_row.bootstrap_version, v_row.provisioned_at;
END $$;

COMMIT;

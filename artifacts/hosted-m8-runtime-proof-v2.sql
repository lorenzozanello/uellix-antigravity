-- ============================================================================
-- M-8 RUNTIME PROOF v2 — STAGING ONLY. ROLLBACK-ONLY. NO FIXTURE.
--
-- v1 (artifacts/hosted-m8-runtime-proof.sql) is PRESERVED UNCHANGED as the
-- record of what was actually executed. This is a separate file, not an edit.
--
-- WHY v2 EXISTS
-- -------------
-- v1 returned its decisive field only through RAISE NOTICE. In the executed run
-- the NOTICE channel did not reach the operator while the RESULT channel did:
-- `M8_RUNTIME_TX_CLOSED=true` arrived, the four NOTICE lines did not. The
-- SQLSTATE was therefore never measured, and exit code 0 cannot substitute for
-- it — psql exits 0 whenever no error ESCAPES, and this script catches by
-- design.
--
-- The root cause of the NOTICE loss is NOT established (candidates: psql -q,
-- client_min_messages above notice, or the shell not surfacing stderr). Rather
-- than guess, v2 removes the dependency: every decisive field is returned as
-- ORDINARY QUERY RESULT DATA, on the channel already proven to work, and
-- capturable with -o. NOTICE is retained only as a redundant secondary echo.
--
-- v2 also MEASURES client_min_messages, so the run answers the root-cause
-- question as a by-product instead of leaving it open.
--
-- HOW THE VALUE CROSSES THE DO BOUNDARY
-- -------------------------------------
-- A DO block cannot return a value. The repository's own pattern for moving a
-- value across that boundary is db/prepared/checkpoint-a1/corroboration.sql:58
-- — set_config(name, value, is_local => true) paired with current_setting().
-- Inverted here: the DO block WRITES, a SELECT READS. is_local => true keeps it
-- transaction-scoped, so it is discarded by the ROLLBACK and nothing outlives
-- the transaction. No table, no temp object, no DDL, no DML.
--
-- The reads happen INSIDE the transaction, before ROLLBACK, because a
-- transaction-local setting does not survive it.
--
-- Output is TWO single-line JSON documents, in this order:
--   line 1  the measurement, emitted inside the transaction
--   line 2  the closure proof, emitted after ROLLBACK
-- Single-line (::text, not jsonb_pretty) so the file parses deterministically.
--
-- HOW TRANSACTION CLOSURE IS PROVEN NON-VACUOUSLY
-- -----------------------------------------------
-- v1 used `pg_current_xact_id_if_assigned() IS NULL`. That test is VACUOUS for
-- this proof and has been removed. PostgreSQL assigns a real XID only when a
-- transaction WRITES; this proof deliberately writes nothing, so the function
-- returns NULL both inside and outside the transaction. v1's reported
-- `M8_RUNTIME_TX_CLOSED=true` therefore established nothing at all.
--
-- Two independent non-vacuous signals replace it, each emitted in BOTH phases
-- so the pair brackets the transaction boundary rather than asserting one side:
--
--   settingVisible   NULLIF(current_setting('uellix.m8_sqlstate', true), '')
--                    IS NOT NULL.
--
--                    THE NULLIF IS LOAD-BEARING, AND `IS NOT NULL` ALONE IS
--                    WRONG. Measured on the PostgreSQL 17.6 certification
--                    image: once a custom GUC placeholder has been created in a
--                    session, ROLLBACK reverts its VALUE but the placeholder
--                    itself remains session-visible as the EMPTY STRING, not
--                    NULL. `current_setting(..., true) IS NOT NULL` therefore
--                    stays TRUE after the rollback and the closure bracket
--                    never closes — it would report settingVisible=true in both
--                    phases and prove nothing. NULLIF(..., '') maps the reverted
--                    placeholder back to NULL, so the predicate is FALSE after
--                    rollback as intended.
--
--                    It is the very mechanism carrying the result, so it cannot
--                    be true-by-accident: if it were false inside the
--                    transaction, sqlstate would be null too.
--
--   inExplicitTx     transaction_timestamp() < statement_timestamp().
--                    transaction_timestamp() is fixed at BEGIN; statement_
--                    timestamp() advances per statement. TRUE for any statement
--                    after the first in an explicit block, FALSE in autocommit.
--                    Independent of whether anything was written.
--
-- FAILURE MODE IS DETECTABLE, NOT WRONG
-- -------------------------------------
-- If set_config did not carry the value across the DO boundary, `sqlstate`
-- reads back NULL or the empty string. Both are STOP conditions, never a
-- verdict — the mechanism cannot fail into a false PASS or a false 42501.
--
-- DO NOT pass -1: this file opens its own transaction.
-- ============================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- FAIL-CLOSED EXECUTION ATTRIBUTION
-- ---------------------------------------------------------------------------
-- Same shape as db/prepared/checkpoint-a1/corroboration.sql:36. There is no
-- default, no fallback and no inferred id: an unattributed runtime measurement
-- cannot be tied to the credential lifecycle that produced it, and two runs
-- would be indistinguishable in the evidence directory.
--
-- The id is minted and recorded by `pnpm m8:runtime:open`, which appends to
-- artifacts/hosted-m8-runtime-attempts.jsonl under kind "hosted-m8-runtime".
-- That ledger is SEPARATE from the governed chain ledger: this attempt is not a
-- chain package write and must never be able to become the latest OPENED chain
-- attempt.
\if :{?m8_attempt_id}
\else
\echo 'REFUSED: -v m8_attempt_id=<attempt> was not supplied.'
\echo 'An unattributed runtime proof cannot be bound to the credential lifecycle'
\echo 'that produced it. Run: pnpm m8:runtime:open'
\quit
\endif

BEGIN;

DO $m8$
DECLARE
  v_sqlstate text;
  v_message  text;
BEGIN
  BEGIN
    PERFORM *
    FROM uellix_grounding.claim_active_document_version(
           '00000000-0000-0000-0000-000000000000'::uuid);
    v_sqlstate := 'NO_EXCEPTION_RAISED';
    v_message  := 'the call returned without raising';
  EXCEPTION WHEN OTHERS THEN
    -- Catches everything ON PURPOSE and interprets NOTHING. The raw SQLSTATE is
    -- carried out verbatim; a handler that mapped codes to a verdict could turn
    -- 42501 into "passed", which is the regression this proof exists to detect.
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_message  = MESSAGE_TEXT;
  END;

  -- THE RESULT CHANNEL. Transaction-local, read by the SELECT below.
  PERFORM pg_catalog.set_config('uellix.m8_sqlstate', v_sqlstate, true);
  PERFORM pg_catalog.set_config('uellix.m8_message',  v_message,  true);

  -- Secondary echo only. If it is invisible again, nothing is lost.
  RAISE NOTICE 'M8_RUNTIME_SQLSTATE = %', v_sqlstate;
END
$m8$;

-- LINE 1 — the measurement. Inside the transaction, so the transaction-local
-- settings are still readable. Raw fields only; no verdict is computed here.
SELECT jsonb_build_object(
  'schema', 'uellix.hosted.m8.runtime/1',
  'note', 'Runtime M-8 proof. Rollback-only. No credential or user data is recorded here.',
  'phase', 'IN_TRANSACTION',
  'attemptId', :'m8_attempt_id',
  -- clock_timestamp(), not now()/transaction_timestamp(): those are fixed at
  -- BEGIN, so both rows would carry the same instant and the pair could not
  -- show that line 2 was produced after the rollback.
  'capturedAt', pg_catalog.clock_timestamp(),
  'sessionUser', session_user,
  'currentUser', current_user,
  'isRealLogin', (session_user = current_user AND session_user = 'uellix_app'),
  'probeUuid', '00000000-0000-0000-0000-000000000000',
  'sqlstate', pg_catalog.current_setting('uellix.m8_sqlstate', true),
  'message',  pg_catalog.current_setting('uellix.m8_message',  true),
  'expectedSqlstate', 'U0102',
  'forbiddenRegressionSqlstate', '42501',
  'currentDatabase', pg_catalog.current_database(),
  -- Root-cause evidence for the v1 NOTICE loss, measured rather than guessed.
  'clientMinMessages', pg_catalog.current_setting('client_min_messages', true),
  -- Closure bracket, IN phase. Both must be TRUE here.
  'settingVisible', (NULLIF(pg_catalog.current_setting('uellix.m8_sqlstate', true), '') IS NOT NULL),
  'inExplicitTx', (pg_catalog.transaction_timestamp() < pg_catalog.statement_timestamp())
)::text AS m8_runtime_measurement;

ROLLBACK;

-- LINE 2 — closure proof, after the transaction ended. session_user AND
-- current_user are repeated here so each evidence row stands alone: a reader
-- must never have to join two rows to know which principal produced it.
SELECT jsonb_build_object(
  'schema', 'uellix.hosted.m8.runtime-closure/1',
  'phase', 'AFTER_ROLLBACK',
  'attemptId', :'m8_attempt_id',
  'capturedAt', pg_catalog.clock_timestamp(),
  'sessionUser', session_user,
  'currentUser', current_user,
  'isRealLogin', (session_user = current_user AND session_user = 'uellix_app'),
  -- Closure bracket, OUT phase. Both must be FALSE here. Compared against the
  -- TRUE/TRUE of line 1, the pair proves a boundary was crossed — neither value
  -- alone proves anything.
  'settingVisible', (NULLIF(pg_catalog.current_setting('uellix.m8_sqlstate', true), '') IS NOT NULL),
  'inExplicitTx', (pg_catalog.transaction_timestamp() < pg_catalog.statement_timestamp())
)::text AS m8_runtime_closure;

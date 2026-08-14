-- ============================================================================
-- M-8 RUNTIME PROOF — STAGING ONLY. ROLLBACK-ONLY. NO FIXTURE.
--
-- MUST be run through a connection that AUTHENTICATED as uellix_app.
-- Not SET ROLE. Not SET SESSION AUTHORIZATION. tests/helpers/local-runtime.ts
-- states the rule this file obeys:
--
--   "A test that reaches `uellix_app` by SET ROLE re-proves the thing that was
--    already true and misses the thing that was false. These helpers therefore
--    AUTHENTICATE as the role, with the real credential."
--
-- The session principal is printed BELOW, from the server, so the document
-- proves which principal produced the SQLSTATE rather than assuming it.
--
-- WHAT THIS EXERCISES, IN ORDER, INSIDE claim_active_document_version:
--   1. EXECUTE on the function            (uellix_app is a grantee)
--   2. pg_advisory_xact_lock(...)         (the T10 repair)
--   3. SELECT ... FROM public.evidence_items AS THE DEFINER
--                                         <-- THE M-8 BOUNDARY
--   4. v_org IS NULL  ->  RAISE U0102
--
-- Step 3 is the whole point. The pre-M-8 body did `SELECT ... FOR UPDATE`,
-- which needs UPDATE privilege to take a row lock; uellix_cap_grounding holds
-- only SELECT, so every call died with 42501 BEFORE reaching step 4.
-- Reaching U0102 therefore proves step 3 completed without UPDATE.
--
-- The all-zeros UUID is deliberately nonexistent, so v_org is NULL and the
-- function raises at the FIRST U0102 — before public.current_user_org_ids()
-- is ever consulted. No JWT claim, no org context, no seeded row is required.
--
-- DO NOT pass -1 / --single-transaction: this file opens its own transaction.
-- ============================================================================

\set ON_ERROR_STOP on

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
    -- Reaching here means NO exception was raised at all. That is neither the
    -- expected result nor a regression; it is reported verbatim, not judged.
    v_sqlstate := 'NO_EXCEPTION_RAISED';
    v_message  := 'the call returned without raising';
  EXCEPTION WHEN OTHERS THEN
    -- WHEN OTHERS catches everything ON PURPOSE, and interprets NOTHING. The
    -- raw SQLSTATE is printed for the operator to compare against U0102. A
    -- handler that mapped codes to a verdict could turn 42501 into "passed".
    GET STACKED DIAGNOSTICS
      v_sqlstate = RETURNED_SQLSTATE,
      v_message  = MESSAGE_TEXT;
  END;

  RAISE NOTICE 'M8_RUNTIME_SESSION_USER  = %', session_user;
  RAISE NOTICE 'M8_RUNTIME_CURRENT_USER  = %', current_user;
  RAISE NOTICE 'M8_RUNTIME_SQLSTATE      = %', v_sqlstate;
  RAISE NOTICE 'M8_RUNTIME_MESSAGE       = %', v_message;
END
$m8$;

ROLLBACK;

-- Proof the transaction is closed and nothing survives it.
SELECT 'M8_RUNTIME_TX_CLOSED=' ||
       CASE WHEN pg_catalog.pg_current_xact_id_if_assigned() IS NULL
            THEN 'true' ELSE 'false' END AS m8_runtime_tx_state;

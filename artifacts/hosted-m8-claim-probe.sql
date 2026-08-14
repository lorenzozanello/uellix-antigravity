-- ============================================================================
-- M-8 POST-T10 STRUCTURAL PROBE — READ ONLY.
--
-- Fills the gap the chain witness registry cannot cover. `package-witnesses.ts`
-- declares grounding_0005 with requiredAbsentWhenInstalled: [], so the certified
-- witness asserts the advisory lock is PRESENT and says nothing about whether
-- `FOR UPDATE` is GONE. That negative predicate is the open pre-RC finding, and
-- it is the one M-8 actually turns on.
--
-- No INSERT/UPDATE/DELETE/DDL. One BEGIN READ ONLY ... ROLLBACK, one SELECT.
-- Run through the ADMIN connection; every question below is about the DATABASE,
-- not about the session, so any connection answers it identically.
--
--   DO NOT pass -1 / --single-transaction. This file opens its own READ ONLY
--   transaction; psql's wrapper would make the BEGIN a no-op WARNING and
--   silently discard the READ ONLY property.
--
-- ---------------------------------------------------------------------------
-- WHY EVERY POSITIONAL TEST READS A COMMENT-STRIPPED DEFINITION
-- ---------------------------------------------------------------------------
-- `pg_get_functiondef` returns source VERBATIM, comments included, and BOTH of
-- these routines carry comments that quote the very tokens under test: the
-- claim body explains its own repair by writing out the `FOR UPDATE` it removed.
-- Searching raw text would find the defect in a sentence describing the absence
-- of the defect. That is F-08C — a comment must never satisfy a test about code.
-- The strip expression is the SAME one the certified A1 witness uses.
--
-- `claimForUpdateInRawText` is emitted ON PURPOSE as a diagnostic: it should be
-- TRUE. If it were false the comment would be gone, which would mean the body
-- is not the governed body, and the stripped test would be passing for the
-- wrong reason.
--
-- ---------------------------------------------------------------------------
-- WHY strpos AND NOT position(... IN ...)
-- ---------------------------------------------------------------------------
-- db/prepared/checkpoint-a1/corroboration.sql:130 records the measurement:
-- `position(... in ...)` is SQL keyword syntax and CANNOT be schema-qualified —
-- `pg_catalog.position('x' in y)` is a syntax error. This transaction empties
-- search_path, so every call here is qualified, which forces strpos.
-- NOTE THE ARGUMENT ORDER: strpos(haystack, needle), the reverse of
-- position(needle IN haystack).
-- ============================================================================

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(
  'schema', 'uellix.hosted.m8.claim/1',
  'note', 'Structural M-8 verification. No credential, connection string or user data is recorded here.',
  'measuredBy', 'operator, read-only transaction, post-T10',

  -- Exactly one routine must resolve for each name. A second overload would
  -- make every positional test below ambiguous rather than wrong, so it is
  -- counted rather than assumed.
  'claimRoutineCount', (
    SELECT count(*) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),
  'registerRoutineCount', (
    SELECT count(*) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'register_document_version'),

  /* -- THE LOCK, in the routine this package replaced. ---------------------- */
  'claimAdvisoryLockPresent', (
    SELECT pg_catalog.strpos(
             pg_catalog.regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '--[^\n]*', '', 'g'),
             'pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0))') > 0
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),

  /* -- THE NEGATIVE PREDICATE the witness registry cannot express. ---------- */
  'claimForUpdateAbsent', (
    SELECT pg_catalog.strpos(
             pg_catalog.regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '--[^\n]*', '', 'g'),
             'FOR UPDATE') = 0
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),

  -- Diagnostic. Expected TRUE: proves the strip is doing real work.
  'claimForUpdateInRawText', (
    SELECT pg_catalog.strpos(pg_catalog.pg_get_functiondef(p.oid), 'FOR UPDATE') > 0
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),

  /* -- THE SIBLING's key, which must be the SAME key. ----------------------- */
  'registerAdvisoryLockPresent', (
    SELECT pg_catalog.strpos(
             pg_catalog.regexp_replace(pg_catalog.pg_get_functiondef(p.oid), '--[^\n]*', '', 'g'),
             'pg_advisory_xact_lock(hashtextextended(p_evidence_id::text, 0))') > 0
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'register_document_version'),

  /* -- PRESERVED SHAPE. The package promises to change ONLY the body. ------- */
  'claimSecurityDefiner', (
    SELECT p.prosecdef FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),
  'claimProconfig', (
    SELECT pg_catalog.to_jsonb(p.proconfig) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),
  'claimResultType', (
    SELECT pg_catalog.pg_get_function_result(p.oid) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),
  'claimOwner', (
    SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),
  'claimAcl', (
    SELECT pg_catalog.array_to_string(p.proacl, ' | ') FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),
  'claimLanguage', (
    SELECT l.lanname FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'uellix_grounding' AND p.proname = 'claim_active_document_version'),

  /* -- THE PRIVILEGE ASYMMETRY M-8 IS ABOUT. -------------------------------- */
  -- Asked by OID, never by name: the name overload of has_table_privilege
  -- RAISES for a role that does not exist, and an exception is not a
  -- measurement. Selecting FROM pg_roles turns a missing role into no rows,
  -- which is NULL — reportable.
  'evidenceItemsPresent', (pg_catalog.to_regclass('public.evidence_items') IS NOT NULL),
  'capGroundingRolePresent', (
    SELECT true FROM pg_catalog.pg_roles r WHERE r.rolname = 'uellix_cap_grounding'),
  'capGroundingSelectOnEvidenceItems', (
    SELECT pg_catalog.has_table_privilege(r.oid, c.oid, 'SELECT')
    FROM pg_catalog.pg_roles r,
         (SELECT pg_catalog.to_regclass('public.evidence_items') AS oid) c
    WHERE r.rolname = 'uellix_cap_grounding' AND c.oid IS NOT NULL),
  'capGroundingUpdateOnEvidenceItems', (
    SELECT pg_catalog.has_table_privilege(r.oid, c.oid, 'UPDATE')
    FROM pg_catalog.pg_roles r,
         (SELECT pg_catalog.to_regclass('public.evidence_items') AS oid) c
    WHERE r.rolname = 'uellix_cap_grounding' AND c.oid IS NOT NULL)

  -- DELIBERATELY NOT MEASURED HERE: temporary membership residue and the
  -- per-schema CREATE residual. `artifacts/hosted-chain-posture-probe.sql` is
  -- the certified instrument for both (it emits capabilityReachableBy and the
  -- per-schema CREATE residual) and is judged by `pnpm posture:status`.
  -- Re-asking them here would be a second, uncertified answer to a question
  -- that already has a governed one.
));

ROLLBACK;

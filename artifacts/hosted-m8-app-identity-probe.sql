-- ============================================================================
-- STEP C — PROVE A REAL SERVER-SIDE LOGIN AS uellix_app. READ ONLY.
--
-- Must be run through the uellix_app connection itself. Like the installer
-- identity probe, this measures THE SESSION, not the database, so it is the one
-- probe whose answer depends on which connection carries it.
--
-- session_user  is the authenticated login and CANNOT be changed by SET ROLE.
-- current_user  follows SET ROLE.
-- Requiring both to equal uellix_app is what distinguishes a real login from an
-- administrative session wearing the role — the exact substitution
-- tests/helpers/local-runtime.ts refuses:
--
--   "A test that reaches uellix_app by SET ROLE re-proves the thing that was
--    already true and misses the thing that was false."
--
-- Emits no credential. Six role facts, one privilege bit and two corroboration
-- fields — there is nowhere in this document to put a secret.
--
-- No INSERT/UPDATE/DELETE/DDL. BEGIN READ ONLY ... ROLLBACK. DO NOT pass -1.
-- ============================================================================

BEGIN READ ONLY;
SET LOCAL search_path = '';

SELECT jsonb_pretty(jsonb_build_object(
  'schema', 'uellix.hosted.m8.app-identity/1',
  'note', 'Session identity for the M-8 runtime proof. No credential, connection string or user data is recorded here.',

  /* -- WHO the server says we are. ----------------------------------------- */
  'sessionUser', session_user,
  'currentUser', current_user,
  'isRealLogin', (session_user = current_user AND session_user = 'uellix_app'),

  /* -- The shape the runtime principal must have. -------------------------- */
  'canLogin', coalesce((
    SELECT r.rolcanlogin FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false),
  'isSuper', coalesce((
    SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false),
  'bypassRls', coalesce((
    SELECT r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false),
  'inheritsPrivileges', coalesce((
    SELECT r.rolinherit FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false),

  /* -- We are on a database where T10 exists and we may call it. ----------- */
  -- Corroboration that this connection reaches the SAME database the chain was
  -- installed into. A session authenticated as uellix_app against some other
  -- project would fail here rather than produce a misleading U0102.
  'claimRoutinePresent', (
    pg_catalog.to_regprocedure('uellix_grounding.claim_active_document_version(uuid)') IS NOT NULL),
  'claimExecutableByMe', coalesce(
    pg_catalog.has_function_privilege(
      current_user,
      'uellix_grounding.claim_active_document_version(uuid)',
      'EXECUTE'), false),
  'currentDatabase', pg_catalog.current_database()
));

ROLLBACK;

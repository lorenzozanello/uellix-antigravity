-- db/prepared/stella_0003_rollback.sql
-- Rollback for stella_0003_suggestion_decisions.sql (gate G2).
--
-- PREPARED ONLY — manual execution by Lorenzo, staging first, following
-- docs/ops/gates/G2_PACKAGE.md.
--
-- PRECONDITION: STELLA_DECISIONS_PERSISTENCE_ENABLED must be unset/false in
-- every environment pointing at this database BEFORE dropping the table,
-- otherwise recordStellaDecision inserts will start failing at runtime.
--
-- Dropping the table is destructive for the human-decision audit trail it
-- contains. Export the rows first if any were recorded:
--   -- SELECT * FROM stella_suggestion_decisions ORDER BY decided_at;
--
-- Policies, indexes and the two append-only triggers fall with the table; the
-- table-level GRANT disappears with the table as well. The shared trigger
-- function public.uellix_forbid_mutation() is NOT dropped: it is owned by
-- db/migrations/0030_immutability.sql and still guards audit_logs,
-- sroi_calculation_runs, sroi_calculation_line_items and stella_interactions.
--
-- SCOPE — what this rollback deliberately does NOT touch:
--   * It does not alter Supabase's global ALTER DEFAULT PRIVILEGES. Those are
--     out of scope for any single-table script and are deferred to their own
--     cross-cutting gate (docs/ops/STELLA_FABLE_RISK_REGISTER.md).
--   * It does not restore grants on any OTHER table. In particular it must
--     never undo db/prepared/stella_0002b_append_only_truncate_hardening.sql,
--     whose rollback is deliberately non-reversing.
--   * Because the table is dropped outright, there is no "restore the previous
--     privileges" question here: the privileges cease to exist with it. Should
--     the FORWARD script (stella_0003_suggestion_decisions.sql) ever be applied
--     again afterwards, ITS section 4 does REVOKE ALL before granting, so the
--     table is recreated hardened rather than inheriting the default-privilege
--     surplus. This rollback has no numbered sections.
--
-- RUN AS ONE TRANSACTION, like the forward script:
--   psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f <this file>
-- Idempotent: re-running changes nothing. (Note the ISOLATION PRECONDITION
-- below: on a cluster carrying default_transaction_isolation = repeatable read
-- or serializable, even the no-op run refuses — deliberately, and fail-closed.)

-- ============================================================================
-- THE FOUR MEANINGS OF "ROLLBACK" HERE (added 2026-08-01)
-- ============================================================================
--   1. TECHNICAL ROLLBACK, BEFORE USE — the table exists but holds ZERO rows
--      (applied by mistake, or the gate aborted downstream). Nothing is lost.
--      This script runs unattended in that case.
--   2. DESTRUCTION WITH DATA — the table holds decisions. DROP TABLE ERASES a
--      human-decision audit trail, and no trigger can stop it: the two
--      append-only triggers forbid UPDATE/DELETE/TRUNCATE, but DROP TABLE
--      removes the table AND its triggers in one statement. This script
--      therefore ABORTS unless the operator explicitly authorises it.
--   3. EMERGENCY OPERATION — a legal erasure order or an incident requiring the
--      table gone despite its contents. Same authorisation as (2), plus an
--      export first, plus its own change record.
--   4. HUMAN RESPONSIBILITY — the authorisation below is not a formality. Who
--      set it, when, and why belongs in the gate record. The script can refuse
--      by default; it cannot decide that erasing an audit trail is acceptable.
--
-- AUTHORISING DESTRUCTION WITH DATA (case 2/3). Unset (the default) means
-- "abort if there are rows". The authorisation must be a SESSION setting made
-- in the SAME session that runs this file — the guard below refuses a persisted
-- `ALTER DATABASE/ROLE … SET`, so that workaround is not one.
--
--   THE INVOCATION THAT WORKS — one psql session, `-c` before `-f`:
--     psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 \
--       -c "SET stella.confirm_destroy_decisions='true'" \
--       -f db/prepared/stella_0003_rollback.sql
--
--   A SEPARATE `psql -c "SET …"` invocation does NOT work: it is a different
--   session, and the setting is gone before this file is read. Pasting the SET
--   and then the file into one open psql session works for the same reason the
--   form above does — same session.
--
--   Verify what you are about to destroy first:
--     SELECT count(*) FROM public.stella_suggestion_decisions;
--     -- and export: SELECT * FROM public.stella_suggestion_decisions ORDER BY decided_at;

-- ============================================================================
-- STRUCTURAL SAFETY — why the DROP lives INSIDE the guard (hardened 2026-08-01)
-- ============================================================================
-- PREVIOUS DEFECT. Until this revision the guard and the destructive act were
-- two SEPARATE top-level statements:
--
--     DO $$ ... IF n_rows > 0 AND NOT authorised THEN RAISE EXCEPTION ...  $$;
--     DROP TABLE IF EXISTS public.stella_suggestion_decisions;   -- <-- separate
--
-- That is safe only because of two psql COMMAND-LINE FLAGS, and neither of them
-- is a property of this file:
--
--   * `-v ON_ERROR_STOP=1` is what makes psql STOP after a failed statement.
--     Without it psql prints the error and cheerfully SENDS THE NEXT ONE — the
--     DROP. The guard would have raised, been reported, and been ignored.
--   * `-1` is what wraps everything in one transaction so a failure rolls back.
--     Without it each statement autocommits on its own.
--
-- So the barrier between "this table holds an unauthorised audit trail" and
-- "the table is gone" was an invocation convention. Every other consumer of a
-- .sql file — the Supabase SQL Editor, `supabase db execute`, a GUI client, a
-- copy-paste into an open psql session, any future runner — either does not
-- accept those flags or does not default to them. The header MANDATES them;
-- nothing ENFORCED them.
--
-- THE FIX. Everything now happens in ONE DO block: existence check, row count,
-- operator-facing NOTICEs, the authorisation test, and the DROP itself. In
-- PL/pgSQL a RAISE EXCEPTION terminates the block immediately — no later
-- statement of that block runs. That is SERVER semantics, decided by
-- PostgreSQL while executing a single statement, not CLIENT semantics decided
-- by psql between statements. No flag, no client and no paste order can
-- separate the guard from the DROP any more, because they are the same
-- statement.
--
-- `-1 -v ON_ERROR_STOP=1` REMAIN RECOMMENDED and are still what the header
-- above prescribes: they are defence in depth (atomicity, non-zero exit code
-- for a gate that reads it). They are simply no longer the ONLY barrier.
--
-- WHY `EXECUTE` WITH A FIXED LITERAL. The statement executed is a compile-time
-- constant embedded in this file:
--
--     EXECUTE 'DROP TABLE public.stella_suggestion_decisions';
--
-- There is NO string concatenation, NO format(), NO identifier taken from a
-- variable, a GUC, a catalog lookup or any other input. The only thing the
-- surrounding code decides is WHETHER to run it, never WHAT it says. This is
-- the same construct — and the same rationale — that
-- stella_0002b_append_only_truncate_hardening.sql already uses for its
-- version-dependent REVOKE, and tests/prepared-stella-sql.test.ts admits
-- `EXECUTE '<fixed literal>'` for exactly this reason while rejecting
-- `EXECUTE v_sql` and `EXECUTE format(...)`.
--
-- CONCATENATION is a SEPARATE question, closed by a SEPARATE assertion. The
-- shared `expectNoExecutedDdl` helper does NOT reject `EXECUTE 'x' || ident`:
-- after string blanking that reads `EXECUTE '' || …`, which its lookahead
-- admits by construction. Measured, not assumed. What forbids it is the shared
-- helper expectExecutedLiteralsTerminated(), applied to every stella_* script by
-- a directory sweep (the grounding_* scripts are owned by
-- lib/grounding/__tests__/prepared-sql.test.ts and are NOT covered by it):
-- each executed literal must be followed IMMEDIATELY by `;`, `INTO` or `USING`, so
-- nothing can be appended, on that line or a later one. (It was inline and
-- "per-file" for one revision, while stella_0002b — which uses the same
-- construct — had no such check at all.)
--
-- `DROP TABLE`, not `DROP TABLE IF EXISTS`: existence was already established a
-- few lines above, inside the same block, and the absent case returned early.
-- Keeping IF EXISTS would only hide a discrepancy between the check and the act.
--
-- SEPARATOR CHARACTER (`=`, not `-`). The operator-facing banner below used to
-- be a row of dashes. A `--` INSIDE a string literal blinds every offline
-- analyser that strips line comments before string literals — including
-- tests/prepared-stella-sql.test.ts's stripCommentsAndStrings, which is what
-- the lint uses to prove there is no executable `DROP TABLE` in this file. With
-- a dash banner it truncated the NOTICE at the first `--`, left an unbalanced
-- quote, and from there read the rest of the script's STRING CONTENT as code:
-- the assertion could no longer distinguish a literal from a statement. `=`
-- carries no lexical meaning in SQL and costs the reader nothing.

SET search_path = public;

-- DROP TABLE takes ACCESS EXCLUSIVE. Bound the wait so this cannot stall other
-- sessions behind a long reader; the script is idempotent, so retrying is free.
SET lock_timeout = '5s';

-- The operator record this script rests on is its NOTICE/WARNING output. A
-- session left at `client_min_messages = warning` (or higher) would run the
-- destructive path in silence — the same class of problem as depending on psql
-- flags: a property of the invocation deciding whether the safeguard is
-- observable. Pin it, like search_path and lock_timeout.
--
-- WHAT THIS DOES AND DOES NOT BUY. It closes the psql/session-GUC half only. It
-- cannot make a client display what it never displays: the Supabase SQL Editor
-- — named above as a reason not to depend on invocation properties — does not
-- surface NOTICE/WARNING at all, so on that path the destruction record is still
-- lost. Use psql when the record matters, which is the same reason it is the
-- prescribed method in docs/ops/gates/G2_PACKAGE.md.
SET client_min_messages = notice;

DO $$
DECLARE
  n_rows          bigint;
  authorised      boolean;
  persisted_at    text;

BEGIN
  -- ISOLATION PRECONDITION — FIRST, because every fact this block reads THROUGH A
  -- QUERY is snapshot-dependent. (The syscache lookups — to_regclass,
  -- pg_has_role, has_table_privilege — use the CATALOG snapshot, which is
  -- refreshed independently even under RR; they are fresher, not staler. What
  -- matters are the two explicit SELECTs over pg_class and the row count, which
  -- go through the executor's query snapshot.) Under READ COMMITTED each query takes a FRESH snapshot,
  -- so everything read after the ACCESS EXCLUSIVE lock below reflects reality at
  -- that moment. Under REPEATABLE READ or SERIALIZABLE the transaction's
  -- snapshot is fixed at the TRANSACTION's first snapshot-taking query. Under the
  -- prescribed `psql -1 -c "SET …" -f` that is the first query of THIS block —
  -- nothing before it but SETs, which take no snapshot — so it lands BEFORE the
  -- lock. Pasted into an already-open session the snapshot can predate the block
  -- entirely, which is worse, not better.
  --
  -- Failure that closes: a cluster or role carrying
  -- `ALTER DATABASE … SET default_transaction_isolation = 'repeatable read'`.
  -- A row committed by another session between that snapshot and the lock is
  -- invisible to the count below, so n_rows = 0, the ELSE arm runs, the log says
  -- "table is empty — technical rollback before use, no audit data lost", ALL
  -- THREE authorisation guards are skipped, and a populated audit trail is
  -- dropped — with a record that positively certifies nothing was lost.
  --
  -- This was previously a COMMENT declaring the assumption and calling anything
  -- else "out of contract" — which is the exact defect the STRUCTURAL SAFETY
  -- section above exists to eliminate, reintroduced one paragraph later. Unlike
  -- the four persistence channels that genuinely cannot be observed from SQL
  -- (postgresql.conf, ALTER SYSTEM, PGOPTIONS, connection options), this one CAN
  -- be: current_setting('transaction_isolation') needs no privilege and reports
  -- the running transaction's actual level. A guard that is verifiable and
  -- merely absent is not an honest limit; it is a missing guard.
  --
  -- READ UNCOMMITTED is accepted because PostgreSQL implements it AS
  -- READ COMMITTED — it is the same snapshot behaviour under a different name.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    RAISE EXCEPTION 'stella_0003_rollback aborted: transaction_isolation is %. This script''s row count is only trustworthy under READ COMMITTED, where the count taken after the ACCESS EXCLUSIVE lock sees a fresh snapshot; under REPEATABLE READ or SERIALIZABLE it could read a pre-lock snapshot, count 0 on a populated table, and destroy the audit trail while reporting that nothing was lost. Re-run with SET TRANSACTION ISOLATION LEVEL READ COMMITTED, or clear default_transaction_isolation for this role/database', current_setting('transaction_isolation');
  END IF;

  -- (A) TABLE ABSENT -> NOTICE, no-op, success. This is also the second-run
  --     path: once the DROP below has succeeded, every further execution of
  --     this file lands here.
  IF to_regclass('public.stella_suggestion_decisions') IS NULL THEN
    RAISE NOTICE 'stella_0003_rollback: public.stella_suggestion_decisions does not exist — nothing to do (idempotent no-op).';
    RETURN;
  END IF;

  -- OWNERSHIP PRECONDITION. The DROP at the end requires ownership, or the
  -- INHERITED privileges of the owning role — that is what this checks. Note
  -- "inherited", not "member": a NOINHERIT member IS a member and still fails
  -- the 'USAGE' test below, correctly, because it cannot drop without SET ROLE
  -- first. The steps in
  -- between need less: count(*) needs only SELECT, and on PostgreSQL 17
  -- LOCK … ACCESS EXCLUSIVE also accepts MAINTAIN. Checking the strictest
  -- requirement FIRST is the point, and it covers two different callers:
  --   * one who can lock and count but cannot drop would otherwise do all the
  --     work and fail at the last statement;
  --   * one who cannot even lock fails at the LOCK with a bare `permission
  --     denied for table stella_suggestion_decisions` — fail-closed, nothing
  --     destroyed, but with no `stella_0003_rollback aborted:` prefix.
  -- That prefix is the marker this file's header and the G2 abort criteria tell
  -- the operator to look for. Reading pg_class needs no privilege on the table,
  -- so this check is always reachable; make the refusal deliberate and prefixed
  -- instead of incidental.
  -- COALESCE(..., false): between the existence check above and this subquery
  -- nothing is locked yet, so a concurrent session can drop the table. The
  -- subquery then returns no row, pg_has_role(current_user, NULL, 'USAGE') is
  -- NULL, and a bare `IF NOT NULL THEN` is FALSE — the guard would be SKIPPED,
  -- and the LOCK below would fail with an unprefixed 42P01. Treat unknown as
  -- "not permitted", so the refusal stays deliberate and prefixed.
  --
  -- DELIBERATELY NARROWER THAN DROP TABLE'S OWN RULE — do not "fix" this.
  -- PostgreSQL lets THREE kinds of caller drop a table: the table owner (or a
  -- role inheriting its privileges), a superuser, and — via
  -- RangeVarCallbackForDropRelation's second object_ownercheck — the SCHEMA
  -- OWNER (or, symmetrically, a role inheriting the schema owner's privileges).
  -- This guard admits only the first two. That looks like a bug and is
  -- not: it is what keeps the FORCE argument below sound.
  --
  -- MEASURED on PostgreSQL 17.6, schema owned by `sch_owner`, table owned by
  -- `tbl_owner`, RLS on, FORCE off, policy USING(false), one row:
  --     pg_has_role('sch_owner','tbl_owner','USAGE')  -> false
  --     SELECT count(*) AS sch_owner                  -> permission denied
  --     DROP TABLE       AS sch_owner                 -> SUCCEEDED
  -- So the schema owner can DESTROY the table while being unable to COUNT it.
  -- Widening this guard to match DROP's documented rule would let such a caller
  -- reach the count, get 0 (or an unprefixed permission error), take the "table
  -- is empty — no audit data lost" branch, and drop a populated audit trail —
  -- the exact failure the FORCE guard exists to prevent, without FORCE ever
  -- being on. The narrowness costs the intended caller nothing: the role
  -- DATABASE_URL connects as OWNS this table. A legitimate schema owner who
  -- must run the rollback does `SET ROLE <table owner>` first, which is also
  -- what the abort message tells them.
  --
  -- 'USAGE', not 'MEMBER': DROP TABLE goes through object_ownercheck ->
  -- has_privs_of_role(), which is USAGE semantics (inherited privileges, no
  -- SET ROLE needed). 'MEMBER' would be too permissive — a NOINHERIT member
  -- passes it but cannot drop without SET ROLE first.
  IF NOT COALESCE(pg_has_role(current_user,
                              (SELECT relowner FROM pg_class
                               WHERE oid = to_regclass('public.stella_suggestion_decisions')),
                              'USAGE'), false) THEN
    RAISE EXCEPTION 'stella_0003_rollback aborted: role % cannot drop public.stella_suggestion_decisions — either it does not own the table and does not inherit the owning role''s privileges (a NOINHERIT member must SET ROLE <owner> first), or the table was dropped by another session since this script started. Re-run as the role that owns the table (the same role DATABASE_URL connects as, see stella_0003 §4b); if it is already gone, re-running is a clean no-op', current_user;
  END IF;

  -- Take the lock the DROP will need ANYWAY, and take it FIRST. Without it the
  -- count runs under ACCESS SHARE, which does not block INSERT: a concurrent
  -- writer could add rows between the count and the DROP's ACCESS EXCLUSIVE,
  -- and those rows would be destroyed having been neither counted nor
  -- authorised. lock_timeout above bounds the wait, and the script is
  -- idempotent, so timing out costs nothing.
  --
  -- It comes BEFORE the FORCE check below, not after: the same race applies to
  -- the FLAG that decides whether the count means anything. Another session
  -- could commit `ALTER TABLE … FORCE ROW LEVEL SECURITY` between a pre-lock
  -- pg_class read and the lock, after which the count would run under FORCE and
  -- the guard would already have concluded there was nothing to worry about.
  -- Under the lock, every fact read below stays true for the rest of the block.
  --
  -- This closes the race under READ COMMITTED, which the ISOLATION PRECONDITION
  -- at the top of the block now ENFORCES rather than assuming. Under a fixed
  -- snapshot the lock would not be enough — the count could still read pre-lock
  -- state — which is precisely why that guard runs before anything else.
  LOCK TABLE public.stella_suggestion_decisions IN ACCESS EXCLUSIVE MODE;

  -- FORCE ROW LEVEL SECURITY GUARD — the row count below is what decides
  -- "empty, nothing lost" versus "populated, authorisation required", and
  -- count(*) is SUBJECT TO RLS. Ownership normally bypasses row security, but
  -- FORCE removes exactly that bypass; a role that owns the table and lacks
  -- rolbypassrls would then see the org-scoped SELECT policy of section 5
  -- return NOTHING, count 0 rows, and this script would announce "table is
  -- empty — no audit data lost" while dropping a populated audit trail.
  --
  -- MEASURED on PostgreSQL 17.6 (owner role, NOBYPASSRLS, policy USING(false)):
  -- FORCE off -> count = 1; FORCE on -> count = 0, with the row still there.
  -- It does NOT reproduce as `postgres` on a Supabase image, because that role
  -- carries rolbypassrls — which is precisely why it must not be left to the
  -- role the operator happens to use.
  --
  -- WHY FORCE IS THE ONLY CASE, for the WHOLE caller set this script admits.
  -- The ownership guard above accepts more than the exact owner:
  -- `pg_has_role(…, 'USAGE')` also passes a role that INHERITS the owner's
  -- privileges. So "FORCE off implies a trustworthy count" has to hold for that
  -- wider set, not just for the owner. Both RLS's owner bypass
  -- (check_enable_rls) and DROP's ownership test resolve to the same predicate,
  -- object_ownercheck -> has_privs_of_role, so they should agree — but "should"
  -- is not evidence. MEASURED, same engine, FORCE off, RLS on, policy
  -- USING(false), one row present:
  --     as the exact owner   (NOBYPASSRLS)              -> count = 1
  --     as an INHERIT member of the owner (NOBYPASSRLS) -> count = 1
  --     pg_has_role(member, owner, 'USAGE')             -> true
  -- So every caller this guard ADMITS also bypasses RLS. That containment —
  -- admitted ⊆ bypassing — is all the FORCE argument needs, and it is what was
  -- measured. The reverse does NOT hold and is not claimed: any rolbypassrls
  -- role bypasses without being a member of the owner (Supabase's `postgres` is
  -- exactly that, as noted above). No caller can pass the ownership guard and
  -- still read a row-security-filtered count. A NOINHERIT member is refused earlier by the ownership guard itself
  -- and never reaches here. FORCE remains the only way to break the count, and
  -- that is what the check below covers.
  --
  -- Both flags, not just FORCE: `relforcerowsecurity` can be true while
  -- `relrowsecurity` is false, and in that state RLS is not applied at all, so
  -- the count is trustworthy and aborting would be a false refusal on a table
  -- this script could safely handle.
  --
  -- The forward script already treats FORCE-on as an abortable state (§4b and
  -- §7). This is the symmetric check: the guard refuses to judge a count it
  -- cannot trust.
  IF (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
      WHERE oid = to_regclass('public.stella_suggestion_decisions')) THEN
    RAISE EXCEPTION 'stella_0003_rollback aborted: FORCE ROW LEVEL SECURITY is ON for public.stella_suggestion_decisions. count(*) is subject to RLS, so this script cannot tell an empty table from one whose rows are merely invisible to this role — and would classify a populated audit trail as empty. This refusal is UNCONDITIONAL: it does not depend on who you are, so re-running as a BYPASSRLS role will not clear it. Turn FORCE off — the state stella_0003 verifies and the only route past this guard';
  END IF;

  EXECUTE 'SELECT count(*) FROM public.stella_suggestion_decisions' INTO n_rows;

  -- Authorisation is the EXACT string 'true' and nothing else. current_setting
  -- with missing_ok = true returns NULL when the GUC was never set, so COALESCE
  -- turns "unset" into "not authorised" rather than into a NULL comparison that
  -- would make `NOT authorised` unknown — and therefore neither branch below
  -- would fire. The VALUES 'yes', 'y', '1', 'on', 't', 'TRUE', 'True' and
  -- ' true ' are all REFUSED: erasing an audit trail must not hinge on a
  -- client's boolean coercion. No ::boolean cast, no lower(), no trim().
  --
  -- HONEST LIMIT, measured on PostgreSQL 17.6. The UNQUOTED forms
  -- `SET x = TRUE`, `SET x = True` and the double-quoted `SET x = "true"` all
  -- authorise, and that is not a hole in this comparison: PostgreSQL's SET
  -- grammar normalises them and STORES the string 'true', byte-identical to
  -- what `SET x = 'true'` produces. By the time current_setting() reads it the
  -- distinction no longer exists, and no guard written in SQL can recover it.
  -- What IS refused is the quoted literal 'TRUE' and every other spelling
  -- above. Stated here rather than claimed away, because "rejects TRUE"
  -- without this caveat would be a verification declared and not performed.
  authorised := COALESCE(current_setting('stella.confirm_destroy_decisions', true), '') = 'true';

  IF n_rows > 0 THEN
    -- (C) ROWS PRESENT, NOT AUTHORISED -> abort. Nothing below this line runs:
    --     RAISE EXCEPTION ends the block, and the DROP is INSIDE the block.
    --     The guards come BEFORE the destruction banner on purpose: NOTICEs are
    --     not rolled back, so emitting the destruction banner ("about to DROP …",
    --     "…only until this transaction COMMITS…") plus its WARNING
    --     ("…recoverable ONLY from a verified backup") and THEN refusing would
    --     leave a log of a refusal that reads like a log of a destruction.
    IF NOT authorised THEN
      RAISE EXCEPTION 'stella_0003_rollback aborted: the table holds % row(s) and destruction was NOT authorised. Export them first, then re-run with: SET stella.confirm_destroy_decisions = ''true''; Record who authorised it and why in the gate log', n_rows;
    END IF;

    -- PER-RUN AUTHORISATION. current_setting() cannot say WHERE a value came
    -- from, so a persisted `ALTER DATABASE … SET` or `ALTER ROLE … SET` would
    -- pre-authorise every future session — turning the safeguard back into a
    -- property of the ENVIRONMENT rather than of this run, which is the exact
    -- defect the structural block above exists to close, merely relocated from
    -- psql flags to the GUC layer. pg_db_role_setting DOES record those two
    -- forms (custom placeholder GUCs never appear in pg_settings, so provenance
    -- has to be read from this catalog instead). Verified on PostgreSQL 17.6.
    --
    -- READABILITY IS NOT ASSUMED. pg_db_role_setting is a shared catalog whose
    -- SELECT privilege is environment-dependent: on the Supabase PostgreSQL
    -- 17.6 image it carries an explicit grant to PUBLIC (`=r/supabase_admin`,
    -- measured), but a cluster that leaves it restricted would make the query
    -- below die with a bare `permission denied for table pg_db_role_setting` —
    -- no 'stella_0003_rollback aborted:' prefix, on the emergency path, after
    -- the operator has already been told destruction was authorised. Check the
    -- privilege explicitly so the refusal is deliberate, prefixed and
    -- actionable rather than incidental. Fail-closed: an unverifiable guard is
    -- treated as a failed guard, never as a passed one.
    IF NOT has_table_privilege('pg_catalog.pg_db_role_setting', 'SELECT') THEN
      RAISE EXCEPTION 'stella_0003_rollback aborted: cannot verify that the authorisation belongs to THIS run — role % has no SELECT on pg_catalog.pg_db_role_setting, the only catalog that records a persisted ALTER DATABASE/ROLE setting. Re-run as a role that can read it, or GRANT SELECT ON pg_catalog.pg_db_role_setting TO %, or confirm manually that no standing authorisation exists and record that confirmation in the gate log', current_user, current_user;
    END IF;

    -- SCOPED to settings that could actually apply to THIS session, and to the
    -- value that would actually authorise. An unrelated
    -- `ALTER ROLE some_other_role SET stella.confirm_destroy_decisions='false'`,
    -- or a setting persisted on a DIFFERENT database of the same cluster,
    -- authorises nothing here — blocking on it would strand the emergency path
    -- during an incident and name a database/role pair with no bearing on this
    -- run. setdatabase = 0 means "all databases", setrole = 0 means "all roles".
    --
    -- split_part(), not LIKE: `_` is a LIKE wildcard, so
    -- 'stella.confirm_destroy_decisions=%' would also match a differently
    -- spelled parameter — the same trap MIN-A closed in the forward script.
    SELECT string_agg(
             COALESCE((SELECT d.datname FROM pg_database d WHERE d.oid = s.setdatabase), 'ALL DATABASES')
             || '/' ||
             COALESCE((SELECT r.rolname FROM pg_roles r WHERE r.oid = s.setrole), 'ALL ROLES'),
             ', ')
      INTO persisted_at
    FROM pg_db_role_setting s
    WHERE (s.setdatabase = 0
           OR s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()))
      -- session_user, NOT current_user, and an exact OID match rather than role
      -- membership: PostgreSQL applies pg_db_role_setting at session start via
      -- process_settings(databaseid, GetSessionUserId()) — it keys on the LOGIN
      -- role, exactly, and never consults membership. Getting this wrong fails
      -- OPEN in the case that matters: the ownership guard above tells the
      -- operator to "re-run as the role that owns the table", which they may do
      -- with SET ROLE — leaving session_user as their login role. A standing
      -- `ALTER ROLE <login> SET stella.confirm_destroy_decisions='true'` DID
      -- authorise that session, and a current_user-keyed filter would not see
      -- it. It also fails CLOSED the other way: a setting on a role this
      -- session merely inherits from never applied, yet membership would match
      -- and strand the emergency path.
      AND (s.setrole = 0
           OR s.setrole = (SELECT oid FROM pg_roles WHERE rolname = session_user))
      AND EXISTS (
        SELECT 1 FROM unnest(s.setconfig) c
        WHERE split_part(c, '=', 1) = 'stella.confirm_destroy_decisions'
          AND split_part(c, '=', 2) = 'true'
      );

    IF persisted_at IS NOT NULL THEN
      RAISE EXCEPTION 'stella_0003_rollback aborted: stella.confirm_destroy_decisions is PERSISTED (%), not set for this run. A standing authorisation pre-approves every future session and leaves no per-run human act to record. Remove it (ALTER DATABASE/ROLE … RESET stella.confirm_destroy_decisions), then authorise with a session SET in the session that performs the rollback', persisted_at;
    END IF;

    -- REMAINING HONEST LIMIT — stated, not claimed away. A session-level SET is
    -- the strongest thing SQL can require here, and it is narrower than "a human
    -- authorised this run" in two ways:
    --   * It cannot distinguish an operator typing the SET from a wrapper script
    --     emitting it.
    --   * pg_db_role_setting records ALTER DATABASE/ALTER ROLE only. Four other
    --     channels set the same GUC for every session and appear in NEITHER
    --     pg_settings (custom placeholders are GUC_NO_SHOW_ALL) NOR this
    --     catalog: postgresql.conf, ALTER SYSTEM SET, PGOPTIONS='-c …', and a
    --     connection-string `options=-c …`. The last two are properties of the
    --     invocation — the very class this file otherwise refuses to rely on —
    --     and no SQL statement can observe them.
    -- Both remainders are HUMAN preconditions of the gate, recorded in
    -- docs/ops/gates/G2_PACKAGE.md — the same three-way split (structural guard
    -- / offline test / human gate) the forward script's §4b uses.

    -- (C') ROWS PRESENT, AUTHORISED EXACTLY, FOR THIS RUN -> proceed, loudly.
    RAISE NOTICE '==============================================================';
    RAISE NOTICE 'stella_0003_rollback: about to DROP public.stella_suggestion_decisions';
    RAISE NOTICE 'Rows currently stored: %', n_rows;
    RAISE NOTICE 'DROP TABLE erases this human-decision audit trail. The two';
    RAISE NOTICE 'append-only triggers forbid UPDATE/DELETE/TRUNCATE, but they';
    RAISE NOTICE 'cannot stop DROP TABLE — it removes the triggers along with the';
    RAISE NOTICE 'table. PostgreSQL DDL is transactional, so under the prescribed';
    RAISE NOTICE 'psql -1 a ROLLBACK still undoes this — but only until this';
    RAISE NOTICE 'transaction COMMITS. After that, no SQL can bring append-only';
    RAISE NOTICE 'rows back: only a verified restore can, so one must exist';
    RAISE NOTICE 'before you proceed. On a disposable rehearsal stack that is by';
    RAISE NOTICE 'design; on any real environment it is not.';
    RAISE NOTICE '==============================================================';
    RAISE WARNING 'stella_0003_rollback: destroying % decision row(s) under explicit per-run authorisation (stella.confirm_destroy_decisions=true). An audit trail is being erased; after COMMIT this is recoverable ONLY from a verified backup.', n_rows;
  ELSE
    -- (B) TABLE PRESENT, ZERO ROWS -> technical rollback before use. No
    --     destruction banner here: there is nothing to warn about, and printing
    --     the destruction banner ("about to DROP …") before "no audit data
    --     lost" would contradict itself.
    RAISE NOTICE 'stella_0003_rollback: table is empty — technical rollback before use, no audit data lost.';
  END IF;

  -- NO DEPENDENT-OBJECT PRE-CHECK — a deliberate decision, recorded so it is
  -- not "fixed" later (added 2026-08-01, after independent review round 3).
  --
  -- If a view or an inbound FK ever references this table, DROP TABLE fails
  -- with PostgreSQL's generic "cannot drop … because other objects depend on
  -- it", WITHOUT the 'stella_0003_rollback aborted:' prefix this file's header
  -- tells the operator to look for. That is a message-quality defect, not a
  -- safety one: nothing is destroyed, the transaction aborts, and the table
  -- survives intact.
  --
  -- A pg_depend pre-check was written to close it, and REMOVED after two
  -- successive defects proved the approach unsound:
  --   1. It joined pg_class on d.objid, which misses VIEWS entirely — a view
  --      depends on the table through its pg_rewrite RULE, not directly. The
  --      guard existed, did nothing, and reported success.
  --   2. Rewritten over pg_describe_object, it then fired on the table's OWN
  --      RLS policy and CHECK constraints. Both record DEPENDENCY_NORMAL rows
  --      per referenced COLUMN, in ADDITION to their DEPENDENCY_AUTO row on the
  --      table, so a deptype='n' filter classifies them as foreign dependents.
  --      MEASURED on PostgreSQL 17.6 against the real stella_0003 object set.
  --      Reproduce with EXACTLY this query — no other filter:
  --        SELECT d.deptype, d.classid::regclass, pg_describe_object(d.classid, d.objid, 0)
  --        FROM pg_depend d
  --        WHERE d.refobjid   = to_regclass('public.stella_suggestion_decisions')
  --          AND d.refclassid = 'pg_class'::regclass
  --        ORDER BY 1;
  --      Complete output — 20 rows, measured against the FULL object set the
  --      forward script creates (11 columns, PK, 4 FKs, 2 CHECKs, 2 indexes,
  --      RLS policy, 2 triggers, 2 column defaults). An earlier revision of
  --      this comment listed 15 rows: it had been measured against a REDUCED
  --      fixture with no FKs and only one index, and still claimed to be
  --      complete — the same defect this file disqualifies everywhere else.
  --      TRANSCRIPTION, not raw output: object names are elided to `...`, the
  --      two rows for the two-column index are folded onto one line with (x2),
  --      refobjsubid is omitted, and the within-deptype order is imposed (ORDER
  --      BY 1 leaves it unspecified). Measured against a PURPOSE-BUILT fixture
  --      carrying the FULL shape — 4 FK parents, both indexes, both CHECKs, the
  --      RLS policy and both triggers — NOT the smaller dry-run fixture, which
  --      has no foreign keys. That fixture was built inline for this
  --      measurement and is NOT checked into the repo: to reproduce, recreate
  --      the shape from stella_0003_suggestion_decisions.sql §1 (with stand-in
  --      parent tables for the four FK targets) and run the query above.
  --        a  pg_attrdef    default value for column decided_at
  --        a  pg_attrdef    default value for column id
  --        a  pg_class      index idx_..._interaction_id
  --        a  pg_class      index idx_..._org_decided_at            (x2 — two columns)
  --        a  pg_constraint ..._decided_by_fkey
  --        a  pg_constraint ..._decision_check
  --        a  pg_constraint ..._interaction_id_fkey
  --        a  pg_constraint ..._organization_id_fkey
  --        a  pg_constraint ..._pkey
  --        a  pg_constraint ..._prev_hash_check
  --        a  pg_constraint ..._project_id_fkey
  --        a  pg_policy     ..._select
  --        a  pg_trigger    trg_..._append_only
  --        a  pg_trigger    trg_..._no_truncate
  --        i  pg_class      toast table pg_toast.pg_toast_<oid>
  --        i  pg_type       type stella_suggestion_decisions
  --        n  pg_constraint ..._decision_check                       <-- these
  --        n  pg_constraint ..._prev_hash_check                      <-- three
  --        n  pg_policy     ..._select                               <-- fired
  --      Note the shape: the policy and both CHECKs appear TWICE — once as 'a'
  --      (the object depends on the table) and once as 'n' (its expression
  --      depends on a referenced COLUMN). A deptype='n' filter sees only the
  --      second, so the guard reported the table's own policy and both its
  --      CHECKs, and would have ABORTED EVERY RUN, empty table included —
  --      breaking the rollback outright.
  -- A third form (excluding dependents that also carry an 'a'/'i' row) tested
  -- clean, but still misses dependents mediated by the table's COMPOSITE TYPE
  -- (a function RETURNS SETOF this table records against pg_type, not
  -- pg_class). Re-deriving PostgreSQL's findDependentObjects() in SQL is not a
  -- thing this script should be doing: a guard that is only SOMETIMES right
  -- about "would the DROP fail?" is worse than none, because it invites belief.
  --
  -- The reason the pre-check was attractive was that the tempting alternative
  -- fix for the missing prefix is an `EXCEPTION WHEN` handler — and a handler
  -- in this block would swallow every guard's RAISE and let the DROP through.
  -- That temptation is closed directly instead: tests/prepared-stella-sql.test.ts
  -- forbids `EXCEPTION WHEN` outright and pins exactly one BEGIN and one RETURN.
  -- docs/ops/gates/G2_PACKAGE.md records that a dependent-object failure is one
  -- of the few aborts that will NOT carry the prefix, and that it is harmless.
  --
  -- ONE HONEST COST of removing it. The DROP is now the only failure that can
  -- happen AFTER the destruction banner, and NOTICEs are not rolled back. So on
  -- the authorised path, a dependent object leaves a log containing the full
  -- "about to DROP …" banner and "destroying N decision row(s)"
  -- for a run in which NOTHING was destroyed — exactly the "log of a refusal
  -- that reads like a log of a destruction" the guard ordering above exists to
  -- prevent. It is harmless to the DATA, not to the RECORD. Stated here rather
  -- than left for the reader to discover: if that log is ever produced, check
  -- the tail for the dependency error before concluding anything was erased.
  --
  -- The destructive act, in the SAME statement as every precondition above.
  -- Fixed literal: nothing here is composed, interpolated or read from input.
  EXECUTE 'DROP TABLE public.stella_suggestion_decisions';

  RAISE NOTICE 'stella_0003_rollback: public.stella_suggestion_decisions dropped (% row(s) destroyed). Re-running this file is now a no-op.', n_rows;
END $$;

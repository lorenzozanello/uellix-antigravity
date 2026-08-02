-- db/prepared/stella_0005b_rollback.sql
-- Reverses db/prepared/stella_0005b_admin_bootstrap.sql.
--
-- RUN AS A SUPERUSER:
--   psql "$URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/stella_0005b_rollback.sql
--
-- SCOPE. Resets exactly the role settings stella_0005b set, returns the
-- `drizzle` bookkeeping schema to `postgres`, and restores PostgreSQL's
-- built-in default for TYPES created by `postgres` in `public`.
--
-- IT DOES NOT TOUCH `default_transaction_read_only` ON `uellix_auditor`. That
-- setting is stella_0004's and predates this script; a rollback that reset it
-- would hand a read-only auditor the ability to write, which is a wider state
-- than either script ever established. `RESET ALL` is avoided here for exactly
-- that reason — it would not distinguish this script's settings from anyone
-- else's.
--
-- Idempotent and convergent.

SET search_path = public;

-- ============================================================
-- 0. Preconditions
-- ============================================================

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'stella_0005b_rollback must be applied by a superuser.';
  END IF;
END
$$;

-- ============================================================
-- 1. Reset the role settings this script's forward half applied
-- ============================================================

ALTER ROLE uellix_app RESET search_path;
ALTER ROLE uellix_app RESET statement_timeout;
ALTER ROLE uellix_app RESET idle_in_transaction_session_timeout;

ALTER ROLE uellix_migrator RESET search_path;
ALTER ROLE uellix_migrator RESET statement_timeout;
ALTER ROLE uellix_migrator RESET lock_timeout;
ALTER ROLE uellix_migrator RESET idle_in_transaction_session_timeout;

ALTER ROLE uellix_auditor RESET search_path;
ALTER ROLE uellix_auditor RESET statement_timeout;
ALTER ROLE uellix_auditor RESET idle_in_transaction_session_timeout;

-- ============================================================
-- 2. Return the drizzle bookkeeping schema to postgres
-- ============================================================

REVOKE USAGE ON SCHEMA drizzle FROM uellix_migrator;

-- ORDER IS LOAD-BEARING: the table FIRST, then the sequence.
--
-- `__drizzle_migrations_id_seq` is a SERIAL sequence, so PostgreSQL records it
-- as owned-by the table's column and refuses `ALTER SEQUENCE ... OWNER TO`
-- while that would disagree with the table's owner:
--
--     ERROR: cannot change owner of sequence "__drizzle_migrations_id_seq"
--     DETAIL: Sequence ... is linked to table "__drizzle_migrations".
--
-- Changing the TABLE's owner carries the linked sequence with it, after which
-- the explicit ALTER SEQUENCE below is a no-op that PostgreSQL short-circuits.
-- The statement is kept rather than deleted so this script still converges if
-- the schema ever gains a sequence that is NOT linked to a table.
ALTER TABLE drizzle.__drizzle_migrations OWNER TO postgres;
ALTER SEQUENCE drizzle.__drizzle_migrations_id_seq OWNER TO postgres;
ALTER SCHEMA drizzle OWNER TO postgres;

-- ============================================================
-- 3. Clear any inert schema-scoped TYPE default
-- ============================================================
-- The forward script does NOT create one — see its §3 for the two measurements
-- that show a schema-scoped TYPE default is recorded and never consulted.
--
-- These two statements are here for a narrower reason: an EARLIER revision of
-- stella_0005b did create such a row, and any stack that ran it carries a
-- `{postgres=U/postgres}` entry that closes nothing while looking like it
-- does. Restoring PUBLIC's grant makes the list match `acldefault('T')`, which
-- is the condition under which PostgreSQL deletes the row — leaving the
-- absence the current forward script asserts.
--
-- Convergent on a stack that never had the row: granting a privilege that the
-- built-in default already confers changes nothing.

-- EMPTY THE LIST, do not try to restore the default INTO it.
--
-- Two failed attempts, both measured, before this shape:
--
--   * `GRANT USAGE ON TYPES TO PUBLIC` alone leaves `{=U/postgres}` — a row
--     that persists and still differs from the built-in default;
--   * granting BOTH PUBLIC and the creator produces
--     `{=U/postgres,postgres=U/postgres}`, which IS byte-identical to
--     `acldefault('T', postgres)` — and PostgreSQL keeps the row anyway.
--
-- Revoking everything from every grantee empties the list, and an empty list is
-- the one case PostgreSQL removes. The absence of a row is what "the built-in
-- default applies" looks like in the catalog, and it is the state stella_0005b
-- asserts and the state this stack had before any of this ran.
--
-- Order matters: PUBLIC first, then the creator. The intermediate state after
-- the first statement is `{postgres=U/postgres}` — the misleading shape §3
-- warns about — so the second statement is not optional.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TYPES FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TYPES FROM postgres;

-- ============================================================
-- 4. Postconditions
-- ============================================================

DO $$
BEGIN
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'drizzle') <> 'postgres' THEN
    RAISE EXCEPTION 'Schema drizzle was not returned to postgres.';
  END IF;

  -- stella_0004's setting must have survived this rollback untouched.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_auditor' AND 'default_transaction_read_only=on' = ANY (rolconfig)
  ) THEN
    RAISE EXCEPTION
      'uellix_auditor lost default_transaction_read_only=on. That setting belongs to '
      'stella_0004 and must survive a stella_0005b rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'uellix_app' AND rolconfig IS NOT NULL AND 'search_path=public' = ANY (rolconfig)
  ) THEN
    RAISE EXCEPTION 'uellix_app still carries the pinned search_path.';
  END IF;
END
$$;

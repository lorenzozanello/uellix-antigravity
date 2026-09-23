-- tests/recovery/fixtures/recovery-fixture-source.sql
--
-- SYNTHETIC, DISPOSABLE source database for the offline recovery mechanism.
-- Every row is fabricated. The CANARY-ROW-VALUE-* strings exist so the privacy
-- tests can prove that no row content ever reaches an evidence packet: if any of
-- them appears in a BACKUP_PACKET, a RESTORE_PROOF or a destruction proof, the
-- privacy control has failed.
--
-- Shape chosen to exercise, per source-derived invariant:
--   PRI-1  relation inventory      three tables, two schemas
--   PRI-2  RR-CAP-7                a SECURITY DEFINER capability callable only
--                                  by a role that reaches schema public through
--                                  the PUBLIC USAGE grant
--   PRI-4  journal parity          uellix_provisioning.applied_units (subset of
--                                  the columns of db/prepared/journal/000_journal_bootstrap.sql)
--   PRI-5  per-relation counts     distinct counts per table
--   PRI-6  RLS                     ENABLE + FORCE on one table, with a policy
--   extra  extensions              pg_trgm, which the substrate image does NOT
--                                  pre-install, created in an in-scope schema
--   extra  sequences / identities  an IDENTITY column and a serial, advanced
--   extra  trigger enabled state   one ENABLED trigger and one DISABLED trigger

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE public.fixture_org (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label text NOT NULL
);

CREATE TABLE public.fixture_member (
  id         serial PRIMARY KEY,
  org_id     bigint NOT NULL REFERENCES public.fixture_org (id),
  display    text NOT NULL,
  created_at timestamptz
);

CREATE TABLE public.fixture_audit (
  id   bigserial PRIMARY KEY,
  note text NOT NULL
);

CREATE INDEX fixture_org_label_trgm ON public.fixture_org USING gin (label public.gin_trgm_ops);

ALTER TABLE public.fixture_org OWNER TO fixture_app_owner;
ALTER TABLE public.fixture_member OWNER TO fixture_app_owner;
ALTER TABLE public.fixture_audit OWNER TO fixture_app_owner;

-- RLS, ENABLED and FORCED: even the owner is subject to it.
ALTER TABLE public.fixture_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixture_member FORCE ROW LEVEL SECURITY;
CREATE POLICY fixture_member_owner_all ON public.fixture_member
  FOR ALL TO fixture_app_owner USING (true) WITH CHECK (true);

-- Triggers: one ENABLED, one DISABLED. pg_dump emits the DISABLE, so a correct
-- restore reproduces both states and a lossy one does not.
CREATE FUNCTION public.fixture_stamp_created_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := COALESCE(NEW.created_at, now());
  RETURN NEW;
END
$$;
ALTER FUNCTION public.fixture_stamp_created_at() OWNER TO fixture_app_owner;

CREATE TRIGGER fixture_member_stamp BEFORE INSERT ON public.fixture_member
  FOR EACH ROW EXECUTE FUNCTION public.fixture_stamp_created_at();
CREATE TRIGGER fixture_org_stamp_disabled BEFORE UPDATE ON public.fixture_org
  FOR EACH ROW EXECUTE FUNCTION public.fixture_stamp_created_at();
ALTER TABLE public.fixture_org DISABLE TRIGGER fixture_org_stamp_disabled;

-- The capability. SECURITY DEFINER, owned by the app owner, executable ONLY by
-- fixture_capability. fixture_capability holds no USAGE on schema public of its
-- own: it reaches the schema solely through GRANT USAGE ... TO PUBLIC — which is
-- exactly the RR-CAP-7 entry db/baseline/stella_g2_post_restore.sql documents.
-- It WRITES (one audit row), so the invariant runner must call it only after
-- every non-mutating check, and only inside a rolled-back transaction.
CREATE FUNCTION public.fixture_capability_probe() RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  INSERT INTO public.fixture_audit (note) VALUES ('capability-probe');
  SELECT count(*) FROM public.fixture_org;
$$;
ALTER FUNCTION public.fixture_capability_probe() OWNER TO fixture_app_owner;
REVOKE ALL ON FUNCTION public.fixture_capability_probe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fixture_capability_probe() TO fixture_capability;

-- Journal subset.
CREATE SCHEMA uellix_provisioning AUTHORIZATION fixture_app_owner;
CREATE TABLE uellix_provisioning.applied_units (
  id            bigserial PRIMARY KEY,
  package_id    text NOT NULL,
  source_sha256 text NOT NULL,
  status        text NOT NULL
);
ALTER TABLE uellix_provisioning.applied_units OWNER TO fixture_app_owner;

-- Rows. Fabricated. Distinct per-table counts (org 3, member 5, audit 2, journal 4).
INSERT INTO public.fixture_org (label) VALUES
  ('CANARY-ROW-VALUE-ORG-ALPHA-5e1c'),
  ('CANARY-ROW-VALUE-ORG-BRAVO-5e1c'),
  ('CANARY-ROW-VALUE-ORG-CHARLIE-5e1c');

SET row_security = off;
INSERT INTO public.fixture_member (org_id, display) VALUES
  (1, 'CANARY-ROW-VALUE-MEMBER-1-9b0d'),
  (1, 'CANARY-ROW-VALUE-MEMBER-2-9b0d'),
  (2, 'CANARY-ROW-VALUE-MEMBER-3-9b0d'),
  (3, 'CANARY-ROW-VALUE-MEMBER-4-9b0d'),
  (3, 'CANARY-ROW-VALUE-MEMBER-5-9b0d');
RESET row_security;

INSERT INTO public.fixture_audit (note) VALUES
  ('CANARY-ROW-VALUE-AUDIT-1-2f77'),
  ('CANARY-ROW-VALUE-AUDIT-2-2f77');

INSERT INTO uellix_provisioning.applied_units (package_id, source_sha256, status) VALUES
  ('fixture_unit_0001', repeat('a', 64), 'APPLIED'),
  ('fixture_unit_0002', repeat('b', 64), 'APPLIED'),
  ('fixture_unit_0003', repeat('c', 64), 'APPLIED'),
  ('fixture_unit_0004', repeat('d', 64), 'APPLIED');

-- The capture principal of the DISPOSABLE source. Read-only by construction:
-- pg_read_all_data (no per-object ACL entry, so nothing about it is dumped),
-- BYPASSRLS (pg_dump runs with row_security = off and must not be filtered by
-- FORCE RLS), no write privilege, not superuser. Created LAST so no fixture DDL
-- above can have been attributed to it.
CREATE ROLE recovery_capture_ro LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT pg_read_all_data TO recovery_capture_ro;

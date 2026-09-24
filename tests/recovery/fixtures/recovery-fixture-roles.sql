-- tests/recovery/fixtures/recovery-fixture-roles.sql
--
-- SYNTHETIC roles corpus for the offline recovery mechanism. Applied to the
-- disposable SOURCE cluster before the fixture schema, and to the disposable
-- RESTORE substrate before pg_restore — PostgreSQL roles are CLUSTER-scoped and
-- pg_dump of one database never emits them (PRI-3).
--
-- NOT a copy of any hosted role set. No password, no LOGIN: nothing here can
-- authenticate against anything.

CREATE ROLE fixture_app_owner NOLOGIN;
CREATE ROLE fixture_capability NOLOGIN;

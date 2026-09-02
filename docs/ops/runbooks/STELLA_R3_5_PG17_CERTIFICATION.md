# Stella R3.5 PG17 certification harness

## Purpose and boundary

`pnpm certify:stella:r3-5:pg17` is a certification-only command for the frozen
MSC-07B R3.5 candidate. It is not a production or staging migration method,
does not authorize either environment, and does not replace any human database
gate.

The command has no arguments. It does not accept SQL, package names, package
paths, phases, image names, container names, Docker options, mounts, network
settings, or database URLs. Its only profile is the one implemented in
`scripts/stella-r3-5-pg17-certify.ts`.

## Frozen authority

- Image: `public.ecr.aws/supabase/postgres:17.6.1.143`, verified against its
  frozen local image ID before a container may be created.
- Package order: `db/r3-4-governed-runner.ts:R3_4_LOCAL_PHASES` remains the
  sole order authority. The harness derives only its fixed R8 prefix through
  `stella_0004_role_separation.sql`; it does not duplicate the package order.
- Package content: `db/r3-5-pg17-certification-inputs.ts` pins the R3.5
  forward and rollback SHA-256 values. A mismatch aborts before Docker use.
- Baseline: the harness imports the existing 50-unit baseline manifest and the
  existing PG17 storage shim. It does not use
  `stella_hosted_0001_managed_role_bootstrap.sql` as local role authority.
  `stella_0001_role_topology_bootstrap.sql` remains the local authority for
  role topology and membership.
- Package grantor authority: every package (`stella_0001`, `stella_0003`,
  `stella_0004`) and the harness's own `verifyExactMembershipsAndGrantor`
  compare the canonical grantor by the fixed PostgreSQL BOOTSTRAP SUPERUSER
  OID (`10::oid`) — never by a resolved role name. The certified substrate
  fact is that OID 10 is named `supabase_admin` there, not `postgres`; that
  name is read only for diagnostics and for the harness's own superuser
  transport (below), and is never compared against as grantor authority.

## Isolation and identity

When a separately authorized live certification is run, the harness creates
exactly one named disposable container with `--network none` and `--pull
never`. It publishes no ports, uses no host network, mount, named volume,
Docker socket mount, remote database URL, or host TCP database target. In
particular, it cannot use the persistent host PostgreSQL service on port 5432.

The harness runs a preflight before any package or storage-shim execution
that fails closed unless the live substrate provides exactly the certified
facts: OID 10 is `supabase_admin` and is a superuser, and `postgres` is a
non-superuser `CREATEROLE` role. This preflight binds only the harness layer
(which package identity to log in as); it never feeds package grantor
authority, which stays the fixed OID.

Every phase runs through one of two fixed, closed transports, by a concrete
per-phase identity — never an inferred abstract "admin" identity:

- **Existing installer transport** (`docker exec` + `psql -h 127.0.0.1`, with
  a generated password): the 50-unit baseline, `stella_0002`, `stella_0002b`,
  and `stella_0003`. `stella_0003` establishes an actual `uellix_migrator`
  login session, then executes `SET LOCAL ROLE uellix_owner` inside its one
  package transaction and asserts both identities before and after the
  package.
- **Closed superuser transport** (`docker exec` + `psql`, no `-h`, therefore
  no password): the storage shim, `stella_0001`, `stella_0004`, and both
  governed rollback phases (`stella_0004_rollback`, and the
  `stella_0001_role_topology_bootstrap_rollback` dependency-guard negative),
  because each of those requires an actual superuser session — `stella_0004`
  checks `current_user` is `rolsuper`, and `stella_0001`'s own rollback checks
  `session_user` is `rolsuper`. Logging in over the local Unix socket as
  `supabase_admin` satisfies that without any `SET ROLE`. There is no
  caller-reachable generic SQL/role/container executor behind this
  transport — every call site passes only fixed, internally composed SQL.

Both governed rollback phases require the exact transaction-local
confirmation their own SQL reads via
`current_setting('uellix.rollback_confirmation', true)` — computed in the
same `-1` transaction as `set_config('uellix.rollback_confirmation',
'rollback-0004:' || current_database(), true)` (or the `rollback-0001:`
equivalent), never a caller-selectable value. The `stella_0001` rollback
attempt is exercised as a negative case: `stella_0004_rollback` runs, then
`stella_0004_role_separation` is reapplied so the dependency stella_0001's
own rollback guard checks for — surviving relations owned by `uellix_owner`
— is deliberately still present, and the harness requires the attempt to fail
with that guard's exact, stable failure text, never a generic non-zero exit.

## Certification matrix and cleanup

The fixed matrix covers the certified-substrate preflight, the PG17/Supabase
surface, storage shim, 50-unit baseline, 0001/0003/0004, topology and grantor
checks, SET/ADMIN negative attacks, RLS, append-only behavior, idempotence,
atomicity, 0004 rollback, 0001 rollback guarding, and cleanup. A package
failure aborts the later phases; there is no cross-session pseudo-transaction.

Cleanup verifies the harness ownership label and can remove only the exact
container it created. It never prunes Docker resources and has no image-removal
path. It cannot remove other containers, shared images, or host database data.

## Authorization

Running the command creates a Docker container and therefore requires an
explicit, current human authorization for that live local Docker execution.
That authorization is separate from this harness implementation and separate
from every production, staging, Supabase, Vercel, deployment, or remote
migration authorization.

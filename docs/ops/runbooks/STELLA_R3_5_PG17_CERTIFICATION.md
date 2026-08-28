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

## Isolation and identity

When a separately authorized live certification is run, the harness creates
exactly one named disposable container with `--network none` and `--pull
never`. It publishes no ports, uses no host network, mount, named volume,
Docker socket mount, remote database URL, or host TCP database target. In
particular, it cannot use the persistent host PostgreSQL service on port 5432.

The only database transport is private `docker exec` plus `psql` inside that
isolated container. The R3.5 administrative phases assert the required
container-local administrative identity. The 0003 phase establishes an actual
`uellix_migrator` login session, then executes `SET LOCAL ROLE uellix_owner`
inside its one package transaction and asserts both identities before and after
the package.

## Certification matrix and cleanup

The fixed matrix covers the PG17/Supabase surface, storage shim, 50-unit
baseline, 0001/0003/0004, topology and grantor checks, SET/ADMIN negative
attacks, RLS, append-only behavior, idempotence, atomicity, 0004 rollback,
0001 rollback guarding, and cleanup. A package failure aborts the later phases;
there is no cross-session pseudo-transaction.

Cleanup verifies the harness ownership label and can remove only the exact
container it created. It never prunes Docker resources and has no image-removal
path. It cannot remove other containers, shared images, or host database data.

## Authorization

Running the command creates a Docker container and therefore requires an
explicit, current human authorization for that live local Docker execution.
That authorization is separate from this harness implementation and separate
from every production, staging, Supabase, Vercel, deployment, or remote
migration authorization.

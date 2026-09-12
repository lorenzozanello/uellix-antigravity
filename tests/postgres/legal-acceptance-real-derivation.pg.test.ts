// tests/postgres/legal-acceptance-real-derivation.pg.test.ts
//
// CL-1 (HPO-ODS-W2-28) — independent-certification MANDATORY U-1:
// "REAL_DERIVATION_COMPOSITION_PROVEN=NO — deriveAccountAcceptanceCurrent and
// loadRequiredInstrumentsPendingAcceptance are only exercised via mocks in
// unit tests, and the real-Postgres suite re-implements their SQL as literal
// strings rather than executing the actual exported production functions
// against the disposable database (a twin-oracle gap)."
//
// This file closes that gap. Unlike legal-acceptance.pg.test.ts (which
// drives the CANONICAL disposable harness scripts/db-audit-disposable.ts —
// a fully synchronous, psql-only lifecycle with no live application-level
// connection), this suite orchestrates its OWN disposable container using
// the SAME safety-checked primitives that harness already exports
// (realDockerRunner, parseAssignedPort, hasOnlyAcceptableMounts, DEFAULT_IMAGE)
// plus db/safety/disposable-audit-target.ts's identity generation and target
// safety gate — because proving REAL_DERIVATION_COMPOSITION requires a live
// postgres-js/drizzle connection open WHILE the container is alive, which the
// synchronous harness's own CREATE -> APPLY -> PROBE -> DESTROY lifecycle
// (torn down before runDisposableHarness() ever returns) has no way to hand
// out. scripts/db-audit-disposable.ts itself is NOT modified — this is a
// second, independent, equally-disposable lifecycle, not a change to the
// shared one every other tests/postgres/*.pg.test.ts file also uses.
//
// WHAT RUNS FOR REAL, THROUGH A REAL uellix_app LOGIN (not `SET LOCAL ROLE`
// from a superuser session): lib/auth/legal-acceptance.ts's
// deriveAccountAcceptanceCurrent(userId) and
// loadRequiredInstrumentsPendingAcceptance(userId), called through the REAL
// db/identity-context.ts withDatabaseIdentityContext, against the SAME
// fixture buildSetupManifest() (tests/postgres/legal-acceptance-fixtures.ts)
// legal-acceptance.pg.test.ts also builds its disposable database from —
// never a parallel, hand-authored substrate. That fixture module carries no
// `describe()` of its own, so importing it (unlike importing
// legal-acceptance.pg.test.ts directly) registers no second copy of that
// file's own probe suite here.
//
// ORDERING IS LOAD-BEARING. legal_instrument_versions.version is a GLOBAL
// per-key fact: "the greatest EFFECTIVE version" is whatever the table holds
// at QUERY time, not at whichever earlier moment a test happened to seed it.
// Publishing a new, greater version retroactively changes what every LATER
// query resolves to for that key — so each scenario below publishes its own
// version(s) immediately before it queries, strictly after the base-fixture
// checks that depend on the base fixture's own greatest version (v4), and
// each new version number is monotonically greater than the last so no two
// scenarios can interfere with each other regardless of declaration order.

import { randomUUID, randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  realDockerRunner,
  parseAssignedPort,
  hasOnlyAcceptableMounts,
  DEFAULT_IMAGE,
} from '../../scripts/db-audit-disposable'
import { generateDisposableIdentity, assertDisposableTargetSafe } from '../../db/safety/disposable-audit-target'
import { createDatabaseClient, type DatabaseClient } from '@/db/client'
import { withDatabaseIdentityContext } from '@/db/identity-context'
import {
  deriveAccountAcceptanceCurrent,
  loadRequiredInstrumentsPendingAcceptance,
  computeSelfDescribingDigest,
} from '@/lib/auth/legal-acceptance'
import { buildSetupManifest, buildBaselineOnlyStatements, IDS, asUser, DIGEST_V2, DIGEST_PRIVACY_V1 } from './legal-acceptance-fixtures'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const EXTRA_IDS = {
  uSuperseded: '0c110000-0000-4000-8000-0000000000b1',
  uPreEffective: '0c110000-0000-4000-8000-0000000000b2',
  uUnpresentableDigest: '0c110000-0000-4000-8000-0000000000b3',
  uUnpresentableNull: '0c110000-0000-4000-8000-0000000000b4',
} as const

// v5 is published once (by the "superseded" test) and then referenced again
// by the "pre-effective" test's own acceptance insert — a single shared
// constant keeps the two in sync rather than risking two independently
// hand-typed digests drifting apart.
const V5_TEXT = 'CL-1 real-derivation fixture — v5, the superseding version.'
const V5_DIGEST = computeSelfDescribingDigest(V5_TEXT)

function insertExtraUserSql(id: string, email: string): string {
  return `
INSERT INTO auth.users (id, email) VALUES ('${id}','${email}') ON CONFLICT (id) DO NOTHING;
INSERT INTO public.users (id, email, is_super_admin) VALUES ('${id}','${email}',false) ON CONFLICT (id) DO NOTHING;
`
}

/**
 * Provisions ONE disposable Postgres container (never in parallel with
 * another — each describe block below awaits this in its own beforeAll, and
 * vitest runs describe blocks within a file sequentially), applies the given
 * setup statements, and returns a real, authenticated `uellix_app` client
 * plus the raw psql-exec helpers every scenario needs for its own further
 * progressive fixture mutation. The caller owns teardown (afterAll) via the
 * returned `containerName`.
 */
async function provisionDisposableContainer(setupStatements: string[]): Promise<{
  containerName: string
  dbName: string
  client: DatabaseClient
  applySql: (statement: string) => void
}> {
  const identity = generateDisposableIdentity(randomUUID)
  const containerName = identity.containerName
  const dbName = identity.dbName
  const postgresPassword = randomBytes(24).toString('hex')
  const appPassword = randomBytes(24).toString('hex')

  function psql(statement: string): { status: number; stdout: string; stderr: string } {
    return realDockerRunner.run(
      ['exec', '-i', containerName, 'psql', '-U', 'postgres', '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-q'],
      statement
    )
  }
  function applySql(statement: string): void {
    const res = psql(statement)
    expect(res.status, `statement failed: ${res.stderr || res.stdout}\n---\n${statement}`).toBe(0)
  }

  const created = realDockerRunner.run([
    'run', '-d', '--name', containerName, '-p', '127.0.0.1:0:5432',
    '-e', `POSTGRES_PASSWORD=${postgresPassword}`,
    '-e', 'POSTGRES_HOST_AUTH_METHOD=password',
    '-e', 'POSTGRES_DB=postgres',
    DEFAULT_IMAGE,
  ])
  expect(created.status, `docker run failed: ${created.stderr || created.stdout}`).toBe(0)

  const mounts = realDockerRunner.run(['inspect', '-f', '{{json .Mounts}}', containerName])
  expect(mounts.status).toBe(0)
  expect(hasOnlyAcceptableMounts(mounts.stdout), `unexpected mount: ${mounts.stdout}`).toBe(true)

  let ready = false
  for (let i = 0; i < 40; i++) {
    const check = realDockerRunner.run(['exec', containerName, 'pg_isready', '-U', 'postgres'])
    if (check.status === 0) { ready = true; break }
    await sleep(250)
  }
  expect(ready, 'disposable container never reported ready').toBe(true)

  const portResult = realDockerRunner.run(['port', containerName, '5432/tcp'])
  expect(portResult.status).toBe(0)
  const port = parseAssignedPort(portResult.stdout)
  expect(port, `could not parse assigned port from: ${portResult.stdout}`).not.toBeNull()

  const adminUrl = `postgresql://postgres:${postgresPassword}@127.0.0.1:${port}/postgres`
  const adminCheck = assertDisposableTargetSafe(adminUrl, { requireDisposableDbName: false })
  expect(adminCheck.ok, adminCheck.reason ?? '').toBe(true)

  const createDb = realDockerRunner.run(['exec', '-i', containerName, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', `CREATE DATABASE ${dbName};`])
  expect(createDb.status, `CREATE DATABASE failed: ${createDb.stderr || createDb.stdout}`).toBe(0)

  const finalUrl = `postgresql://postgres:${postgresPassword}@127.0.0.1:${port}/${dbName}`
  const finalCheck = assertDisposableTargetSafe(finalUrl, { expectDatabaseName: dbName })
  expect(finalCheck.ok, finalCheck.reason ?? '').toBe(true)

  for (const statement of [...setupStatements, `ALTER ROLE uellix_app WITH LOGIN PASSWORD '${appPassword}';`]) {
    applySql(statement)
  }

  const appUrl = `postgresql://uellix_app:${appPassword}@127.0.0.1:${port}/${dbName}`
  const client = createDatabaseClient({
    connectionString: appUrl,
    capability: 'local_integration_test',
    expectedLocalPort: port!,
  })

  return { containerName, dbName, client, applySql }
}

function teardownDisposableContainer(containerName: string | undefined): void {
  if (containerName) realDockerRunner.run(['rm', '-f', '-v', containerName])
}

// D-7: an ungated self-check, modeled on tests/postgres/s3refusal-completeness
// .pg.test.ts's own — runs whether or not Docker is present, so a CI gate
// that sets UELLIX_CL1_PG_REQUIRED=1 alongside UELLIX_PG_TESTS=1 gets a real
// FAILURE (not a silent green skip) if the real-Postgres suites below never
// actually ran.
describe('CL-1 real-PostgreSQL composition gate self-check (never skipped)', () => {
  it('is not silently skipped when the governed CI gate demands it', () => {
    if (process.env.UELLIX_CL1_PG_REQUIRED === '1') {
      expect(
        PG_TESTS_ENABLED,
        'UELLIX_CL1_PG_REQUIRED=1 but UELLIX_PG_TESTS is not 1: the real-derivation-composition ' +
          'suite (U-1) would have been skipped, and a skipped suite is not evidence.'
      ).toBe(true)
    }
  })
})

describe.skipIf(!PG_TESTS_ENABLED)('CL-1 legal acceptance — REAL derivation composition (U-1)', { timeout: 900_000 }, () => {
  let containerName: string
  let client: DatabaseClient
  let applySql: (statement: string) => void

  async function asPrincipal<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return withDatabaseIdentityContext({ userId, organizationId: null, isSuperAdmin: false }, () => fn(), { client })
  }

  beforeAll(async () => {
    // The EXACT SAME baseline + tenant fixture legal-acceptance.pg.test.ts
    // uses (BASELINE_UNITS through 0071, roles, hosted fidelity, T1/T2/T3
    // seed) — this suite needs a REAL authenticated uellix_app connection
    // (provisionDisposableContainer adds the login password), which is the
    // entire point of the composition proof.
    const provisioned = await provisionDisposableContainer(buildSetupManifest().statements)
    containerName = provisioned.containerName
    client = provisioned.client
    applySql = provisioned.applySql
  }, 900_000)

  afterAll(async () => {
    if (client) await client.close()
    teardownDisposableContainer(containerName)
  })

  it('the disposable container is up and the real uellix_app login is authenticated (not a superuser SET ROLE)', async () => {
    const rows = (await client.sql`SELECT current_user AS u, session_user AS s`) as unknown as { u: string; s: string }[]
    expect(rows[0].u).toBe('uellix_app')
    expect(rows[0].s).toBe('uellix_app')
  })

  // --- Base fixture (buildSetupManifest()'s own u1/u2/u3), read while
  // terms_of_service's greatest effective version is still v4 (SYNTHETIC,
  // valid) — the shared fixture's own steady state. -----------------------

  it('REAL deriveAccountAcceptanceCurrent: a subject with zero acceptances is never current (no-acceptance case)', async () => {
    const current = await asPrincipal(IDS.u1, () => deriveAccountAcceptanceCurrent(IDS.u1))
    expect(current).toBe(false)
  })

  // privacy_policy's ONE version in the shared fixture carries NULL
  // content_bytes (it was seeded for the currency-predicate suite, not the
  // presentation-binding one) — so it is STRUCTURALLY never presentable, for
  // ANY subject, in this fixture. Established empirically against the real
  // function, not assumed: an earlier version of this test wrongly expected
  // both keys and the real run corrected it.
  it('REAL loadRequiredInstrumentsPendingAcceptance: a subject with zero acceptances is offered the one presentable required key (terms_of_service v4) — privacy_policy has no presentable version in this fixture', async () => {
    const pending = await asPrincipal(IDS.u1, () => loadRequiredInstrumentsPendingAcceptance(IDS.u1))
    expect(pending.map((p) => p.instrumentKey)).toEqual(['terms_of_service'])
    expect(pending[0].version).toBe(4)
    expect(pending[0].content.length).toBeGreaterThan(0)
  })

  it('REAL deriveAccountAcceptanceCurrent: current on the latest EFFECTIVE version of both required keys is TRUE (full current acceptance)', async () => {
    const current = await asPrincipal(IDS.u2, () => deriveAccountAcceptanceCurrent(IDS.u2))
    expect(current).toBe(true)
  })

  // U-1's real run surfaces a genuine, load-bearing property no mocked test
  // or literal-SQL probe had exercised: loadRequiredInstrumentsPendingAcceptance
  // is NOT gated by currency. u2 accepted v2 specifically (which currency
  // treats as current, since v4 is unmarked and never supersedes it) — but
  // v4 is a DIFFERENT version id u2 has never accepted, and the resolver
  // offers it regardless of the subject's currency state. In real usage this
  // is inert: page.tsx (app/(public)/accept-legal/page.tsx) never calls this
  // resolver for a subject whose accountAcceptanceCurrent is already true —
  // it redirects away first. This control exists so that guarantee is
  // pinned explicitly, not merely assumed from reading page.tsx.
  it('REAL loadRequiredInstrumentsPendingAcceptance: a CURRENT subject can still be offered a DIFFERENT, independently-unaccepted version — pending is decoupled from currency (real, not mocked)', async () => {
    const pending = await asPrincipal(IDS.u2, () => loadRequiredInstrumentsPendingAcceptance(IDS.u2))
    expect(pending.map((p) => p.instrumentKey)).toEqual(['terms_of_service'])
    expect(pending[0].version).toBe(4)
    expect(pending[0].instrumentVersionId).not.toBe('0c110000-0000-4000-8000-0000000010a2') // not the v2 u2 actually accepted
  })

  it('REAL deriveAccountAcceptanceCurrent: accepted only terms v1, superseded by v2 — refused (partial acceptance / superseded acceptance)', async () => {
    const current = await asPrincipal(IDS.u3, () => deriveAccountAcceptanceCurrent(IDS.u3))
    expect(current).toBe(false)
  })

  it('REAL loadRequiredInstrumentsPendingAcceptance: u3 (accepted only v1) is offered terms_of_service v4, not v1 or v2 — the greatest effective version they have not specifically accepted', async () => {
    const pending = await asPrincipal(IDS.u3, () => loadRequiredInstrumentsPendingAcceptance(IDS.u3))
    expect(pending.map((p) => p.instrumentKey)).toEqual(['terms_of_service'])
    expect(pending[0].version).toBe(4)
  })

  // --- Progressive registry mutations. Each scenario publishes strictly
  // GREATER version numbers than every prior scenario, immediately before
  // querying, so no earlier assertion above (or below) can be invalidated by
  // "the greatest effective version" having moved. --------------------------

  it('REAL: a version accepted while current becomes SUPERSEDED once a later marked+effective version publishes — currency flips true -> false with no new write from the subject', async () => {
    applySql(insertExtraUserSql(EXTRA_IDS.uSuperseded, 'usup-cl1@pg.local'))
    applySql(
      asUser(EXTRA_IDS.uSuperseded) +
        `INSERT INTO public.account_legal_acceptances (id, user_id, instrument_version_id, content_digest) VALUES
      (gen_random_uuid(), '${EXTRA_IDS.uSuperseded}', '0c110000-0000-4000-8000-0000000010a2', '${DIGEST_V2}'),
      (gen_random_uuid(), '${EXTRA_IDS.uSuperseded}', '0c110000-0000-4000-8000-0000000010b1', '${DIGEST_PRIVACY_V1}');
    COMMIT;`
    )
    // v5: GREATER than v2/v3/v4, marked reaccept_required, already effective,
    // with REAL presentable content (matching digest) — so the pending
    // assertion below observes v5 surfacing on its own merits, not an
    // artifact of NULL content_bytes falling through to something else.
    applySql(`
      INSERT INTO public.legal_instrument_versions
        (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
      VALUES
        ('0c110000-0000-4000-8000-0000000010a5', 'terms_of_service', 5, 'es', '${V5_DIGEST}', '${V5_TEXT.replace(/'/g, "''")}', true, now() - interval '1 hour', '${IDS.uSA}', now() - interval '1 hour');
    `)

    const current = await asPrincipal(EXTRA_IDS.uSuperseded, () => deriveAccountAcceptanceCurrent(EXTRA_IDS.uSuperseded))
    expect(current).toBe(false)
    const pending = await asPrincipal(EXTRA_IDS.uSuperseded, () => loadRequiredInstrumentsPendingAcceptance(EXTRA_IDS.uSuperseded))
    expect(pending.map((p) => p.instrumentKey)).toEqual(['terms_of_service'])
    expect(pending[0].version).toBe(5)
  })

  it('REAL: a newer required version that is NOT YET effective never disturbs currency (pre-effective non-refusal)', async () => {
    applySql(insertExtraUserSql(EXTRA_IDS.uPreEffective, 'upre-cl1@pg.local'))
    applySql(
      asUser(EXTRA_IDS.uPreEffective) +
        `INSERT INTO public.account_legal_acceptances (id, user_id, instrument_version_id, content_digest) VALUES
      (gen_random_uuid(), '${EXTRA_IDS.uPreEffective}', '0c110000-0000-4000-8000-0000000010a5', '${V5_DIGEST}'),
      (gen_random_uuid(), '${EXTRA_IDS.uPreEffective}', '0c110000-0000-4000-8000-0000000010b1', '${DIGEST_PRIVACY_V1}');
    COMMIT;`
    )
    // v6: GREATER than v5 (the version uPreEffective just accepted), marked
    // reaccept_required, but effective 365 days in the future.
    applySql(`
      INSERT INTO public.legal_instrument_versions
        (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
      VALUES
        ('0c110000-0000-4000-8000-0000000010a6', 'terms_of_service', 6, 'es', 'sha256:${'6'.repeat(64)}', NULL, true, now() + interval '365 days', '${IDS.uSA}', now());
    `)

    const current = await asPrincipal(EXTRA_IDS.uPreEffective, () => deriveAccountAcceptanceCurrent(EXTRA_IDS.uPreEffective))
    expect(current).toBe(true)

    // NOT "nothing pending": v4 — a DIFFERENT, older, still-effective version
    // uPreEffective never specifically accepted — legitimately resurfaces
    // here for the SAME reason it did for u2/u3 above (pending is scoped to
    // the exact accepted version id, not "any version at or above what
    // currency requires"). The one thing THIS control is about is that v6
    // itself — not yet effective — can never be the thing offered.
    const pending = await asPrincipal(EXTRA_IDS.uPreEffective, () => loadRequiredInstrumentsPendingAcceptance(EXTRA_IDS.uPreEffective))
    expect(pending.some((p) => p.version === 6), 'a not-yet-effective version must never be offered for acceptance').toBe(false)
    expect(pending.map((p) => p.instrumentKey)).toEqual(['terms_of_service'])
    expect(pending[0].version).toBe(4)
  })

  it('REAL: no fallback to an older, valid version when the greatest EFFECTIVE version fails digest verification (invalid content digest)', async () => {
    applySql(insertExtraUserSql(EXTRA_IDS.uUnpresentableDigest, 'udig-cl1@pg.local'))
    const validOlderText = 'CL-1 real-derivation fixture — v7, older, VALID, presentable.'
    const validOlderDigest = computeSelfDescribingDigest(validOlderText)
    // v7: valid, older, presentable. v8: GREATER, unmarked (does not disturb
    // anyone's currency), effective, but content_bytes does NOT match
    // content_digest.
    applySql(`
      INSERT INTO public.legal_instrument_versions
        (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
      VALUES
        ('0c110000-0000-4000-8000-0000000010a7', 'terms_of_service', 7, 'es', '${validOlderDigest}', '${validOlderText.replace(/'/g, "''")}', false, now() - interval '2 hours', '${IDS.uSA}', now() - interval '2 hours'),
        ('0c110000-0000-4000-8000-0000000010a8', 'terms_of_service', 8, 'es', 'sha256:${'8'.repeat(64)}', 'these bytes do not hash to the declared digest', false, now() - interval '1 hour', '${IDS.uSA}', now() - interval '1 hour');
    `)

    const pending = await asPrincipal(EXTRA_IDS.uUnpresentableDigest, () => loadRequiredInstrumentsPendingAcceptance(EXTRA_IDS.uUnpresentableDigest))
    expect(pending.find((p) => p.instrumentKey === 'terms_of_service'), 'terms_of_service must be excluded, not offered as v8').toBeUndefined()
    expect(pending.some((p) => p.version === 7), 'must not fall back to the older, valid v7').toBe(false)
  })

  it('REAL: no fallback to an older, valid version when the greatest EFFECTIVE version has NULL content_bytes (absent content)', async () => {
    applySql(insertExtraUserSql(EXTRA_IDS.uUnpresentableNull, 'unul-cl1@pg.local'))
    const validOlderText = 'CL-1 real-derivation fixture — v9, older, VALID, presentable.'
    const validOlderDigest = computeSelfDescribingDigest(validOlderText)
    // v9: valid, older, presentable. v10: GREATER, unmarked, effective, but
    // content_bytes is NULL — never published/retained.
    applySql(`
      INSERT INTO public.legal_instrument_versions
        (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
      VALUES
        ('0c110000-0000-4000-8000-0000000010a9', 'terms_of_service', 9, 'es', '${validOlderDigest}', '${validOlderText.replace(/'/g, "''")}', false, now() - interval '2 hours', '${IDS.uSA}', now() - interval '2 hours'),
        ('0c110000-0000-4000-8000-0000000010aa', 'terms_of_service', 10, 'es', 'sha256:${'9'.repeat(64)}', NULL, false, now() - interval '1 hour', '${IDS.uSA}', now() - interval '1 hour');
    `)

    const pending = await asPrincipal(EXTRA_IDS.uUnpresentableNull, () => loadRequiredInstrumentsPendingAcceptance(EXTRA_IDS.uUnpresentableNull))
    expect(pending.find((p) => p.instrumentKey === 'terms_of_service'), 'terms_of_service must be excluded, not offered as v10').toBeUndefined()
    expect(pending.some((p) => p.version === 9), 'must not fall back to the older, valid v9').toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A SEPARATE disposable container (never running concurrently with the one
// above — vitest runs describe blocks within one file sequentially, and this
// one's beforeAll only starts once the first block's afterAll has torn its
// container down) for the two scenarios that CANNOT share a database with
// buildSetupManifest()'s tenant fixture: that fixture publishes versions for
// BOTH required keys before any test ever runs, and legal_instruments /
// legal_instrument_versions are append-only (RLS write-closed, plus a
// BEFORE UPDATE OR DELETE trigger enforcing it even for the postgres
// superuser) — so a registry that starts with published versions can never
// be made empty again on the SAME database. This container instead applies
// only the baseline schema/roles/policies, never the tenant fixture, so the
// required-instrument registry genuinely starts with zero published
// versions for either key.
// ---------------------------------------------------------------------------

const FRESH_SUBJECT = '0c110000-0000-4000-8000-0000000000c1'

describe.skipIf(!PG_TESTS_ENABLED)('CL-1 legal acceptance — REAL derivation composition (U-1): empty and partial registry', { timeout: 900_000 }, () => {
  let containerName: string
  let client: DatabaseClient
  let applySql: (statement: string) => void

  async function asFreshSubject<T>(fn: () => Promise<T>): Promise<T> {
    return withDatabaseIdentityContext({ userId: FRESH_SUBJECT, organizationId: null, isSuperAdmin: false }, () => fn(), { client })
  }

  beforeAll(async () => {
    // Baseline schema/roles/policies ONLY — no legal_instruments,
    // legal_instrument_versions or account_legal_acceptances rows. The
    // registry genuinely starts empty; this is NOT achievable on the other
    // describe block's container (see the comment above).
    const provisioned = await provisionDisposableContainer(buildBaselineOnlyStatements())
    containerName = provisioned.containerName
    client = provisioned.client
    applySql = provisioned.applySql
    applySql(insertExtraUserSql(FRESH_SUBJECT, 'fresh-cl1@pg.local'))
  }, 900_000)

  afterAll(async () => {
    if (client) await client.close()
    teardownDisposableContainer(containerName)
  })

  it('REAL deriveAccountAcceptanceCurrent: an EMPTY registry (zero published versions for either required key) refuses — fail closed, never vacuously true', async () => {
    const current = await asFreshSubject(() => deriveAccountAcceptanceCurrent(FRESH_SUBJECT))
    expect(current).toBe(false)
  })

  it('REAL loadRequiredInstrumentsPendingAcceptance: an EMPTY registry offers nothing (not an error, not a partial form)', async () => {
    const pending = await asFreshSubject(() => loadRequiredInstrumentsPendingAcceptance(FRESH_SUBJECT))
    expect(pending).toEqual([])
  })

  it('REAL: declaring the instruments (T1) with STILL zero published versions (T2) changes nothing — still an empty registry', async () => {
    applySql(`
      INSERT INTO public.legal_instruments (instrument_key, instrument_class) VALUES
        ('terms_of_service', 'ACCOUNT'), ('privacy_policy', 'ACCOUNT');
    `)
    const current = await asFreshSubject(() => deriveAccountAcceptanceCurrent(FRESH_SUBJECT))
    expect(current).toBe(false)
    const pending = await asFreshSubject(() => loadRequiredInstrumentsPendingAcceptance(FRESH_SUBJECT))
    expect(pending).toEqual([])
  })

  it('REAL: a PARTIAL registry (one required key published, the other still has zero versions) still refuses the WHOLE conjunction, but offers the one presentable key', async () => {
    const text = 'CL-1 real-derivation fixture — partial registry, terms_of_service v1.'
    const digest = computeSelfDescribingDigest(text)
    applySql(`
      INSERT INTO public.legal_instrument_versions
        (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
      VALUES
        ('0c110000-0000-4000-8000-00000000e0a1', 'terms_of_service', 1, 'es', '${digest}', '${text.replace(/'/g, "''")}', false, NULL, (SELECT id FROM public.users LIMIT 1), now());
    `)
    // privacy_policy has ZERO published versions — the registry remains
    // PARTIAL, not complete.
    const current = await asFreshSubject(() => deriveAccountAcceptanceCurrent(FRESH_SUBJECT))
    expect(current, 'a partial registry must refuse the whole conjunction, not just the unpublished key').toBe(false)

    const pending = await asFreshSubject(() => loadRequiredInstrumentsPendingAcceptance(FRESH_SUBJECT))
    expect(pending.map((p) => p.instrumentKey)).toEqual(['terms_of_service'])
    expect(pending[0].content).toBe(text)
  })

  // D-6: two rows can legitimately share the SAME instrument_key and version
  // in DIFFERENT locales (the unique index is on all three columns together).
  // Before the fix, DISTINCT ON's tie-break for "the greatest version" was
  // unspecified across such a pair. This proves the REAL resolver now
  // resolves to the exact same row deterministically, repeatedly, rather
  // than merely "some" row each time.
  it('REAL: two versions sharing the SAME instrument_key and version number in DIFFERENT locales resolve deterministically, not to an unspecified tied row', async () => {
    const esText = 'CL-1 real-derivation fixture — privacy_policy v1, locale es.'
    const enText = 'CL-1 real-derivation fixture — privacy_policy v1, locale en.'
    applySql(`
      INSERT INTO public.legal_instrument_versions
        (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
      VALUES
        ('0c110000-0000-4000-8000-00000000e0b1', 'privacy_policy', 1, 'es', '${computeSelfDescribingDigest(esText)}', '${esText.replace(/'/g, "''")}', false, NULL, (SELECT id FROM public.users LIMIT 1), now()),
        ('0c110000-0000-4000-8000-00000000e0b2', 'privacy_policy', 1, 'en', '${computeSelfDescribingDigest(enText)}', '${enText.replace(/'/g, "''")}', false, NULL, (SELECT id FROM public.users LIMIT 1), now());
    `)

    const first = await asFreshSubject(() => loadRequiredInstrumentsPendingAcceptance(FRESH_SUBJECT))
    const second = await asFreshSubject(() => loadRequiredInstrumentsPendingAcceptance(FRESH_SUBJECT))
    const privacyFirst = first.find((p) => p.instrumentKey === 'privacy_policy')
    const privacySecond = second.find((p) => p.instrumentKey === 'privacy_policy')
    expect(privacyFirst, 'exactly one privacy_policy candidate must be offered, not zero and not two').toBeDefined()
    expect(privacySecond?.instrumentVersionId).toBe(privacyFirst?.instrumentVersionId)
    expect(privacySecond?.locale).toBe(privacyFirst?.locale)
  })
})

// tests/postgres/organization-commercial-acceptance-real-derivation.pg.test.ts
//
// L1 (HPO-ODS-W2-29) — ORACLE 2: REAL PRODUCTION-FUNCTION COMPOSITION.
//
// TWIN_ORACLE_REQUIRED is binding and neither oracle substitutes for the
// other. Oracle 1 (organization-commercial-acceptance.pg.test.ts) proves THE
// DATABASE IS CORRECT and says nothing about whether the application reaches
// it. This file proves THE COMPOSITION IS CORRECT: the ACTUAL EXPORTED
// functions lib/auth/organization-commercial-acceptance.ts ships —
// deriveOrganizationAcceptanceCurrent and
// loadRequiredOrganizationInstrumentsPendingAcceptance — executed through the
// REAL db/identity-context.ts withDatabaseIdentityContext against a REAL,
// AUTHENTICATED uellix_app LOGIN (not `SET LOCAL ROLE` from a superuser
// session), under FORCE RLS.
//
// WHY IT PROVISIONS ITS OWN CONTAINER rather than reusing the canonical
// synchronous harness: proving REAL_DERIVATION_COMPOSITION requires a live
// postgres-js/drizzle connection open WHILE the container is alive, and
// scripts/db-audit-disposable.ts's CREATE -> APPLY -> PROBE -> DESTROY
// lifecycle is torn down before runDisposableHarness() ever returns. This is a
// SECOND, independent, equally-disposable lifecycle built from the SAME
// safety-checked primitives that harness already exports — never a
// modification of the shared one, and never a second substrate: the fixture
// module is the one Oracle 1 also builds from.
//
// MUT-L1-permissive-catch-on-the-currency-query IS THE REASON THIS FILE
// EXISTS. FAIL_CLOSED.FC_6 identifies a try/catch around the currency query
// whose catch branch returns a permissive value as the single most likely way
// the whole model is defeated, and it is INVISIBLE to any suite that never
// makes the query fail. Only a REAL connection can be made to fail. The last
// describe block below does exactly that.

import { randomUUID, randomBytes } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  realDockerRunner,
  parseAssignedPort,
  hasOnlyAcceptableMounts,
  DEFAULT_IMAGE,
} from '../../scripts/db-audit-disposable'
import { generateDisposableIdentity, assertDisposableTargetSafe } from '../../db/safety/disposable-audit-target'
import { sql as drizzleSql } from 'drizzle-orm'
import { createDatabaseClient, db, type DatabaseClient } from '@/db/client'
import { withDatabaseIdentityContext } from '@/db/identity-context'
import {
  deriveOrganizationAcceptanceCurrent,
  loadRequiredOrganizationInstrumentsPendingAcceptance,
  ORGANIZATION_REQUIRED_INSTRUMENT_KEYS,
} from '@/lib/auth/organization-commercial-acceptance'
import { computeSelfDescribingDigest } from '@/lib/auth/legal-acceptance'
import {
  IDS,
  ORG_V1_DIGEST,
  buildSetupManifest,
  buildSetupManifestWithAcceptances,
  buildBaselineOnlyStatements,
} from './organization-commercial-acceptance-fixtures'

export const PG_TESTS_ENABLED = process.env.UELLIX_PG_TESTS === '1'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Provisions ONE disposable Postgres container, applies the given setup
 * statements, and returns a real, AUTHENTICATED `uellix_app` client plus the
 * raw psql-exec helper each scenario needs for further fixture mutation. The
 * caller owns teardown via the returned containerName.
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

  const createDb = realDockerRunner.run([
    'exec', '-i', containerName, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c',
    `CREATE DATABASE ${dbName};`,
  ])
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

/* -------------------------------------------------------------------------- */
/* S-L1-PG-REQUIRED-ANTI-SKIP — UNGATED, never skipped                        */
/* -------------------------------------------------------------------------- */

describe('L1 real-PostgreSQL gate self-check (never skipped)', () => {
  it('is not silently skipped when the governed CI gate demands it', () => {
    // THE MEASURED HAZARD: the disposable-harness `setupStatus` value SKIPPED
    // is ALSO its INITIALIZATION value, so a harness that bailed out before
    // setup reports the same value as one that deliberately skipped — and a
    // skipped real-PG suite otherwise reads as GREEN in a bare checkmark.
    // This `it` is OUTSIDE every describe.skipIf in this file and in its
    // sibling, so it runs whether or not Docker is present, and it FAILS when
    // the gate asked for PostgreSQL and PostgreSQL was not there.
    // --passWithNoTests is prohibited for the same reason.
    if (process.env.UELLIX_L1_PG_REQUIRED === '1') {
      expect(
        PG_TESTS_ENABLED,
        'UELLIX_L1_PG_REQUIRED=1 but UELLIX_PG_TESTS is not 1: the L1 real-PostgreSQL suites ' +
          'would have been skipped, and a skipped suite is not evidence.'
      ).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* ORACLE 2 — the real exported functions                                      */
/* -------------------------------------------------------------------------- */

describe.skipIf(!PG_TESTS_ENABLED)(
  'L1 organization commercial acceptance — REAL derivation composition',
  { timeout: 900_000 },
  () => {
    let containerName: string
    let client: DatabaseClient
    let applySql: (statement: string) => void

    /** Runs `fn` under a REAL organisation-scoped identity context for `userId`. */
    async function asScopedPrincipal<T>(userId: string, organizationId: string, fn: () => Promise<T>): Promise<T> {
      return withDatabaseIdentityContext({ userId, organizationId, isSuperAdmin: false }, () => fn(), { client })
    }

    beforeAll(async () => {
      // The EXACT SAME baseline + tenant fixture Oracle 1 builds from,
      // including Org C's acceptance — which the fixture writes THROUGH RLS as
      // the accepting admin, because it is the only way this table can be
      // written. A psql-as-postgres insert is REFUSED by the 0072 trigger
      // (auth.uid() is NULL there), which is the property working rather than
      // a harness problem, and is why the HISTORY control below reads the
      // fixture's row instead of creating its own.
      const provisioned = await provisionDisposableContainer(buildSetupManifestWithAcceptances().statements)
      containerName = provisioned.containerName
      client = provisioned.client
      applySql = provisioned.applySql
    }, 900_000)

    afterAll(async () => {
      if (client) await client.close()
      teardownDisposableContainer(containerName)
    })

    it('the connection is a REAL authenticated uellix_app login, not a superuser SET ROLE', async () => {
      const rows = (await client.sql`SELECT current_user AS u, session_user AS s`) as unknown as { u: string; s: string }[]
      expect(rows[0].u).toBe('uellix_app')
      expect(rows[0].s).toBe('uellix_app')
    })

    it('the CLOSED REQUIRED ORGANIZATION-CLASS set has cardinality ONE and its key is ORGANIZATION-class', async () => {
      expect(ORGANIZATION_REQUIRED_INSTRUMENT_KEYS).toHaveLength(1)
      // READ THROUGH THE BOUND HANDLE, not through client.sql. client.sql is
      // the RAW pool handle and takes a DIFFERENT connection from the one
      // withDatabaseIdentityContext set the claims on, so auth.uid() is NULL
      // there and the legal_instruments SELECT policy correctly returns
      // nothing. A probe that read through it would measure an empty registry
      // and conclude the fixture was broken.
      const key = ORGANIZATION_REQUIRED_INSTRUMENT_KEYS[0]
      const rows = (await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        db.execute(drizzleSql`SELECT instrument_class FROM legal_instruments WHERE instrument_key = ${key}`)
      )) as unknown as { instrument_class: string }[]
      expect(rows[0].instrument_class).toBe('ORGANIZATION')
    })

    /* --- the currency predicate, for real ---------------------------------- */

    it('REAL deriveOrganizationAcceptanceCurrent: an organisation with ZERO acceptances is NOT current', async () => {
      expect(await asScopedPrincipal(IDS.adminA, IDS.orgA, () => deriveOrganizationAcceptanceCurrent(IDS.orgA))).toBe(false)
    })

    it('REAL loadRequiredOrganizationInstrumentsPendingAcceptance: offers the ONE presentable required version', async () => {
      const pending = await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        loadRequiredOrganizationInstrumentsPendingAcceptance(IDS.orgA)
      )
      expect(pending.map((p) => p.instrumentKey)).toEqual(['commercial_terms'])
      expect(pending[0].version).toBe(1)
      expect(pending[0].instrumentVersionId).toBe(IDS.orgVersionV1)
      expect(pending[0].contentDigest).toBe(ORG_V1_DIGEST)
      // BIND-not-yet-effective-refused: v2 IS published and IS marked
      // reaccept_required, and it is NOT offered, because its effective_at is
      // in the future. Publication is not applicability.
      expect(pending.map((p) => p.instrumentVersionId)).not.toContain(IDS.orgVersionV2Pre)
    })

    it('PRESENTATION binding: the offered bytes are the EXACT retained bytes and they verify against the digest', async () => {
      const pending = await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        loadRequiredOrganizationInstrumentsPendingAcceptance(IDS.orgA)
      )
      expect(computeSelfDescribingDigest(pending[0].content)).toBe(pending[0].contentDigest)
    })

    it('P-AO-3 / P-AO-21: after the organisation accepts, the REAL predicate becomes TRUE and the pending set EMPTIES', async () => {
      await asScopedPrincipal(IDS.adminA, IDS.orgA, async () => {
        await db.execute(drizzleSql`
          INSERT INTO organization_commercial_acceptances
            (organization_id, instrument_key, instrument_version_id, content_digest, accepted_by_user_id, accepted_by_role)
          VALUES (${IDS.orgA}::uuid, 'commercial_terms', ${IDS.orgVersionV1}::uuid, ${ORG_V1_DIGEST}, ${IDS.adminA}::uuid, 'organization_admin')
        `)
      })
      expect(await asScopedPrincipal(IDS.adminA, IDS.orgA, () => deriveOrganizationAcceptanceCurrent(IDS.orgA))).toBe(true)
      const pending = await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        loadRequiredOrganizationInstrumentsPendingAcceptance(IDS.orgA)
      )
      expect(pending).toEqual([])
    })

    it('N-AO-12: Org B, governed by the SAME CommercialAccount, is STILL not current', async () => {
      // Proven by RE-SCOPING rather than by holding two live scopes, which the
      // user_single_active_membership index forbids.
      expect(await asScopedPrincipal(IDS.adminB, IDS.orgB, () => deriveOrganizationAcceptanceCurrent(IDS.orgB))).toBe(false)
    })

    it('HISTORY-former-admin-passes: Org C is current on an acceptance written by an admin who has since been DEMOTED', async () => {
      // The predicate does NOT join the acceptance row back to the CURRENT
      // membership. Under mutation MUT-L1-recompute-role-from-current-membership
      // this control goes RED — and that mutation looks like defensive
      // re-verification while silently un-accepting an organisation whenever
      // its founding administrator leaves.
      // The acceptance and the demotion both come from the fixture: the row
      // was written THROUGH RLS by the then-admin, and the demotion applied
      // afterwards. Re-asserted here so the control is not resting on an
      // assumption about fixture order.
      const state = (await asScopedPrincipal(IDS.formerAdmin, IDS.orgC, () =>
        db.execute(drizzleSql`
          SELECT (SELECT count(*)::int FROM organization_commercial_acceptances WHERE organization_id = ${IDS.orgC}::uuid) AS accepted,
                 (SELECT role FROM organization_members WHERE organization_id = ${IDS.orgC}::uuid AND user_id = ${IDS.formerAdmin}::uuid) AS live_role
        `)
      )) as unknown as { accepted: number; live_role: string }[]
      expect(state[0].accepted).toBe(1)
      expect(state[0].live_role).toBe('viewer')
      expect(
        await asScopedPrincipal(IDS.formerAdmin, IDS.orgC, () => deriveOrganizationAcceptanceCurrent(IDS.orgC))
      ).toBe(true)
    })

    /* --- supersession, re-acceptance and the fail-closed cases ------------- */

    it('a NEWLY EFFECTIVE marked version re-opens L1, and the ORGANISATION becomes not-current again', async () => {
      // Reacceptance is a NEW ROW; old rows remain immutable and are never
      // rewritten, flagged or deleted.
      const v4Text = 'L1 real-derivation fixture -- commercial_terms v4, marked and already effective.'
      const v4Digest = computeSelfDescribingDigest(v4Text)
      applySql(`INSERT INTO public.legal_instrument_versions
         (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
       VALUES ('0c120000-0000-4000-8000-000000001040', 'commercial_terms', 4, 'es', '${v4Digest}',
               '${v4Text.replace(/'/g, "''")}', true, now() - interval '1 day', '${IDS.platformSuperAdmin}', now() - interval '1 day');`)

      expect(await asScopedPrincipal(IDS.adminA, IDS.orgA, () => deriveOrganizationAcceptanceCurrent(IDS.orgA))).toBe(false)

      const pending = await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        loadRequiredOrganizationInstrumentsPendingAcceptance(IDS.orgA)
      )
      expect(pending).toHaveLength(1)
      expect(pending[0].version).toBe(4)
      // The OLD row is untouched — currency is COMPUTED, never stored.
      const rows = (await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        db.execute(drizzleSql`
          SELECT count(*)::int AS n FROM organization_commercial_acceptances WHERE organization_id = ${IDS.orgA}::uuid
        `)
      )) as unknown as { n: number }[]
      expect(rows[0].n).toBe(1)
    })

    it('PRESENT-unpresentable-fails-closed: a digest-invalid CURRENT version yields NO pending entry and NO fallback to an older one', async () => {
      // MUT-L1-fallback-to-older-presentable-version would make the surface
      // WORK where it previously refused — and the acceptance it obtained
      // would be of bytes that are NOT the ones currently required: evidence
      // that looks valid and is not.
      applySql(`INSERT INTO public.legal_instrument_versions
         (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
       VALUES ('0c120000-0000-4000-8000-000000001050', 'commercial_terms', 5, 'es', 'sha256:${'8'.repeat(64)}',
               'these retained bytes do NOT hash to the recorded digest', true, now() - interval '1 day', '${IDS.platformSuperAdmin}', now() - interval '1 day');`)

      const pending = await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        loadRequiredOrganizationInstrumentsPendingAcceptance(IDS.orgA)
      )
      // The key is OMITTED entirely — never partially rendered, and NEVER
      // satisfied by the older v4 or v1 that ARE presentable.
      expect(pending).toEqual([])
      // And the gate still refuses: fail closed, not vacuous truth.
      expect(await asScopedPrincipal(IDS.adminA, IDS.orgA, () => deriveOrganizationAcceptanceCurrent(IDS.orgA))).toBe(false)
    })

    it('a version with NO retained bytes is treated exactly like one with none published — same fail-closed outcome', async () => {
      applySql(`INSERT INTO public.legal_instrument_versions
         (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
       VALUES ('0c120000-0000-4000-8000-000000001060', 'commercial_terms', 6, 'es', 'sha256:${'a'.repeat(64)}',
               NULL, true, now() - interval '1 day', '${IDS.platformSuperAdmin}', now() - interval '1 day');`)
      const pending = await asScopedPrincipal(IDS.adminA, IDS.orgA, () =>
        loadRequiredOrganizationInstrumentsPendingAcceptance(IDS.orgA)
      )
      expect(pending).toEqual([])
    })

    it('R-L1-11 under the REAL context: a non-member reads ZERO acceptance rows', async () => {
      const seen = await asScopedPrincipal(IDS.adminB, IDS.orgB, async () => {
        const rows = (await db.execute(
          drizzleSql`SELECT count(*)::int AS n FROM organization_commercial_acceptances`
        )) as unknown as { n: number }[]
        return rows[0].n
      })
      // adminB is an active member of Org B only, and Org B has no acceptance.
      expect(seen).toBe(0)
    })
  }
)

/* -------------------------------------------------------------------------- */
/* P-AO-15 / N-AO-37 — EMPTY and PARTIAL registry, against the REAL predicate  */
/* -------------------------------------------------------------------------- */

describe.skipIf(!PG_TESTS_ENABLED)(
  'L1 — EMPTY and PARTIAL required registry FAIL CLOSED (real functions)',
  { timeout: 900_000 },
  () => {
    let containerName: string
    let client: DatabaseClient
    let applySql: (statement: string) => void

    beforeAll(async () => {
      // A GENUINELY EMPTY registry needs its own container: T2 and T4 are
      // append-only (RLS write-closed plus a BEFORE UPDATE OR DELETE trigger
      // that binds even the owner), so a registry that starts populated can
      // never be emptied again on the same database.
      const statements = [
        ...buildBaselineOnlyStatements(),
        `INSERT INTO auth.users (id, email) VALUES ('${IDS.adminA}','admin-a@pg.local') ON CONFLICT (id) DO NOTHING;
         INSERT INTO public.users (id, email, is_super_admin) VALUES ('${IDS.adminA}','admin-a@pg.local',false) ON CONFLICT (id) DO NOTHING;
         INSERT INTO public.organizations (id, name, slug, status) VALUES ('${IDS.orgA}', 'Org A', 'org-a', 'active');
         INSERT INTO public.organization_members (organization_id, user_id, role, status)
           VALUES ('${IDS.orgA}', '${IDS.adminA}', 'organization_admin', 'active');`,
      ]
      const provisioned = await provisionDisposableContainer(statements)
      containerName = provisioned.containerName
      client = provisioned.client
      applySql = provisioned.applySql
    }, 900_000)

    afterAll(async () => {
      if (client) await client.close()
      teardownDisposableContainer(containerName)
    })

    it('P-AO-15: with ZERO published organization-class versions the REAL predicate is FALSE — no vacuous truth', async () => {
      // The conjunction runs over the CLOSED REQUIRED set, not over the
      // published set. A required instrument with NO published applicable
      // version cannot be current FOR ANYONE, so its conjunct is FALSE and
      // the gate refuses. There is no empty set and therefore no vacuous
      // truth. A deployment in this state cannot activate ANY organisation,
      // and that is the CORRECT behaviour, detected immediately.
      const rows = (await withDatabaseIdentityContext(
        { userId: IDS.adminA, organizationId: IDS.orgA, isSuperAdmin: false },
        () => db.execute(drizzleSql`SELECT count(*)::int AS n FROM legal_instrument_versions`),
        { client }
      )) as unknown as { n: number }[]
      expect(rows[0].n).toBe(0)
      const current = await withDatabaseIdentityContext(
        { userId: IDS.adminA, organizationId: IDS.orgA, isSuperAdmin: false },
        () => deriveOrganizationAcceptanceCurrent(IDS.orgA),
        { client }
      )
      expect(current).toBe(false)
    })

    it('N-AO-37: a PARTIAL registry refuses the WHOLE gate', async () => {
      // Publish an instrument that is NOT in the closed required set, plus a
      // version of it. The required key STILL has no applicable version, so
      // the conjunction is still FALSE — the gate does not become satisfiable
      // by publishing something else. Under mutation M-AO-4 (the applicable
      // version PINNED IN APPLICATION CODE) this control goes RED, because a
      // pinned version stops the code asking whether the required key has a
      // published version at all.
      applySql(`INSERT INTO public.legal_instruments (instrument_key, instrument_class) VALUES ('some_other_instrument','ORGANIZATION');
        INSERT INTO public.legal_instrument_versions
          (id, instrument_key, version, locale, content_digest, content_bytes, reaccept_required, effective_at, published_by, published_at)
        VALUES ('0c120000-0000-4000-8000-0000000020a1','some_other_instrument',1,'es','sha256:${'3'.repeat(64)}','x',false, now() - interval '1 day','${IDS.adminA}', now());`)

      const current = await withDatabaseIdentityContext(
        { userId: IDS.adminA, organizationId: IDS.orgA, isSuperAdmin: false },
        () => deriveOrganizationAcceptanceCurrent(IDS.orgA),
        { client }
      )
      expect(current).toBe(false)
    })
  }
)

/* -------------------------------------------------------------------------- */
/* MUT-L1-permissive-catch-on-the-currency-query — non-vacuity, for real      */
/* -------------------------------------------------------------------------- */

describe.skipIf(!PG_TESTS_ENABLED)(
  'FAIL_CLOSED FC_6: a failing currency query THROWS — it never becomes a pass',
  { timeout: 900_000 },
  () => {
    let containerName: string
    let client: DatabaseClient
    let applySql: (statement: string) => void

    beforeAll(async () => {
      const provisioned = await provisionDisposableContainer(buildSetupManifest().statements)
      containerName = provisioned.containerName
      client = provisioned.client
      applySql = provisioned.applySql
    }, 900_000)

    afterAll(async () => {
      if (client) await client.close()
      teardownDisposableContainer(containerName)
    })

    it('revoking the SELECT grant makes the REAL predicate THROW, not return true', async () => {
      // WHAT THIS CONTROL PROVES, AND WHAT IT DOES NOT.
      //
      // It proves the REQUEST fails closed against a REAL connection made to
      // fail — something no positive test and no literal-SQL probe exercises,
      // because neither ever makes the query FAIL.
      //
      // IT DOES NOT, ON ITS OWN, DISCRIMINATE MUT-L1-permissive-catch, and
      // saying so is the difference between evidence and a green tick. Run
      // adversarially with a try/catch returning `true` inserted into the
      // resolver, THIS CONTROL STILL PASSES: once a query errors inside a
      // transaction PostgreSQL aborts it (25P02) and the COMMIT fails, so the
      // request throws even though the RESOLVER swallowed the error. The
      // DISCRIMINATING control is the structural one in
      // tests/auth/organization-commercial-acceptance-topology.test.ts ("the
      // L1 currency predicate is FAIL-CLOSED — NO catch of any form"), which
      // goes RED under that mutation. The two are recorded in that order
      // deliberately: an auditor must not read this suite as closing FC_6 by
      // itself.
      //
      // Sanity first: the predicate WORKS before the revocation, so a throw
      // afterwards is attributable to the revocation and not to a broken
      // fixture.
      const before = await withDatabaseIdentityContext(
        { userId: IDS.adminA, organizationId: IDS.orgA, isSuperAdmin: false },
        () => deriveOrganizationAcceptanceCurrent(IDS.orgA),
        { client }
      )
      expect(before).toBe(false)

      applySql(`REVOKE SELECT ON public.organization_commercial_acceptances FROM uellix_writer;`)

      await expect(
        withDatabaseIdentityContext(
          { userId: IDS.adminA, organizationId: IDS.orgA, isSuperAdmin: false },
          () => deriveOrganizationAcceptanceCurrent(IDS.orgA),
          { client }
        )
      ).rejects.toThrow()

      applySql(`GRANT SELECT ON public.organization_commercial_acceptances TO uellix_writer;`)
    })

    it('the pending-set resolver fails closed the same way', async () => {
      applySql(`REVOKE SELECT ON public.legal_instrument_versions FROM uellix_writer;`)
      await expect(
        withDatabaseIdentityContext(
          { userId: IDS.adminA, organizationId: IDS.orgA, isSuperAdmin: false },
          () => loadRequiredOrganizationInstrumentsPendingAcceptance(IDS.orgA),
          { client }
        )
      ).rejects.toThrow()
      applySql(`GRANT SELECT ON public.legal_instrument_versions TO uellix_writer;`)
    })
  }
)

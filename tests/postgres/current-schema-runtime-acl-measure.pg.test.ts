/**
 * PG-19 — REAL Measure service operations execute as uellix_app.
 *
 * The one family of the SECTION_14 matrix that cannot be proven with a catalog
 * probe. Every other control in
 * tests/postgres/current-schema-runtime-acl.pg.test.ts asks PostgreSQL what a
 * role MAY do; this one makes the application actually do it, through the code
 * that will do it in production, and checks that the row is there afterwards.
 *
 * WHAT THE AUTHORITY REQUIRES (SECTION_14 PG-19, verbatim): "at least one
 * write path from each of lib/pipeline/evidence-versions.ts,
 * lib/pipeline/financial-proxy-versions.ts, lib/pipeline/sroi-readiness.ts and
 * lib/pipeline/sroi-sensitivity.ts, invoked through withDatabaseIdentityContext
 * as uellix_app, persists its row (the real service module, not a
 * re-implementation of its SQL)."
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL, AND WHAT IS SUBSTITUTED
 * ---------------------------------------------------------------------------
 * The shape is the one tests/e2e/g04-governed-evidence-journey.e2e.test.ts
 * already established and which the authority names as the pattern to follow.
 *
 * REAL: the database (a disposable container this suite builds and destroys),
 * the governed substrate (stella_local_0000 -> baseline -> stella_0001 ->
 * stella_0021), RLS, the three RLS helpers, `withDatabaseIdentityContext`, the
 * repository's OWN postgres-js client built by `createDatabaseClient`, the
 * drizzle `db` proxy, the runtime-identity gate, and all four service modules
 * with their real gates, real ordinal derivation and real audit writes.
 *
 * SUBSTITUTED, and only this: `@/lib/auth/session`. It reads the cookies of an
 * HTTP request that does not exist in a vitest process, and calls `redirect()`
 * from next/navigation. It is replaced by the session a login would have
 * produced. NOTHING about database authorization is skipped — the user id it
 * returns is fed to the REAL identity context, where the DATABASE decides
 * whether that user is an active member of that organisation, and §PG-19-N
 * measures exactly that by feeding it one that is not.
 *
 * THE DATABASE CLIENT IS NOT MOCKED. It is `createDatabaseClient` with the
 * repository's own guard, pointed at a loopback port the harness published on
 * the container it created. A mocked client would make every assertion below
 * describe a fiction.
 *
 * ---------------------------------------------------------------------------
 * WHY "AS uellix_app" IS NOT THIS TEST'S CLAIM TO MAKE
 * ---------------------------------------------------------------------------
 * `withDatabaseIdentityContext` calls `ensureRuntimeIdentityVerified` BEFORE
 * its first business statement, and that gate refuses unless session_user AND
 * current_user are both `uellix_app`, and the role holds no SUPERUSER, no
 * BYPASSRLS, no CREATEROLE, no SET ROLE path to the owner and no CREATE on
 * schema public. So the identity claim is enforced by PRODUCTION code, not
 * asserted by the test — a connection that had authenticated as `postgres`
 * could not reach any of the service calls below at all. The suite asserts the
 * gate's answer as well, so the guarantee is visible rather than implicit.
 *
 * Gated on UELLIX_PG_TESTS=1; SKIPPED, never silently passed.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { AclCluster, PG_TESTS_ENABLED, dockerAvailable } from './current-schema-runtime-acl-harness'

/* -------------------------------------------------------------------------- */
/* Deterministic fixture identifiers                                          */
/* -------------------------------------------------------------------------- */

const ORG_A = '1a000000-0000-4000-8000-000000000001'
const ORG_B = '1b000000-0000-4000-8000-000000000002'
const ACTOR_A = 'aa000000-0000-4000-8000-000000000001'
const ACTOR_B = 'bb000000-0000-4000-8000-000000000002'
const PROJECT_A = 'cc000000-0000-4000-8000-000000000001'
const EVIDENCE_A = 'dd000000-0000-4000-8000-000000000001'
const SOURCE_A = 'ee000000-0000-4000-8000-000000000001'
const PROXY_A = 'ff000000-0000-4000-8000-000000000001'
const RUN_A = '99000000-0000-4000-8000-000000000001'

/**
 * The actor the substituted session returns. Mutable so a negative control can
 * point the SAME real service calls at an organisation the actor is not a
 * member of, and let the DATABASE refuse.
 */
const currentActor = { userId: ACTOR_A, organizationId: ORG_A }

/**
 * THE FOUR REQUIRED MODULES ARE AUTO-SPIED, NOT MOCKED.
 *
 * `{ spy: true }` keeps every real implementation and merely records the
 * calls, so nothing about the services is substituted — which the mission
 * forbids — while making "the REAL module was executed" a fact the suite reads
 * off the module itself rather than inferring from a row appearing.
 *
 * MEASURED, AND THE REASON THIS EXISTS. An earlier draft proved module
 * execution only through DERIVED VALUES (ordinal, supersedes_version_id). An
 * applied mutation that replaced createEvidenceVersion with an equivalent
 * hand-written INSERT left the whole suite GREEN: the derived-value control
 * called the module a SECOND time, and that call correctly derived ordinal 2
 * from the hand-written row. The row was real, the derivation was real, and no
 * application module had run the write PG-19 is about. The spies below close
 * exactly that hole.
 */
vi.mock('@/lib/pipeline/evidence-versions', { spy: true })
vi.mock('@/lib/pipeline/financial-proxy-versions', { spy: true })
vi.mock('@/lib/pipeline/sroi-readiness', { spy: true })
vi.mock('@/lib/pipeline/sroi-sensitivity', { spy: true })

vi.mock('@/lib/auth/session', () => ({
  // The two readiness/sensitivity modules call `requireOrganizationAccess()`
  // and read `.organization.id` and `.user.id` from it. Everything else about
  // those services — the project ownership query, the run lookup, the
  // approval gate, the governed-model lookup, the insert and the audit write
  // — runs unmodified against the real database.
  requireOrganizationAccess: async () => ({
    user: {
      id: currentActor.userId,
      email: 'pg19@example.invalid',
      fullName: null,
      avatarUrl: null,
      isSuperAdmin: false,
    },
    organization: { id: currentActor.organizationId, name: 'PG19 Org', slug: 'pg19-org' },
    membership: {
      id: '00000000-0000-4000-8000-0000000000aa',
      organizationId: currentActor.organizationId,
      userId: currentActor.userId,
      role: 'organization_admin',
      status: 'active',
    },
  }),
}))

/* -------------------------------------------------------------------------- */
/* Cluster + client lifecycle                                                 */
/* -------------------------------------------------------------------------- */

const enabled = PG_TESTS_ENABLED
let cluster: AclCluster | null = null
let skipReason = ''
let client: import('@/db/client').DatabaseClient | null = null

/**
 * The four modules PG-19 names: the table each one's write path lands in, the
 * import specifier, and the exported function that must actually be invoked.
 */
const REQUIRED_MODULES = [
  {
    module: 'lib/pipeline/evidence-versions.ts',
    table: 'evidence_versions',
    specifier: '@/lib/pipeline/evidence-versions',
    exported: 'createEvidenceVersion',
  },
  {
    module: 'lib/pipeline/financial-proxy-versions.ts',
    table: 'financial_proxy_versions',
    specifier: '@/lib/pipeline/financial-proxy-versions',
    exported: 'createFinancialProxyVersion',
  },
  {
    module: 'lib/pipeline/sroi-readiness.ts',
    table: 'readiness_assessments',
    specifier: '@/lib/pipeline/sroi-readiness',
    exported: 'computeAndPersistReadinessAssessment',
  },
  {
    module: 'lib/pipeline/sroi-sensitivity.ts',
    table: 'sensitivity_candidates',
    specifier: '@/lib/pipeline/sroi-sensitivity',
    exported: 'registerSensitivityCandidates',
  },
] as const

/** The modules proven to have been invoked BY their own census call. */
const moduleInvoked = new Set<string>()

/**
 * Run one census call and prove the REAL module function was invoked BY IT.
 *
 * THE DELTA IS THE WHOLE POINT, and it was arrived at by being wrong twice.
 * A control asking "did a row appear?" passes for a hand-written INSERT. A
 * control asking "was this function EVER called?" also passes, because a later
 * case in this same file calls it again — measured, with an applied mutation
 * that replaced one census call with equivalent SQL and left the suite GREEN
 * under both shapes. Only "was it called exactly once MORE across this call"
 * attributes the write to the module the census is crediting.
 */
async function census<T>(
  entry: (typeof REQUIRED_MODULES)[number],
  call: () => Promise<T>,
): Promise<T> {
  const before = await invocationCount(entry.specifier, entry.exported)
  const result = await call()
  const after = await invocationCount(entry.specifier, entry.exported)
  expect(
    after - before,
    `${entry.module} :: ${entry.exported} was NOT invoked by this census call — the row, if any, came from somewhere else`,
  ).toBe(1)
  moduleInvoked.add(entry.module)
  return result
}

/** How many times the REAL exported function was invoked, read off the spy. */
async function invocationCount(specifier: string, exported: string): Promise<number> {
  const mod = (await import(/* @vite-ignore */ specifier)) as unknown as Record<string, unknown>
  const fn = mod[exported]
  const mock = (fn as { mock?: { calls: unknown[][] } }).mock
  if (mock === undefined) {
    throw new Error(`${specifier}.${exported} is not spied — the structural control cannot answer`)
  }
  return mock.calls.length
}

/** Which of the four actually persisted a row, recorded as each test runs. */
const persisted = new Map<string, { table: string; rowId: string }>()

/** The privilege fingerprint either side of the credential act. */
let privilegeBefore = ''
let privilegeAfter = ''

beforeAll(async () => {
  if (!enabled) {
    skipReason = 'UELLIX_PG_TESTS is not 1'
    return
  }
  if (!dockerAvailable()) {
    skipReason = 'Docker is unreachable'
    return
  }
  // PUBLISHED PORT: PG-19 is the only family that needs one, because the
  // application client dials TCP. Loopback, ephemeral, on a container this
  // call creates.
  cluster = await AclCluster.create({ publishPort: true })
  if (cluster === null) {
    skipReason = 'the disposable cluster could not be provisioned'
    return
  }

  const applied = cluster.applyPackage()
  if (applied.status !== 0) {
    throw new Error(`stella_0021 failed to apply to the PG-19 substrate:\n${applied.stderr}`)
  }

  seedGovernedFixture(cluster)

  // THE CREDENTIAL ACT, BRACKETED BY A PRIVILEGE MEASUREMENT. The runtime role
  // needs a password to be reachable over the published port at all (see the
  // harness). That it changes NO privilege is proven here by comparison, not
  // argued: role attributes, memberships and the entire public table/function
  // ACL are captured either side of the ALTER ROLE.
  privilegeBefore = cluster.privilegeFingerprint()
  const runtimeUrl = cluster.grantRuntimeCredential()
  privilegeAfter = cluster.privilegeFingerprint()

  const { createDatabaseClient } = await import('@/db/client')
  client = createDatabaseClient({
    connectionString: runtimeUrl,
    // A LOCAL, WRITE-CAPABLE capability. The guard refuses any non-loopback
    // target for it, so this client cannot reach staging or production even if
    // the URL were wrong.
    capability: 'local_integration_test',
    environment: 'test',
    expectedLocalPort: cluster.port ?? undefined,
    env: {},
  })
}, 900_000)

afterAll(async () => {
  if (client !== null) {
    await client.close()
    client = null
  }
  if (cluster !== null) {
    const leftover = cluster.destroy()
    expect(leftover, 'the disposable container survived teardown').toBe(0)
    cluster = null
  }
}, 120_000)

function db(): AclCluster {
  if (cluster === null) throw new Error(`no cluster: ${skipReason}`)
  return cluster
}

function runtimeClient(): import('@/db/client').DatabaseClient {
  if (client === null) throw new Error(`no runtime client: ${skipReason}`)
  return client
}

/**
 * The prerequisite BUSINESS rows, seeded administratively.
 *
 * This is governed fixture setup, not the write path under test: it creates
 * the organisations, actors, project, evidence item, proxy and calculation run
 * that the four services need in order to have something to version or assess.
 * It issues NO GRANT, alters NO role, and writes NONE of the four target
 * tables — those four rows are written by the application, which is the whole
 * claim of PG-19.
 */
function seedGovernedFixture(c: AclCluster): void {
  c.fixture(`
    INSERT INTO auth.users (id, email) VALUES
      ('${ACTOR_A}','a@pg19.invalid'), ('${ACTOR_B}','b@pg19.invalid')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.users (id, email) VALUES
      ('${ACTOR_A}','a@pg19.invalid'), ('${ACTOR_B}','b@pg19.invalid')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organizations (id, name, slug) VALUES
      ('${ORG_A}','PG19 Org A','pg19-org-a'), ('${ORG_B}','PG19 Org B','pg19-org-b')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
      ('${ORG_A}','${ACTOR_A}','organization_admin','active'),
      ('${ORG_B}','${ACTOR_B}','organization_admin','active')
      ON CONFLICT DO NOTHING;
    INSERT INTO public.projects (id, organization_id, name, created_by) VALUES
      ('${PROJECT_A}','${ORG_A}','PG19 Project','${ACTOR_A}')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.evidence_items (id, project_id, organization_id, type, title, created_by) VALUES
      ('${EVIDENCE_A}','${PROJECT_A}','${ORG_A}','text','PG19 Evidence','${ACTOR_A}')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.proxy_sources (id, organization_id, name, created_by) VALUES
      ('${SOURCE_A}','${ORG_A}','PG19 Source','${ACTOR_A}')
      ON CONFLICT (id) DO NOTHING;
    INSERT INTO public.financial_proxies (id, organization_id, source_id, name, created_by) VALUES
      ('${PROXY_A}','${ORG_A}','${SOURCE_A}','PG19 Proxy','${ACTOR_A}')
      ON CONFLICT (id) DO NOTHING;
    -- status is supplied EXPLICITLY, and that is not tidiness. MEASURED on
    -- the governed substrate: db/migrations/0009 creates the column with
    -- DEFAULT 'completed', and db/migrations/0010 later REPLACES the check
    -- constraint with IN ('calculated','failed','pending') without updating
    -- the default. The column default is therefore not admitted by its own
    -- constraint, so any INSERT that omits status fails with 23514.
    -- db/schema.ts reports .default('calculated'), which is the INTENDED
    -- state rather than the applied one, so the drift is invisible from the
    -- TypeScript side. Recorded as a finding; repairing it would mean editing
    -- a migration, which this lane is forbidden to do.
    INSERT INTO public.sroi_calculation_runs
      (id, project_id, organization_id, calculated_by, status, methodology_version, snapshot_json) VALUES
      ('${RUN_A}','${PROJECT_A}','${ORG_A}','${ACTOR_A}','calculated','1.0.0','{"discountRatePct":"3.5"}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
  `)
}

/** Run `callback` through the REAL identity context, on the REAL client. */
async function asRuntime<T>(
  identity: { userId: string; organizationId: string },
  callback: () => Promise<T>,
): Promise<T> {
  const { withDatabaseIdentityContext } = await import('@/db/identity-context')
  return withDatabaseIdentityContext(
    { userId: identity.userId, organizationId: identity.organizationId, isSuperAdmin: false },
    () => callback(),
    { client: runtimeClient() },
  )
}

const maybe = enabled ? describe : describe.skip

/* -------------------------------------------------------------------------- */

maybe('PG-19 — the substrate and the identity gate', () => {
  it('provisions, or says why it did not — never silently green', () => {
    expect(cluster, `PG-19 could not run: ${skipReason}`).not.toBeNull()
    expect(cluster?.port, 'PG-19 needs a published loopback port').toBeGreaterThan(0)
  })

  it('the application client authenticated as uellix_app, and the PRODUCTION gate says so', async () => {
    // Not the test's own assertion: this is the function
    // `withDatabaseIdentityContext` calls before its first business statement,
    // and it THROWS on any other role or on a role holding SUPERUSER,
    // BYPASSRLS, CREATEROLE, a SET-ROLE path to the owner, or CREATE on public.
    const { ensureRuntimeIdentityVerified } = await import('@/db/runtime-bootstrap')
    const identity = await ensureRuntimeIdentityVerified(runtimeClient().sql)

    expect(identity.sessionUser).toBe('uellix_app')
    expect(identity.currentUser).toBe('uellix_app')
    expect(identity.isSuperuser).toBe(false)
    expect(identity.bypassesRls).toBe(false)
    expect(identity.canCreateRole).toBe(false)
    expect(identity.canSetOwnerRole).toBe(false)
    expect(identity.canCreateInPublic).toBe(false)
  })

  it('the client is the REPOSITORY\'S own guarded client, aimed at loopback', () => {
    expect(runtimeClient().decision.targetKind).toBe('local_loopback')
    expect(runtimeClient().decision.readOnly).toBe(false)
  })

  it('the credential act changed NO privilege — measured, not argued', () => {
    // The harness had to give uellix_app a password for the published port to
    // be reachable at all. A password is a credential, not a privilege, and
    // this is where that distinction stops being a claim: role attributes,
    // memberships and the entire public table and function ACL are identical
    // either side of the ALTER ROLE.
    expect(privilegeBefore.length).toBeGreaterThan(0)
    expect(privilegeAfter).toBe(privilegeBefore)
  })

  it('the substrate resolves identity from the CLAIMS the application sets', () => {
    // The precondition every policy in this schema depends on, asserted
    // against the same GUC db/identity-context.ts writes and nothing else. If
    // auth.uid() were NULL here, current_user_org_ids() would be an empty
    // array and EVERY policy would evaluate false — the application would
    // connect successfully and see zero rows, which is the failure mode
    // db/identity-context.ts:14 describes. Asserted BEFORE any service call so
    // a red here names the substrate rather than the service.
    const claims = JSON.stringify({ sub: ACTOR_A, role: 'authenticated' })
    const probe = db().query(
      `BEGIN;
       SELECT set_config('request.jwt.claims', '${claims}', true);
       SELECT coalesce(auth.uid()::text,'NULL'),
              coalesce(array_length(public.current_user_org_ids(), 1)::text,'0'),
              ('${ORG_A}'::uuid = ANY (public.current_user_org_ids()))::text;
       COMMIT;`,
    )
    // The last row is the three-column answer; psql prints the set_config row first.
    const answer = probe[probe.length - 1]
    expect(answer?.[0], 'auth.uid() did not resolve from request.jwt.claims').toBe(ACTOR_A)
    expect(answer?.[1], 'current_user_org_ids() saw no membership').toBe('1')
    // ::text of a boolean is 'true'/'false', not psql's unaligned 't'/'f'.
    expect(answer?.[2]).toBe('true')
  })

  it('NON-VACUITY: the four target tables are EMPTY before any service runs', () => {
    // Everything below must therefore be written by the application. If the
    // fixture had seeded them, every persistence assertion would be measuring
    // its own setup.
    for (const { table } of REQUIRED_MODULES) {
      expect(db().scalar(`SELECT count(*) FROM public.${table}`), table).toBe('0')
    }
  })
})

maybe('PG-19 — each required module persists its row through the real service', () => {
  it('lib/pipeline/evidence-versions.ts :: createEvidenceVersion', async () => {
    const { createEvidenceVersion } = await import('@/lib/pipeline/evidence-versions')

    const created = await census(REQUIRED_MODULES[0], () =>
      asRuntime(currentActor, () =>
      createEvidenceVersion({
        organizationId: ORG_A,
        evidenceId: EVIDENCE_A,
        content: 'PG-19 evidence content',
        contentHash: 'a'.repeat(64),
        reviewStatus: 'draft',
        legacyContentUnverifiable: false,
        createdBy: ACTOR_A,
      }),
    ))

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    // The ORDINAL is the service's own logic (select-max-then-insert), not
    // something the test supplied — evidence that the real module ran.
    expect(created.ordinal).toBe(1)
    expect(created.supersedesVersionId).toBeNull()

    const row = db().query(
      `SELECT id, organization_id, evidence_id, ordinal FROM public.evidence_versions WHERE id = '${created.id}'`,
    )
    expect(row).toHaveLength(1)
    expect(row[0][1]).toBe(ORG_A)
    expect(row[0][2]).toBe(EVIDENCE_A)
    persisted.set('lib/pipeline/evidence-versions.ts', { table: 'evidence_versions', rowId: created.id })
  })

  it('lib/pipeline/financial-proxy-versions.ts :: createFinancialProxyVersion', async () => {
    const { createFinancialProxyVersion } = await import('@/lib/pipeline/financial-proxy-versions')

    const created = await census(REQUIRED_MODULES[1], () =>
      asRuntime(currentActor, () =>
      createFinancialProxyVersion({
        organizationId: ORG_A,
        financialProxyId: PROXY_A,
        sourceId: SOURCE_A,
        value: '100.0000',
        currency: 'USD',
        unit: 'person',
        referenceYear: 2025,
        valueUsd: '100.0000',
        fxRateId: null,
        country: null,
        territory: null,
        thematicArea: null,
        methodology: null,
        geographicContextualScope: null,
        linkedOutcomeContext: null,
        recoverableReference: null,
        relevanceJustification: null,
        documentedTransformations: null,
        consultationDate: null,
        // THE VERSION VOCABULARY, NOT THE LIVE ONE. financial_proxies and
        // financial_proxy_versions carry DIFFERENT review_status token sets,
        // which is why the module exports toVersionReviewStatus /
        // toLiveReviewStatus to map between them. 'suggested' is a LIVE token
        // and the version table's CHECK admits only
        // ('draft','under_review','approved','rejected','archived').
        reviewStatus: 'draft',
        createdBy: ACTOR_A,
      }),
    ))

    expect(created.ordinal).toBe(1)
    const row = db().query(
      `SELECT id, organization_id, financial_proxy_id FROM public.financial_proxy_versions WHERE id = '${created.id}'`,
    )
    expect(row).toHaveLength(1)
    expect(row[0][1]).toBe(ORG_A)
    expect(row[0][2]).toBe(PROXY_A)
    persisted.set('lib/pipeline/financial-proxy-versions.ts', {
      table: 'financial_proxy_versions',
      rowId: created.id,
    })
  })

  it('lib/pipeline/sroi-readiness.ts :: computeAndPersistReadinessAssessment', async () => {
    const { computeAndPersistReadinessAssessment } = await import('@/lib/pipeline/sroi-readiness')

    await census(REQUIRED_MODULES[2], () =>
      asRuntime(currentActor, () => computeAndPersistReadinessAssessment(PROJECT_A, RUN_A)))

    const row = db().query(
      `SELECT id, organization_id, project_id, calculation_run_id, readiness_model_version, band
       FROM public.readiness_assessments WHERE calculation_run_id = '${RUN_A}'`,
    )
    expect(row).toHaveLength(1)
    expect(row[0][1]).toBe(ORG_A)
    expect(row[0][2]).toBe(PROJECT_A)
    // The model version comes from public.governed_model_registry, which the
    // runtime may only READ (READ_ONLY class). That the service found it is
    // itself part of the contract this candidate publishes.
    expect(row[0][4]).toBe('1.0.0')
    persisted.set('lib/pipeline/sroi-readiness.ts', {
      table: 'readiness_assessments',
      rowId: row[0][0],
    })
  })

  it('lib/pipeline/sroi-sensitivity.ts :: registerSensitivityCandidates', async () => {
    const { registerSensitivityCandidates } = await import('@/lib/pipeline/sroi-sensitivity')

    const listed = await census(REQUIRED_MODULES[3], () =>
      asRuntime(currentActor, () => registerSensitivityCandidates(PROJECT_A, RUN_A)))

    // buildSensitivityCandidateDrafts ALWAYS registers the discount-rate
    // candidate for a run, regardless of value, so this row is the service's
    // own decision rather than anything the fixture asked for.
    expect(listed.length).toBeGreaterThan(0)
    const row = db().query(
      `SELECT id, organization_id, project_id, candidate_key, base_value
       FROM public.sensitivity_candidates WHERE calculation_run_id = '${RUN_A}'`,
    )
    expect(row).toHaveLength(listed.length)
    expect(row[0][1]).toBe(ORG_A)
    expect(row[0][2]).toBe(PROJECT_A)
    expect(row.map((r) => r[3])).toContain('other_quantitative_input:discount_rate_pct')
    // The base value was read out of the run's own snapshot_json by the
    // service, not passed in by the test.
    expect(row.find((r) => r[3] === 'other_quantitative_input:discount_rate_pct')?.[4]).toBe('3.5')
    persisted.set('lib/pipeline/sroi-sensitivity.ts', {
      table: 'sensitivity_candidates',
      rowId: row[0][0],
    })
  })

  it('the audit trail was written too — APPEND_ONLY, through the same contract', () => {
    // logAuditAction is called by the readiness and sensitivity services and
    // writes public.audit_logs, which stella_0021 classifies APPEND_ONLY. A
    // row here proves the append-only grant serves a real request, not just a
    // has_table_privilege() answer.
    const n = Number(db().scalar(`SELECT count(*) FROM public.audit_logs`) ?? '0')
    expect(n).toBeGreaterThan(0)
  })
})

maybe('PG-19 — the census, and the negative half', () => {
  it('M-PG19-5 all FOUR required modules persisted a row; none is absent', () => {
    const missing = REQUIRED_MODULES.filter((m) => !persisted.has(m.module)).map((m) => m.module)
    expect(missing, 'a required PG-19 module family did not persist a row').toEqual([])
    expect(persisted.size).toBe(4)
    // And each landed in the table its family names, so a module cannot be
    // credited by another module's write.
    for (const { module, table } of REQUIRED_MODULES) {
      expect(persisted.get(module)?.table, module).toBe(table)
    }
  })

  it('M-PG19-3 the SAME service call is REFUSED for an organisation the actor does not belong to', async () => {
    // The identity context asks the DATABASE whether this user is an active
    // member — `current_user_org_ids()` under the claims it just set. Nothing
    // in the substituted session is consulted for that answer, which is what
    // makes the substitution safe.
    const { IdentityContextError } = await import('@/db/identity-context')
    const { createEvidenceVersion } = await import('@/lib/pipeline/evidence-versions')

    await expect(
      asRuntime({ userId: ACTOR_A, organizationId: ORG_B }, () =>
        createEvidenceVersion({
          organizationId: ORG_B,
          evidenceId: EVIDENCE_A,
          content: 'cross-org attempt',
          contentHash: 'b'.repeat(64),
          reviewStatus: 'draft',
          legacyContentUnverifiable: false,
          createdBy: ACTOR_A,
        }),
      ),
    ).rejects.toBeInstanceOf(IdentityContextError)

    // And nothing was written: the refusal happens before the first business
    // statement, and the transaction rolls back regardless.
    expect(db().scalar(`SELECT count(*) FROM public.evidence_versions WHERE organization_id = '${ORG_B}'`)).toBe('0')
  })

  it('M-PG19-2 the same service call OUTSIDE an identity context writes nothing it can see', async () => {
    // Bypassing withDatabaseIdentityContext is not a shortcut that happens to
    // work: without the context the ambient `db` proxy falls back to the
    // gated pooled client, which in this process has no configured runtime
    // URL at all. The call therefore CANNOT reach the database — a governed
    // refusal rather than a silent write.
    const { createEvidenceVersion } = await import('@/lib/pipeline/evidence-versions')
    const before = db().scalar(`SELECT count(*) FROM public.evidence_versions`)

    await expect(
      createEvidenceVersion({
        organizationId: ORG_A,
        evidenceId: EVIDENCE_A,
        content: 'context-free attempt',
        contentHash: 'c'.repeat(64),
        reviewStatus: 'draft',
        legacyContentUnverifiable: false,
        createdBy: ACTOR_A,
      }),
    ).rejects.toThrow()

    expect(db().scalar(`SELECT count(*) FROM public.evidence_versions`)).toBe(before)
  })

  it('M-PG19-4 STRUCTURAL: each required module\'s exported function was ACTUALLY INVOKED', async () => {
    // THE CONTROL THAT CANNOT BE SATISFIED BY HAND-WRITTEN SQL, and the third
    // shape this control has taken. `moduleInvoked` is filled by census(),
    // which asserts the spy count rose by exactly one ACROSS that call — so a
    // census entry can only be credited to the module that actually produced
    // it. The two weaker shapes both stayed GREEN under an applied mutation
    // that swapped one service call for equivalent SQL:
    //   "a row with the right shape exists"  — the SQL produced one;
    //   "the function was called at some point" — a LATER case called it.
    const missing = REQUIRED_MODULES.filter((m) => !moduleInvoked.has(m.module)).map((m) => m.module)
    expect(missing, 'a census row was not attributable to its own module call').toEqual([])
    expect(moduleInvoked.size).toBe(4)

    // And every module still reports at least one invocation overall, so the
    // spies are live rather than silently detached.
    for (const { specifier, exported, module } of REQUIRED_MODULES) {
      expect(await invocationCount(specifier, exported), `${module} :: ${exported}`).toBeGreaterThan(0)
    }
  })

  it('M-PG19-4 the persisted rows carry the SERVICE\'s derived values, not the test\'s literals', async () => {
    // THE STRUCTURAL ANSWER TO "could this have been direct SQL?". Each
    // assertion below is on a value the TEST never supplied and could not have
    // supplied without re-implementing the module:
    //
    //   ordinal                  derived by select-max-then-insert
    //   supersedes_version_id    linked to the previously-current version
    //   readiness_model_version  read from governed_model_registry
    //   candidate_key            composed by buildSensitivityCandidateDrafts
    //
    // A hand-written INSERT would have had to hard-code all four, and a second
    // call would not produce ordinal 2.
    const { createEvidenceVersion } = await import('@/lib/pipeline/evidence-versions')
    const first = persisted.get('lib/pipeline/evidence-versions.ts')
    expect(first).toBeDefined()

    const second = await asRuntime(currentActor, () =>
      createEvidenceVersion({
        organizationId: ORG_A,
        evidenceId: EVIDENCE_A,
        content: 'PG-19 second version',
        contentHash: 'd'.repeat(64),
        reviewStatus: 'draft',
        legacyContentUnverifiable: false,
        createdBy: ACTOR_A,
      }),
    )

    expect(second.ordinal).toBe(2)
    expect(second.supersedesVersionId).toBe(first?.rowId)
  })

  it('M-PG19-1 a census missing ONE module reports exactly that module — and every one of the four', () => {
    // The census is driven by REQUIRED_MODULES. Proving it is falsifiable
    // rather than decorative, and doing so over a SELF-CONTAINED map: an
    // earlier draft derived the pretend map from the live one, so when the
    // service calls failed the "negative" arm compared an empty map against
    // one name and failed for the wrong reason. The arm below cannot depend on
    // whether the positives passed.
    const complete = new Map(
      REQUIRED_MODULES.map((m) => [m.module, { table: m.table, rowId: 'fixture' }] as const),
    )
    for (const victim of REQUIRED_MODULES) {
      const pretend = new Map(complete)
      pretend.delete(victim.module)
      const missing = REQUIRED_MODULES.filter((m) => !pretend.has(m.module)).map((m) => m.module)
      expect(missing, `dropping ${victim.module} went unnoticed`).toEqual([victim.module])
    }
    // A complete census reports nothing missing...
    expect(REQUIRED_MODULES.filter((m) => !complete.has(m.module))).toEqual([])
    // ...and the LIVE census, over the map the real service calls filled, is
    // complete too.
    expect(REQUIRED_MODULES.filter((m) => !persisted.has(m.module))).toEqual([])
  })
})

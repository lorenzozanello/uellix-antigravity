// tests/hosted/checkpoint-a1.test.ts
//
// CHECKPOINT A1 — three independent signals, nine measured packages, one plan.
//
// The property under test is not "does A1 pass against a good artefact". It is
// that every way of arriving at a pass WITHOUT the evidence is closed:
//
//   * a signal that is really another signal wearing its name;
//   * a package nobody measured, reported as absent;
//   * a half-installed package, reported as absent;
//   * a flag nobody recorded, reported as off;
//   * a sentinel that says something other than what the invocation says;
//   * a status file somebody edited after it was derived.
//
// Every positive case below is paired with the negation it is the negation of,
// so an implementation that refused everything would fail this file as loudly as
// one that refused nothing.

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  A1_CORROBORATION_ARTEFACT,
  A1_EXPECTED_PACKAGE_COUNT,
  A1_OBSERVATION_SQL,
  A1_OBSERVED_CHAIN,
  A1_STATUS_ARTEFACT,
  a1UncoveredPackages,
  assertA1ObservedChainIsPrefix,
  A1ObservedChainRefusal,
  buildA1CorroborationSql,
  collectSignals,
  computeA1Status,
  computeRecordedA1Status,
  evaluateCheckpointA1,
  parseA1Corroboration,
  serializeA1Status,
  verifyA1Status,
} from '@/db/hosted/checkpoint-a1'
import { BASELINE_ORDER } from '@/db/hosted/baseline-manifest'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'
import {
  PACKAGE_WITNESSES,
  WITNESSED_PACKAGES,
  witnessKey,
  type PackageWitnesses,
} from '@/db/hosted/package-witnesses'
import { STELLA_FEATURE_FLAGS } from '@/db/hosted/hosted-provisioning-runner'
import { SENTINEL_BOOTSTRAP_VERSION, SENTINEL_OWNER_SEPARATION } from '@/db/hosted/bootstrap-postconditions'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const REF = KNOWN_STAGING_PROJECT_REF
const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!

/**
 * The tsx CLI, resolved rather than shelled out to.
 *
 * `execFileSync('npx', …, {shell: true})` on Windows concatenates its arguments
 * into a command line instead of escaping them, which Node warns about for good
 * reason. Resolving the binary means the round-trip below spawns exactly one
 * known program with exactly the arguments given.
 */
const TSX_CLI = createRequire(path.join(ROOT, 'package.json')).resolve('tsx/cli')

const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const STELLA_SOURCES: Record<string, string> = Object.fromEntries(
  HOSTED_CHAIN.map((name) => [name, readFileSync(path.join(ROOT, 'db', 'prepared', `${name}.sql`), 'utf8')]),
)

const [T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11] = WITNESSED_PACKAGES as unknown as [
  string, string, string, string, string, string, string, string, string, string, string,
]

const positives = (pkg: string): string[] =>
  PACKAGE_WITNESSES[pkg]!.requiredPresentWhenInstalled.map(witnessKey)
const negatives = (pkg: string): string[] =>
  PACKAGE_WITNESSES[pkg]!.requiredAbsentWhenInstalled.map(witnessKey)

/* -------------------------------------------------------------------------- */
/* The fixture: exactly what the operator would assemble on the real target     */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>

const SENTINEL_OK = {
  tablePresent: true,
  rowCount: 1,
  id: true,
  environment: 'staging',
  projectRef: REF,
  bootstrapVersion: SENTINEL_BOOTSTRAP_VERSION,
  provisionedAt: '2026-08-09T17:03:26.683865+00:00',
  ownerSeparation: SENTINEL_OWNER_SEPARATION,
  rr02Present: true,
}

const JOURNAL_OK = {
  tablePresent: true,
  units: BASELINE_ORDER.map((packageId) => ({ packageId, status: 'APPLIED' })),
  projectRefs: [REF],
  environments: ['staging'],
}

const FLAGS_OFF: Record<string, string> = Object.fromEntries(STELLA_FEATURE_FLAGS.map((f) => [f, 'false']))

/** Every witness of every package, `present` true only for the listed keys. */
function packageObservations(present: readonly string[] = []): Json[] {
  return WITNESSED_PACKAGES.map((packageId) => {
    const declared = PACKAGE_WITNESSES[packageId]!
    const keys = [...declared.requiredPresentWhenInstalled, ...declared.requiredAbsentWhenInstalled].map(witnessKey)
    return {
      packageId,
      witnesses: Object.fromEntries(keys.map((k) => [k, present.includes(k)])),
    }
  })
}

function corroboration(overrides: Json = {}, observationOverrides: Json = {}): string {
  return JSON.stringify(
    {
      declaredEnvironment: 'staging',
      declaredProjectRef: REF,
      connection: {
        connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
        poolerUser: `postgres.${REF}`,
        connectionPort: 5432,
      },
      featureFlags: { ...FLAGS_OFF },
      observation: {
        targetProjectRef: REF,
        measuredBy: 'operator, psql session pooler, inside a READ ONLY transaction',
        sentinelObservation: { ...SENTINEL_OK },
        bootstrapSchemaPresent: true,
        baselineJournal: JOURNAL_OK,
        packageObservations: packageObservations(),
        ...observationOverrides,
      },
      ...overrides,
    },
    null,
    2,
  )
}

const evaluate = (raw: string | null, extra: Partial<Parameters<typeof evaluateCheckpointA1>[0]> = {}) =>
  evaluateCheckpointA1({
    raw,
    readBaselineSql: read,
    stellaSources: STELLA_SOURCES,
    storageUnitState: 'UNIT_41_COMPLETE',
    ...extra,
  })

const blockerText = (v: ReturnType<typeof evaluate>): string => v.blockers.join(' || ')

/* -------------------------------------------------------------------------- */
/* THE HAPPY PATH — and it goes through the REAL runner                        */
/* -------------------------------------------------------------------------- */

describe('the expected target: sentinel correct, three signals agreeing, eleven packages absent', () => {
  it('passes, and the plan is the eleven chain packages in order', () => {
    const v = evaluate(corroboration())
    expect(blockerText(v)).toBe('')
    expect(v.checkpointPassed).toBe(true)
    expect(v.packageCount).toBe(A1_EXPECTED_PACKAGE_COUNT)
    // ELEVEN since M-2. A1_EXPECTED_PACKAGE_COUNT is HOSTED_CHAIN.length - 1
    // and is asserted on the line above; this literal is the second reader,
    // so a chain that grows silently fails here rather than agreeing with
    // itself.
    expect(v.packageCount).toBe(11)
    expect(v.chainPlan?.ok).toBe(true)
    expect(v.chainPlan?.stepCount).toBe(11)
    // The order is the APPLICATION order, transcribed rather than derived, so
    // a reordering of the chain has to be re-read by a person here. T10 sits
    // after the six Stella packages although it is a grounding one: M-8's
    // repair was authored after the other nine were installed, and numbering it
    // beside grounding_0002 would describe a sequence nobody ran.
    expect(v.chainPlan?.steps).toEqual([
      'grounding_0002_document_versions',
      'grounding_0003_evidence_chunks',
      'grounding_0004_runtime_attestation',
      'stella_0013_grounded_query_quota',
      'stella_0014_operation_tickets',
      'stella_0015_project_bound_operation_tickets',
      'stella_0016_reserved_quota_semantics',
      'stella_0017_governed_stella_consumption',
      'stella_0018_category_bound_operation_tickets',
      'grounding_0005_claim_advisory_lock',
      // T11 sits last for the same reason and belongs to neither campaign:
      // M-2's repair of a BASELINE function, authored after all ten.
      'stella_0019_storage_write_roles',
    ])
    expect(v.chainPlan?.sequenceComplete).toBe(true)
    // A1 IS READ-ONLY. It says the chain may be PLANNED, never that it may run.
    expect(v.chainPlan?.writesPermitted).toBe(false)
  })

  it('records every package as ABSENT, measured — not assumed', () => {
    const v = evaluate(corroboration())
    expect(Object.values(v.packageStates)).toEqual(Array(WITNESSED_PACKAGES.length).fill('ABSENT'))
    expect(v.partialPackages).toEqual([])
  })

  it('reports the target verified by all three signals', () => {
    const v = evaluate(corroboration())
    expect(v.targetVerification?.ok).toBe(true)
    expect(v.targetVerification?.signals).toContain('in-database-sentinel')
    expect(v.targetVerification?.sentinelDeferred).toBe(false)
  })

  it('reports the sentinel row it read, field by field', () => {
    const v = evaluate(corroboration())
    expect(v.sentinel?.projectRef).toBe(REF)
    expect(v.sentinel?.bootstrapVersion).toBe(SENTINEL_BOOTSTRAP_VERSION)
    expect(v.sentinel?.rr02Present).toBe(true)
    expect(v.sentinel?.rowCount).toBe(1)
  })

  it('evaluates all nine flags and finds none enabled', () => {
    const v = evaluate(corroboration())
    expect(v.flags).toEqual({ evaluated: 9, enabled: [] })
  })
})

/* -------------------------------------------------------------------------- */
/* THE THREE SIGNALS                                                           */
/* -------------------------------------------------------------------------- */

describe('three signals, from three places', () => {
  const parsed = () => {
    const r = parseA1Corroboration(corroboration())
    if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
    return r.corroboration
  }

  it('names three, from three PAIRWISE DISTINCT pointers', () => {
    const signals = collectSignals(parsed())
    expect(signals.map((s) => s.id)).toEqual([
      'SIGNAL_1_CONNECTION',
      'SIGNAL_2_DECLARATION',
      'SIGNAL_3_DATABASE',
    ])
    expect(new Set(signals.map((s) => s.pointer)).size).toBe(3)
  })

  it('reads signal 3 out of the SENTINEL ROW and nothing else', () => {
    const s3 = collectSignals(parsed()).find((s) => s.id === 'SIGNAL_3_DATABASE')!
    expect(s3.pointer).toBe('/observation/sentinelObservation/projectRef')
    expect(s3.origin).toContain('PostgreSQL')
  })

  it('refuses when the sentinel names a different project than the declaration', () => {
    // THE CONTROL FOR `signal3 = signal2`. An implementation that filled signal 3
    // from the declaration would return a PASS here, because the two would be
    // equal by construction.
    const v = evaluate(
      corroboration({}, { sentinelObservation: { ...SENTINEL_OK, projectRef: 'aaaaaaaaaaaaaaaaaaaa' } }),
    )
    expect(v.checkpointPassed).toBe(false)
    expect(v.targetVerification?.code).toBe('HOSTED_TARGET_SENTINEL_MISMATCH')
  })

  it('refuses a sentinel with no project ref rather than borrowing the declaration', () => {
    const v = evaluate(corroboration({}, { sentinelObservation: { ...SENTINEL_OK, projectRef: null } }))
    expect(v.refusal?.code).toBe('A1_SENTINEL_MALFORMED')
    expect(v.refusal?.detail).toContain('IT IS SIGNAL 3 AND IT HAS NO FALLBACK')
  })

  it('refuses when the pooler login role names a different project than the declaration', () => {
    const v = evaluate(
      corroboration({
        connection: {
          connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
          poolerUser: 'postgres.aaaaaaaaaaaaaaaaaaaa',
          connectionPort: 5432,
        },
      }),
    )
    expect(v.checkpointPassed).toBe(false)
    expect(v.targetVerification?.code).toBe('HOSTED_TARGET_PROJECT_REF_MISMATCH')
  })

  it('refuses a connection host and a login role that contradict each other', () => {
    const v = evaluate(
      corroboration({
        connection: { connectionHost: `db.${REF}.supabase.co`, poolerUser: 'postgres.aaaaaaaaaaaaaaaaaaaa' },
      }),
    )
    expect(v.targetVerification?.code).toBe('HOSTED_TARGET_IDENTITY_CONTRADICTION')
  })
})

/* -------------------------------------------------------------------------- */
/* GAP B — the connection is the operator's, and it is metadata only            */
/* -------------------------------------------------------------------------- */

describe('the connection identity the database cannot report', () => {
  it('refuses a corroboration with no connectionHost', () => {
    const v = evaluate(corroboration({ connection: { poolerUser: `postgres.${REF}` } }))
    expect(v.refusal?.code).toBe('A1_CONNECTION_HOST_MISSING')
  })

  it('refuses a corroboration with no poolerUser', () => {
    const v = evaluate(corroboration({ connection: { connectionHost: `db.${REF}.supabase.co` } }))
    expect(v.refusal?.code).toBe('A1_POOLER_USER_MISSING')
  })

  it('refuses a pasted connection string in the host field instead of mining it for a host', () => {
    const v = evaluate(
      corroboration({
        connection: {
          connectionHost: `postgresql://postgres.${REF}@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
          poolerUser: `postgres.${REF}`,
        },
      }),
    )
    expect(v.refusal?.code).toBe('A1_CONNECTION_HOST_MALFORMED')
  })

  it('refuses a login role that is not exactly postgres.<ref>', () => {
    const v = evaluate(corroboration({ connection: { connectionHost: `db.${REF}.supabase.co`, poolerUser: 'postgres' } }))
    expect(v.refusal?.code).toBe('A1_POOLER_USER_MALFORMED')
  })

  it('refuses a field NAMED like a credential, whatever it holds', () => {
    for (const key of ['password', 'DATABASE_URL', 'apiKey', 'serviceRoleKey', 'token']) {
      const v = evaluate(
        corroboration({
          connection: {
            connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
            poolerUser: `postgres.${REF}`,
            [key]: 'anything at all',
          },
        }),
      )
      expect(v.refusal?.code, key).toBe('A1_CORROBORATION_CARRIES_SECRET')
    }
  })

  it('refuses a value SHAPED like a credential even under an innocent name', () => {
    const v = evaluate(
      corroboration({
        note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghij',
      }),
    )
    expect(v.refusal?.code).toBe('A1_CORROBORATION_CARRIES_SECRET')
  })

  it('accepts the transaction pooler port as a REFUSAL, not as a detail', () => {
    const v = evaluate(
      corroboration({
        connection: {
          connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
          poolerUser: `postgres.${REF}`,
          connectionPort: 6543,
        },
      }),
    )
    expect(v.targetVerification?.code).toBe('HOSTED_TARGET_POOLER_TRANSACTION_MODE')
  })
})

/* -------------------------------------------------------------------------- */
/* PRODUCTION                                                                  */
/* -------------------------------------------------------------------------- */

describe('production is refused before the target is accepted', () => {
  it('refuses a declaration naming the production project', () => {
    const v = evaluate(
      corroboration(
        { declaredProjectRef: PROD, connection: { connectionHost: `db.${PROD}.supabase.co`, poolerUser: `postgres.${PROD}` } },
        { targetProjectRef: PROD, sentinelObservation: { ...SENTINEL_OK, projectRef: PROD } },
      ),
      { expectedProjectRef: PROD },
    )
    expect(v.refusal?.code).toBe('A1_PRODUCTION_REF')
  })

  it('refuses a SENTINEL naming production even when everything else says staging', () => {
    const v = evaluate(corroboration({}, { sentinelObservation: { ...SENTINEL_OK, projectRef: PROD } }))
    expect(v.refusal?.code).toBe('A1_PRODUCTION_REF')
  })

  it('refuses a pooler login role naming production', () => {
    const v = evaluate(
      corroboration({
        connection: { connectionHost: 'aws-0-us-east-2.pooler.supabase.com', poolerUser: `postgres.${PROD}` },
      }),
    )
    expect(v.refusal?.code).toBe('A1_PRODUCTION_REF')
  })

  it('MUTATION: with the production veto removed, the PIN still refuses production', () => {
    // The veto is one control, not the only one. Deleting the denylist must not
    // turn a production target into a pass — the expected-project pin catches it,
    // and A1 provisions exactly one project.
    const v = evaluate(
      corroboration(
        { declaredProjectRef: PROD, connection: { connectionHost: `db.${PROD}.supabase.co`, poolerUser: `postgres.${PROD}` } },
        { targetProjectRef: PROD, sentinelObservation: { ...SENTINEL_OK, projectRef: PROD } },
      ),
      { production: { hosts: [], projectRefs: [] } },
    )
    expect(v.checkpointPassed).toBe(false)
    expect(v.refusal?.code).toBe('A1_OBSERVATION_REF_MISMATCH')
  })
})

/* -------------------------------------------------------------------------- */
/* GAP A — the sentinel row                                                    */
/* -------------------------------------------------------------------------- */

describe('the sentinel row, and exactly one of it', () => {
  it('refuses zero rows — S2 is a human act and it has not happened', () => {
    const v = evaluate(
      corroboration({}, { sentinelObservation: { ...SENTINEL_OK, rowCount: 0, id: null, projectRef: null } }),
    )
    expect(v.refusal?.code).toBe('A1_SENTINEL_ROW_COUNT')
    expect(v.refusal?.detail).toContain('EMPTY')
  })

  it('refuses more than one row — the singleton CHECK should have made it impossible', () => {
    const v = evaluate(corroboration({}, { sentinelObservation: { ...SENTINEL_OK, rowCount: 2 } }))
    expect(v.refusal?.code).toBe('A1_SENTINEL_ROW_COUNT')
  })

  it('refuses an absent sentinel TABLE', () => {
    const v = evaluate(corroboration({}, { sentinelObservation: { ...SENTINEL_OK, tablePresent: false } }))
    expect(v.refusal?.code).toBe('A1_SENTINEL_TABLE_ABSENT')
  })

  it('refuses a row that does not declare itself staging', () => {
    const v = evaluate(corroboration({}, { sentinelObservation: { ...SENTINEL_OK, environment: 'production' } }))
    expect(v.refusal?.code).toBe('A1_SENTINEL_MALFORMED')
  })

  it('refuses a row whose bootstrap_version is not the package that created it', () => {
    const v = evaluate(corroboration({}, { sentinelObservation: { ...SENTINEL_OK, bootstrapVersion: 'stella_hosted_0002' } }))
    expect(v.refusal?.code).toBe('A1_SENTINEL_MALFORMED')
  })

  it('refuses a row that does not record RR-02', () => {
    const v = evaluate(
      corroboration({}, { sentinelObservation: { ...SENTINEL_OK, ownerSeparation: 'clean separation', rr02Present: false } }),
    )
    expect(v.refusal?.code).toBe('A1_SENTINEL_MALFORMED')
  })

  it('refuses a row whose rr02Present contradicts its own owner_separation text', () => {
    const v = evaluate(
      corroboration({}, { sentinelObservation: { ...SENTINEL_OK, ownerSeparation: 'clean separation', rr02Present: true } }),
    )
    expect(v.refusal?.code).toBe('A1_SENTINEL_SELF_CONTRADICTORY')
  })

  it('refuses a missing bootstrap schema', () => {
    const v = evaluate(corroboration({}, { bootstrapSchemaPresent: false }))
    expect(v.refusal?.code).toBe('A1_BOOTSTRAP_SCHEMA_ABSENT')
  })

  it('refuses a baseline ledger that describes a different project', () => {
    const v = evaluate(corroboration({}, { baselineJournal: { ...JOURNAL_OK, projectRefs: [REF, 'aaaaaaaaaaaaaaaaaaaa'] } }))
    expect(v.refusal?.code).toBe('A1_JOURNAL_FOREIGN_PROJECT')
  })

  it('refuses an incomplete baseline through the RUNNER, not through a second rule here', () => {
    const v = evaluate(
      corroboration({}, { baselineJournal: { ...JOURNAL_OK, units: JOURNAL_OK.units.slice(0, 40) } }),
    )
    expect(v.checkpointPassed).toBe(false)
    expect(v.chainPlan?.code).toBe('PROVISIONING_BASELINE_INCOMPLETE')
  })
})

/* -------------------------------------------------------------------------- */
/* THE NINE PACKAGES                                                           */
/* -------------------------------------------------------------------------- */

describe('exactly the declared packages, each measured', () => {
  it('refuses one short', () => {
    const v = evaluate(corroboration({}, { packageObservations: packageObservations().slice(0, -1) }))
    expect(v.refusal?.code).toBe('A1_PACKAGE_COUNT')
  })

  it('refuses one too many', () => {
    const v = evaluate(
      corroboration({}, { packageObservations: [...packageObservations(), { packageId: T1, witnesses: {} }] }),
    )
    expect(v.refusal?.code).toBe('A1_PACKAGE_COUNT')
  })

  it('refuses a package the chain does not contain', () => {
    const obs = packageObservations()
    obs[0] = { packageId: 'stella_9999_invented', witnesses: {} }
    const v = evaluate(corroboration({}, { packageObservations: obs }))
    expect(v.refusal?.code).toBe('A1_PACKAGE_UNKNOWN')
  })

  it('refuses the same package observed twice', () => {
    const obs = packageObservations()
    obs[1] = { ...obs[0] }
    const v = evaluate(corroboration({}, { packageObservations: obs }))
    expect(v.refusal?.code).toBe('A1_PACKAGE_DUPLICATED')
  })

  it('refuses a witness set that is not the declared one — a wrong ARITY is a wrong key', () => {
    const obs = packageObservations()
    const t8 = obs.find((p) => p.packageId === T8)! as { witnesses: Record<string, boolean> }
    const tenArg = Object.keys(t8.witnesses).find((k) => k.includes('settle_reserved_quota'))!
    delete t8.witnesses[tenArg]
    t8.witnesses['regprocedure:uellix_stella.settle_reserved_quota(uuid,uuid,character varying,character,character)'] = true
    const v = evaluate(corroboration({}, { packageObservations: obs }))
    expect(v.refusal?.code).toBe('A1_WITNESS_SET_MISMATCH')
  })

  it('MUTATION: a witness key simply MISSING is refused, never read as false', () => {
    const obs = packageObservations()
    const t6 = obs.find((p) => p.packageId === T6)! as { witnesses: Record<string, boolean> }
    delete t6.witnesses[Object.keys(t6.witnesses)[0]!]
    const v = evaluate(corroboration({}, { packageObservations: obs }))
    expect(v.refusal?.code).toBe('A1_WITNESS_SET_MISMATCH')
    expect(v.refusal?.detail).toContain('unknown')
  })

  it('refuses a witness value that is not a boolean', () => {
    const obs = packageObservations()
    const t1 = obs[0] as { witnesses: Record<string, unknown> }
    t1.witnesses[Object.keys(t1.witnesses)[0]!] = 'yes'
    const v = evaluate(corroboration({}, { packageObservations: obs }))
    expect(v.refusal?.code).toBe('A1_WITNESS_TYPE')
  })

  it('refuses a witness reported both present and absent by two packages', () => {
    // Legal only because a witness may be declared by more than one package; the
    // probe measures it with the same expression each time, so two answers can
    // only come from a hand edit.
    const shared = negatives(T6)[0]!
    const obs = packageObservations([shared]) as { packageId: string; witnesses: Record<string, boolean> }[]
    const extra = { packageId: T5, witnesses: { ...obs.find((p) => p.packageId === T5)!.witnesses, [shared]: false } }
    const t6 = obs.find((p) => p.packageId === T6)!
    t6.witnesses[shared] = true
    extra.witnesses[shared] = false
    const rebuilt = obs.map((p) => (p.packageId === T5 ? extra : p))
    // T5 now declares the key too, which is itself a set mismatch — the point is
    // only that a contradiction cannot pass; the parser names whichever it meets.
    const v = evaluate(corroboration({}, { packageObservations: rebuilt }))
    expect(['A1_WITNESS_CONTRADICTION', 'A1_WITNESS_SET_MISMATCH']).toContain(v.refusal?.code)
  })
})

describe('partial and inconsistent states reach the runner as nothing at all', () => {
  it('T6 with one of four new signatures is PARTIAL, and A1 refuses', () => {
    const v = evaluate(corroboration({}, { packageObservations: packageObservations([positives(T6)[0]!]) }))
    expect(v.packageStates[T6]).toBe('PARTIAL_OR_INCONSISTENT')
    expect(v.partialPackages).toEqual([T6])
    expect(v.checkpointPassed).toBe(false)
    expect(blockerText(v)).toContain('WITNESS_PARTIAL_STATE')
  })

  it('T6 with all four new AND an old project-blind signature standing is INCONSISTENT', () => {
    const v = evaluate(
      corroboration({}, { packageObservations: packageObservations([...positives(T6), negatives(T6)[0]!]) }),
    )
    expect(v.packageStates[T6]).toBe('PARTIAL_OR_INCONSISTENT')
    expect(v.checkpointPassed).toBe(false)
  })

  it('MUTATION: there is no partial -> false path, so no plan is produced at all', () => {
    const v = evaluate(corroboration({}, { packageObservations: packageObservations([positives(T8)[0]!]) }))
    expect(v.chainPlan).toBeNull()
    expect(blockerText(v)).toContain('half-installed package is not an absent one')
  })

  it('MUTATION: ALL, not ANY — one positive of four never reads as installed', () => {
    for (const pkg of [T2, T5, T6]) {
      const v = evaluate(corroboration({}, { packageObservations: packageObservations([positives(pkg)[0]!]) }))
      expect(v.packageStates[pkg], pkg).not.toBe('INSTALLED')
    }
  })
})

describe('the successor discrimination the whole registry exists for', () => {
  const BASE = [...positives(T1), ...positives(T2), ...positives(T3), ...positives(T4)]

  it('T7 installed does NOT make T8 installed — five arguments are not ten', () => {
    const present = [...BASE, ...positives(T5), ...positives(T6), ...positives(T7)]
    const v = evaluate(corroboration({}, { packageObservations: packageObservations(present) }))
    expect(v.packageStates[T7]).toBe('INSTALLED')
    expect(v.packageStates[T8]).toBe('ABSENT')
    expect(v.chainPlan?.steps).toEqual([T8, T9, T10, T11])
  })

  it('T9 installed with the three-argument bind still standing is CORRECT — stella_0018 re-creates it', () => {
    const present = [
      ...BASE,
      ...positives(T5),
      ...positives(T6),
      ...positives(T7),
      ...positives(T8),
      ...positives(T9),
      // T10 is M-8's forward repair, and its witness is a routine BODY rather
      // than an object: nothing about the catalogue distinguishes a repaired
      // claim_active_document_version from the one grounding_0002 published.
      // Including it here is what makes "every package installed" mean the
      // repair too, instead of nine objects and an unmeasured tenth.
      ...positives(T10),
      // T11 is M-2's repair, and its witness is a routine BODY for the same
      // reason: can_write_evidence_object is a BASELINE function, so nothing
      // in the catalogue tells a two-role body from a four-role one.
      ...positives(T11),
    ]
    const v = evaluate(corroboration({}, { packageObservations: packageObservations(present) }))
    expect(v.packageStates[T9]).toBe('INSTALLED')
    expect(v.packageStates[T10]).toBe('INSTALLED')
    expect(v.packageStates[T11]).toBe('INSTALLED')
    expect(v.partialPackages).toEqual([])
    // Every package installed: the runner reports the sequence complete and plans
    // nothing, which is a PASS and not a refusal.
    expect(v.chainPlan?.stepCount).toBe(0)
    expect(v.chainPlan?.sequenceComplete).toBe(true)
    expect(v.checkpointPassed).toBe(true)
  })

  it('a successor already installed leaves the runner to decide, and it plans only the rest', () => {
    const present = [...BASE, ...positives(T5), ...positives(T6)]
    const v = evaluate(corroboration({}, { packageObservations: packageObservations(present) }))
    expect(v.chainPlan?.steps).toEqual([T7, T8, T9, T10, T11])
    expect(v.warnings.join(' ')).toContain('ALREADY INSTALLED')
  })
})

/* -------------------------------------------------------------------------- */
/* FLAGS                                                                       */
/* -------------------------------------------------------------------------- */

describe('the nine flags, fail-closed', () => {
  it('STELLA_ENABLED=true refuses through the runner', () => {
    const v = evaluate(corroboration({ featureFlags: { ...FLAGS_OFF, STELLA_ENABLED: 'true' } }))
    expect(v.checkpointPassed).toBe(false)
    expect(v.chainPlan?.code).toBe('PROVISIONING_FEATURE_FLAG_ENABLED')
    expect(v.flags?.enabled).toEqual(['STELLA_ENABLED'])
  })

  it('every one of the nine refuses on its own', () => {
    for (const flag of STELLA_FEATURE_FLAGS) {
      const v = evaluate(corroboration({ featureFlags: { ...FLAGS_OFF, [flag]: 'true' } }))
      expect(v.chainPlan?.code, flag).toBe('PROVISIONING_FEATURE_FLAG_ENABLED')
    }
  })

  it('an unrecognised value counts as ENABLED — a typo that reads as off is never found', () => {
    const v = evaluate(corroboration({ featureFlags: { ...FLAGS_OFF, STELLA_ENABLED: 'maybe' } }))
    expect(v.chainPlan?.code).toBe('PROVISIONING_FEATURE_FLAG_ENABLED')
  })

  it('a flag nobody recorded is REFUSED, not read as false', () => {
    const partial = { ...FLAGS_OFF }
    delete (partial as Record<string, unknown>).STELLA_ENABLED
    const v = evaluate(corroboration({ featureFlags: partial }))
    expect(v.refusal?.code).toBe('A1_FLAGS_INCOMPLETE')
  })

  it('a flag the contract does not contain is refused rather than ignored', () => {
    const v = evaluate(corroboration({ featureFlags: { ...FLAGS_OFF, STELLA_INVENTED_ENABLED: 'false' } }))
    expect(v.refusal?.code).toBe('A1_FLAGS_MALFORMED')
  })
})

/* -------------------------------------------------------------------------- */
/* UNIT 41, AND THE ARTEFACT ITSELF                                            */
/* -------------------------------------------------------------------------- */

describe('unmeasured is refused, everywhere it can be', () => {
  it('refuses when unit 41 has not been measured', () => {
    const v = evaluate(corroboration(), { storageUnitState: null })
    expect(v.checkpointPassed).toBe(false)
    expect(blockerText(v)).toContain('A1_STORAGE_UNIT_UNMEASURED')
  })

  it('refuses through the runner when unit 41 is applied but unverified', () => {
    const v = evaluate(corroboration(), { storageUnitState: 'UNIT_41_POLICIES_APPLIED_UNVERIFIED' })
    expect(v.chainPlan?.code).toBe('PROVISIONING_BASELINE_INCOMPLETE')
    expect(v.warnings.join(' ')).toContain('UNIT_41_POLICIES_APPLIED_UNVERIFIED')
  })

  it('an absent artefact is not a failure and not a pass', () => {
    const v = evaluate(null)
    expect(v.corroborationPresent).toBe(false)
    expect(v.refusal?.code).toBe('A1_CORROBORATION_ABSENT')
    expect(v.checkpointPassed).toBe(false)
  })

  it('refuses JSON that is not an object, and an object missing a top-level field', () => {
    expect(evaluate('[]').refusal?.code).toBe('A1_CORROBORATION_MALFORMED')
    expect(evaluate('not json').refusal?.code).toBe('A1_CORROBORATION_MALFORMED')
    const stripped = JSON.parse(corroboration()) as Record<string, unknown>
    delete stripped.observation
    expect(evaluate(JSON.stringify(stripped)).refusal?.code).toBe('A1_CORROBORATION_INCOMPLETE')
  })

  it('refuses a probe run declaring one project and an envelope declaring another', () => {
    const v = evaluate(corroboration({}, { targetProjectRef: 'aaaaaaaaaaaaaaaaaaaa' }))
    expect(v.refusal?.code).toBe('A1_OBSERVATION_REF_MISMATCH')
  })
})

/* -------------------------------------------------------------------------- */
/* THE GENERATED PROBE                                                         */
/* -------------------------------------------------------------------------- */

describe('the probe on disk is the probe the registry describes', () => {
  it('regenerates byte-identically', () => {
    const onDisk = read(A1_OBSERVATION_SQL)
    expect(onDisk, `${A1_OBSERVATION_SQL} is missing — run pnpm a1:observation:generate`).not.toBeNull()
    expect(onDisk!.replace(/\r\n?/g, '\n')).toBe(buildA1CorroborationSql())
  })

  it('is READ ONLY, rolls back, and pins an empty search_path', () => {
    const sql = buildA1CorroborationSql()
    expect(sql).toContain('BEGIN READ ONLY;')
    expect(sql).toContain("SET LOCAL search_path = '';")
    expect(sql.trimEnd().endsWith('ROLLBACK;')).toBe(true)
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\s+(?!POLICY IF)/i)
  })

  it('declares the staging target and vetoes production by name', () => {
    const sql = buildA1CorroborationSql()
    expect(sql).toContain(KNOWN_STAGING_PROJECT_REF)
    expect(sql).toContain(PROD)
  })

  it('reports NEITHER connectionHost NOR poolerUser — they are client-side facts', () => {
    const sql = buildA1CorroborationSql()
    expect(sql).not.toMatch(/'connectionHost'\s*,/)
    expect(sql).not.toMatch(/'poolerUser'\s*,/)
  })

  it('emits one arm per witness, keyed exactly as the classifier keys them', () => {
    const sql = buildA1CorroborationSql()
    for (const w of Object.values(PACKAGE_WITNESSES).flatMap((e: PackageWitnesses) => [
      ...e.requiredPresentWhenInstalled,
      ...e.requiredAbsentWhenInstalled,
    ])) {
      expect(sql, witnessKey(w)).toContain(`'${witnessKey(w)}'`)
    }
  })

  it('resolves every function by to_regprocedure and never by name alone', () => {
    const sql = buildA1CorroborationSql()
    expect(sql).not.toContain('p.proname =')
    expect(sql).toContain('to_regprocedure')
  })

  it('reads the sentinel ROW, not only its count', () => {
    const sql = buildA1CorroborationSql()
    expect(sql).toContain('s.project_ref')
    expect(sql).toContain('s.bootstrap_version')
    expect(sql).toContain('s.owner_separation')
  })

  it('MUTATION: a registry missing a package cannot generate a probe', () => {
    const mutated = JSON.parse(JSON.stringify(PACKAGE_WITNESSES)) as Record<string, PackageWitnesses>
    delete mutated[T9]
    expect(() => buildA1CorroborationSql(mutated)).toThrow(/refusing to generate/)
  })
})

/* -------------------------------------------------------------------------- */
/* THE STATUS ARTEFACT                                                         */
/* -------------------------------------------------------------------------- */

describe('the status is derived, and an edited one fails verification', () => {
  const status = (raw: string | null, extra: Partial<Parameters<typeof computeA1Status>[0]> = {}) =>
    computeA1Status({
      raw,
      readBaselineSql: read,
      stellaSources: STELLA_SOURCES,
      storageUnitState: 'UNIT_41_COMPLETE',
      ...extra,
    })

  it('reports everything CHECKPOINT A1 is asked to report', () => {
    const s = status(corroboration())
    expect(Object.keys(s)).toEqual([
      'generatedBy',
      'checkpoint',
      'corroborationArtefact',
      'corroborationPresent',
      'signals',
      'targetVerification',
      'sentinelVerification',
      'packageCount',
      'packageStates',
      'partialPackages',
      'flags',
      'chainPlan',
      'blockers',
      'warnings',
      'checkpointPassed',
    ])
    expect(s.checkpointPassed).toBe(true)
    expect(s.packageCount).toBe(WITNESSED_PACKAGES.length)
    expect((s.chainPlan as { stepCount: number }).stepCount).toBe(WITNESSED_PACKAGES.length)
  })

  it('records checkpointPassed=false, with blockers, when the corroboration is absent', () => {
    const s = status(null)
    expect(s.corroborationPresent).toBe(false)
    expect(s.checkpointPassed).toBe(false)
    expect((s.blockers as string[])[0]).toContain('A1_CORROBORATION_ABSENT')
  })

  it('is a pure function of its inputs — the same corroboration serializes identically', () => {
    expect(serializeA1Status(status(corroboration()))).toBe(serializeA1Status(status(corroboration())))
  })

  it('verifies green when the status is absent, and refuses once it is edited', () => {
    const expected = serializeA1Status(status(corroboration()))

    expect(verifyA1Status(null, expected)).toMatchObject({ ok: true, present: false })
    expect(verifyA1Status(expected, expected)).toMatchObject({ ok: true, present: true })
    // A checkout may change line endings; a verdict may not.
    expect(verifyA1Status(expected.replace(/\n/g, '\r\n'), expected).ok).toBe(true)

    const edited = JSON.parse(expected) as Record<string, unknown>
    const tampered = `${JSON.stringify({ ...edited, checkpointPassed: true, blockers: [] }, null, 2)}\n`
    const r = verifyA1Status(tampered, serializeA1Status(status(corroboration({ featureFlags: { ...FLAGS_OFF, STELLA_ENABLED: 'true' } }))))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.note).toContain('DIVERGED')
  })

  /*
   * ONE round trip through the real script, because everything above tests the
   * functions and nothing above tests that the CLI calls them.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS TEST ASKS PERMISSION BEFORE IT WRITES ANYTHING
   * ---------------------------------------------------------------------------
   * The first version did not, and it was a near-miss with teeth. It asserted
   * the two artefacts were absent, wrote fixtures over their real paths, and
   * deleted both in a `finally`. That was correct exactly once — on a repository
   * where CHECKPOINT A1 had not been measured. The moment the operator recorded
   * the real corroboration and it was committed, `pnpm test` DELETED THE
   * COMMITTED EVIDENCE and failed on the assertion instead of the deletion.
   * Recoverable from git, and it should never have been reachable: the whole
   * reason `S1_EVIDENCE_REGISTRY` exists is that a measurement which can only be
   * taken once must not share a path with anything a process writes casually.
   *
   * So the destructive path is now GUARDED rather than commented against. With
   * real evidence present the test asserts the stronger property anyway — that
   * the COMMITTED status is what the contract computes over the COMMITTED
   * corroboration, through the CLI — and touches nothing.
   */
  const corroborationPath = path.join(ROOT, A1_CORROBORATION_ARTEFACT)
  const statusPath = path.join(ROOT, A1_STATUS_ARTEFACT)

  const runScript = (mode: string): { code: number; out: string } => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [TSX_CLI, 'scripts/a1-status.ts', mode], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      }
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string }
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
    }
  }

  const measured = existsSync(corroborationPath)

  it.runIf(measured)(
    'the recorded verdict is what the CLI computes over the recorded corroboration',
    { timeout: 180_000 },
    () => {
      // READ ONLY. Nothing below writes or removes a file.
      expect(runScript('verify').code).toBe(0)

      // Through `computeRecordedA1Status`, which is what the CLI calls. Using
      // the plain `status()` helper here would evaluate the committed artefact
      // against TODAY'S chain while `:verify` evaluated it against the chain it
      // measured, and the difference would be reported as a drift in the file
      // rather than as the two functions disagreeing.
      const onDisk = readFileSync(statusPath, 'utf8').replace(/\r\n?/g, '\n')
      expect(onDisk).toBe(
        serializeA1Status(
          computeRecordedA1Status({
            raw: readFileSync(corroborationPath, 'utf8'),
            readBaselineSql: read,
            stellaSources: STELLA_SOURCES,
            storageUnitState: 'UNIT_41_COMPLETE',
          }),
        ),
      )

      const recorded = JSON.parse(onDisk) as Record<string, unknown>

      // THE MEASUREMENT IS UNCHANGED AND THE VERDICT IS NOT, which is the whole
      // point of keeping them in two files.
      //
      // The operator's probe observed NINE packages on 2026-08-11 and found
      // every one ABSENT — a correct measurement of a nine-package chain, and it
      // stays exactly as recorded. M-8 then added a tenth, and grounding_0005
      // SUPERSEDES grounding_0002: the runner will not plan the application of a
      // package whose successor's state nobody has probed, because re-applying
      // grounding_0002 over an installed grounding_0005 republishes the row lock
      // M-8 removed. So the derived verdict is now a refusal, and it names the
      // package nobody looked for.
      //
      // The alternative — adding a tenth observation to the artefact so the old
      // verdict held — would have been a fabricated measurement: an operator
      // session, dated before grounding_0005 existed, reporting it absent.
      //
      // The BASELINE corpus (db/hosted/baseline-manifest.ts) has since grown to
      // 64 units, and this corroboration was never re-measured against the new
      // ones either. planProvisioningPhase now refuses at the EARLIER,
      // more-fundamental PROVISIONING_BASELINE_INCOMPLETE gate before it ever
      // reaches the grounding_0005/grounding_0002 supersession check the
      // narrative above describes — a stricter, not weaker, refusal. The
      // checkpoint's verdict (checkpointPassed) is unchanged: false either way.
      expect(recorded.packageCount).toBe(A1_OBSERVED_CHAIN.length)
      expect(recorded.partialPackages).toEqual([])
      expect(recorded.checkpointPassed).toBe(false)
      expect((recorded.blockers as string[]).join(' ')).toContain('PROVISIONING_BASELINE_INCOMPLETE')
      expect((recorded.blockers as string[]).join(' ')).toContain('0040_governed_model_registry.sql')
      expect((recorded.warnings as string[]).join(' ')).toContain('did not exist when it was measured')

      // And the STALENESS is a fact about coverage, not about the target: every
      // package the probe DID measure is still recorded absent.
      expect(
        Object.entries(recorded.packageStates as Record<string, string>)
          .filter(([p]) => A1_OBSERVED_CHAIN.includes(p))
          .map(([, s]) => s),
      ).toEqual(A1_OBSERVED_CHAIN.map(() => 'ABSENT'))
    },
  )

  it.runIf(!measured)(
    'the script writes what the contract computes, refuses without one, and fails on a tampered file',
    { timeout: 180_000 },
    () => {
      try {
        expect(existsSync(corroborationPath)).toBe(false)
        expect(existsSync(statusPath)).toBe(false)

        const refused = runScript('write')
        expect(refused.code).toBe(1)
        expect(refused.out).toContain('REFUSED')
        expect(existsSync(statusPath)).toBe(false)

        writeFileSync(corroborationPath, `${corroboration()}\n`, 'utf8')
        expect(runScript('write').code).toBe(0)
        expect(readFileSync(statusPath, 'utf8').replace(/\r\n?/g, '\n')).toBe(
          serializeA1Status(status(`${corroboration()}\n`)),
        )
        expect(runScript('verify').code).toBe(0)

        const written = JSON.parse(readFileSync(statusPath, 'utf8')) as Record<string, unknown>
        writeFileSync(
          statusPath,
          `${JSON.stringify({ ...written, blockers: ['nothing to see here'] }, null, 2)}\n`,
          'utf8',
        )
        const tampered = runScript('verify')
        expect(tampered.code).toBe(1)
        expect(tampered.out).toContain('DIVERGED')
      } finally {
        // Only ever removes files this branch created — it does not run at all
        // when a real corroboration is present.
        rmSync(corroborationPath, { force: true })
        rmSync(statusPath, { force: true })
      }
    },
  )

  it('the observed chain is a PREFIX of the declared one, and refuses anything else', () => {
    // The guard that keeps A1_OBSERVED_CHAIN from becoming a place to make a
    // stale verdict look current. A prefix cannot skip a package, cannot
    // reorder one, and cannot name one the chain never declared — so the only
    // thing it can say is "the chain, as far as it went at the time".
    expect(() => assertA1ObservedChainIsPrefix()).not.toThrow()
    expect(a1UncoveredPackages()).toEqual(WITNESSED_PACKAGES.slice(A1_OBSERVED_CHAIN.length))

    // A gap in the middle — the shape that would let a checkpoint claim to have
    // cleared a sequence it never looked into the middle of.
    expect(() =>
      assertA1ObservedChainIsPrefix([WITNESSED_PACKAGES[0]!, WITNESSED_PACKAGES[2]!]),
    ).toThrow(A1ObservedChainRefusal)

    // A package the chain does not declare.
    expect(() => assertA1ObservedChainIsPrefix(['grounding_9999_invented'])).toThrow(
      A1ObservedChainRefusal,
    )

    // And longer than the chain, which cannot be an observation of it.
    expect(() => assertA1ObservedChainIsPrefix([...WITNESSED_PACKAGES, 'one_more'])).toThrow(
      A1ObservedChainRefusal,
    )
    expect(() => assertA1ObservedChainIsPrefix([])).toThrow(A1ObservedChainRefusal)
  })

  it('no test in this file may write over a real measurement', () => {
    // THE GUARD ITSELF, asserted. A future edit that drops `runIf` and writes
    // unconditionally has to delete this line to get green, which is a thing a
    // reviewer can see.
    if (!measured) return
    expect(readFileSync(corroborationPath, 'utf8').length).toBeGreaterThan(0)
    expect(runScript('verify').code).toBe(0)
  })
})

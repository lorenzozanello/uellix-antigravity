// tests/hosted/measured-evidence.test.ts
// TRAIN 5C2 — the tests that make a status report unable to disagree with the
// gate it describes.
//
// The defect: a report stated "17 criteria, 1 blocking" while also stating that
// the psql read-only attestation was UNCONFIRMED and still blocking. Both cannot
// hold. The number came from `satisfying()` — a unit-test fixture describing a
// hypothetical project — and nothing in the repository had ever evaluated the
// gate against the evidence actually recorded.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  APPLY_AUTHORIZATION_CRITERIA,
  evaluateApplyAuthorization,
} from '@/db/hosted/baseline-apply-authorization'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  KNOWN_STAGING_PROJECT_REF,
  projectRefFromPoolerUser,
} from '@/db/hosted/target-identity'
import {
  APPLY_IDENTITY_ARTEFACT,
  APPLY_STATUS_ARTEFACT,
  CHECKPOINT_A0_ARTEFACT,
  CHECKPOINT_A0_SQL,
  SQL_EDITOR_ARTEFACT,
  loadMeasuredEvidence,
} from '@/db/hosted/measured-evidence'

const ROOT = process.cwd()
const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}
const readJson = (rel: string): unknown | null => {
  const raw = read(rel)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function discovered(): string[] {
  const dirs: [string, (n: string) => boolean][] = [
    ['db/migrations', (n) => /^\d{4}_.*\.sql$/.test(n)],
    ['supabase/migrations', (n) => n.endsWith('.sql')],
    ['db/policies', (n) => n.endsWith('.sql')],
  ]
  const out: string[] = []
  for (const [dir, accept] of dirs) {
    let names: string[]
    try {
      names = readdirSync(path.join(ROOT, dir))
    } catch {
      continue
    }
    for (const name of names.sort()) if (accept(name)) out.push(`${dir}/${name}`)
  }
  return out
}

const live = (overrideJson?: (rel: string) => unknown | null) =>
  evaluateApplyAuthorization(
    loadMeasuredEvidence({
      readJson: overrideJson ?? readJson,
      readBaselineSql: read,
      discoveredBaselineFiles: discovered(),
    }).inputs,
  )

const blockingIds = (r: ReturnType<typeof live>) =>
  r.criteria.filter((c) => !c.satisfied).map((c) => c.id)

describe('the psql read-only attestation is a REAL apply criterion', () => {
  // THE AUDIT ANSWER, still asserted — but over an INJECTED UNCONFIRMED rather
  // than the artefact's current value. The operator has since supplied `on`, and
  // a test pinned to the file would now be measuring the evidence instead of the
  // criterion.
  it('blocks while transaction_read_only is UNCONFIRMED', () => {
    const unconfirmed = (rel: string) => {
      const value = readJson(rel)
      if (rel !== APPLY_IDENTITY_ARTEFACT || value === null) return value
      const v = value as { observed: Record<string, unknown> }
      return { ...v, observed: { ...v.observed, transaction_read_only: 'UNCONFIRMED' } }
    }
    expect(blockingIds(live(unconfirmed))).toContain('hosted-storage-apply-identity-probed')
  })

  // …and with the value supplied, that criterion is satisfied on today's real
  // artefacts. The pair is what makes the criterion falsifiable in both
  // directions rather than merely strict.
  it('is satisfied on the artefacts as they now stand', () => {
    expect(blockingIds(live())).not.toContain('hosted-storage-apply-identity-probed')
  })

  it('leaves the blockers the gate actually computes, and names them', () => {
    // UPDATED 2026-08-08. This asserted `length >= 2` while two criteria were
    // blocking — the identity attestation was satisfied, and the point was that
    // satisfying it did not empty the list. Unit 41's canonical boundary has
    // since been verified against the real catalogue, so one of those two is
    // legitimately gone.
    //
    // Replacing the COUNT with the exact remaining id is stronger, not laxer: a
    // count of one could be satisfied by any criterion at all, including this
    // one regressing while another silently passed. The named blocker cannot.
    // UPDATED 2026-08-09. The named blocker is legitimately gone too: the
    // uellix-evidence bucket was created and re-measured by the 2026-08-09
    // Class-C probe, so STAGING_RUNTIME_GATE is satisfied. Every criterion now
    // passes, which is a state this assertion has to be able to express without
    // becoming vacuous — so it pins the EMPTY list AND the count that must have
    // produced it. A silently shrinking criteria set would pass `toEqual([])`
    // and fail the second line.
    expect(blockingIds(live())).toEqual([])
    expect(live().criteria).toHaveLength(APPLY_AUTHORIZATION_CRITERIA.length)
    // …and the criterion this describe block is about is still among the
    // satisfied ones rather than having disappeared from the set.
    expect(live().criteria.map((c) => c.id)).toContain('hosted-storage-apply-identity-probed')
  })

  // TWO THINGS ARE MISSING, AND THE TEST DRIVES BOTH.
  //
  // The artefact records neither the read-only value nor the queries that
  // produced any of its numbers. The gate refuses an attestation without a
  // query before it looks at the value, so both have to be supplied before this
  // criterion can move — and a test that supplied only one would have "passed"
  // while proving nothing about the branch it claimed to exercise.
  const IDENTITY_QUERIES = [
    "SELECT current_user, session_user, version(), current_setting('transaction_read_only');",
    "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER');",
    "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'USAGE');",
    "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'SET');",
  ]
  const withEvidence = (over: Record<string, unknown>, observed: Record<string, unknown> = {}) =>
    (rel: string) => {
      const value = readJson(rel)
      if (rel !== APPLY_IDENTITY_ARTEFACT || value === null) return value
      const v = value as { observed: Record<string, unknown> }
      return { ...v, ...over, observed: { ...v.observed, ...observed } }
    }

  // THE PROPERTY IS INJECTED, NOT INHERITED FROM THE ARTEFACT'S CURRENT VALUE.
  //
  // These two used to read `transaction_read_only` straight from the file, so
  // they broke the moment the operator supplied it — proving they were pinned to
  // a fact about the evidence rather than to the behaviour they claimed to test.
  // The behaviour is: UNCONFIRMED blocks, and supplying it unblocks exactly one
  // criterion. Both states are now driven explicitly.
  it('still blocks when the queries are recorded but the value is UNCONFIRMED', () => {
    const after = blockingIds(
      live(withEvidence({ queries: IDENTITY_QUERIES }, { transaction_read_only: 'UNCONFIRMED' })),
    )
    expect(after).toContain('hosted-storage-apply-identity-probed')
  })

  it('stops blocking once BOTH the query and the value exist — and only that criterion moves', () => {
    const before = blockingIds(
      live(withEvidence({ queries: IDENTITY_QUERIES }, { transaction_read_only: 'UNCONFIRMED' })),
    )
    const after = blockingIds(
      live(withEvidence({ queries: IDENTITY_QUERIES }, { transaction_read_only: 'on' })),
    )
    expect(before).toContain('hosted-storage-apply-identity-probed')
    expect(after).not.toContain('hosted-storage-apply-identity-probed')
    expect(after).toEqual(before.filter((id) => id !== 'hosted-storage-apply-identity-probed'))
  })

  // AND THE OPERATOR'S VALUE IS ACTUALLY IN THE FILE NOW.
  it('reads the supplied transaction_read_only from the artefact', () => {
    const evidence = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(evidence.observed.psql.transactionReadOnly).toBe(true)
  })

  // ONE CRITERION SATISFIED IS NOT AUTHORISATION — driven by removing a
  // DIFFERENT piece of evidence, because the start gate is now satisfied and a
  // test pinned to that would be measuring the artefacts, not the rule.
  it('still refuses the apply when any other attestation is missing', () => {
    const noA0 = (rel: string) => (rel === CHECKPOINT_A0_ARTEFACT ? null : readJson(rel))
    const report = live(noA0)
    expect(blockingIds(report)).toContain('checkpoint-a0-pass')
    expect(report.applyAuthorized).toBe(false)
  })
})

describe('the evidence is READ, not typed', () => {
  // The one transformation the loader must never perform, driven over an
  // artefact that says UNCONFIRMED regardless of what the real file says today.
  it('preserves UNCONFIRMED rather than normalising it to a boolean', () => {
    const evidence = loadMeasuredEvidence({
      readJson: (rel) => {
        const value = readJson(rel)
        if (rel !== APPLY_IDENTITY_ARTEFACT || value === null) return value
        const v = value as { observed: Record<string, unknown> }
        return { ...v, observed: { ...v.observed, transaction_read_only: 'UNCONFIRMED' } }
      },
      readBaselineSql: read,
      discoveredBaselineFiles: discovered(),
    })
    expect(evidence.observed.psql.transactionReadOnly).toBe('UNCONFIRMED')
  })

  it('reports the measured MEMBER / USAGE / SET, all false', () => {
    const { observed } = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(observed.psql).toMatchObject({
      currentUser: 'postgres',
      sessionUser: 'postgres',
      isMember: false,
      inheritsPrivileges: false,
      canSetRole: false,
    })
  })

  it('reports the ACTIVE class-C probes as recorded', () => {
    // UPDATED 2026-08-09. `evidenceBucketExists` was false because the ACTIVE
    // artefact was the 2026-08-07 pre-baseline probe, taken before the bucket
    // existed. The governed ledger now selects the 2026-08-09 re-measurement,
    // and this reads what THAT artefact records.
    //
    // `ownsStorageObjects` stays false across both, which matters: it is the
    // measurement that SELECTED the managed channel for unit 41 PART B, and a
    // re-measurement flipping it would have invalidated that route.
    const { observed } = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(observed.sqlEditor).toEqual({
      ownsStorageObjects: false,
      evidenceBucketExists: true,
      canCreateTriggerOnAuthUsers: true,
    })
  })

  it('refuses when an artefact is absent — absence is not agreement', () => {
    const evidence = loadMeasuredEvidence({
      readJson: (rel) => (rel === APPLY_IDENTITY_ARTEFACT ? null : readJson(rel)),
      readBaselineSql: read,
      discoveredBaselineFiles: discovered(),
    })
    expect(evidence.problems.map((p) => p.file)).toContain(APPLY_IDENTITY_ARTEFACT)
    expect(evidence.observed.psql.transactionReadOnly).toBeNull()
  })

  it('refuses artefacts naming a production project', () => {
    const evidence = loadMeasuredEvidence({
      readJson: (rel) => {
        const value = readJson(rel)
        if (rel !== APPLY_IDENTITY_ARTEFACT || value === null) return value
        return { ...(value as object), targetProjectRef: 'ctaxtgujyyprgynmnvtq' }
      },
      readBaselineSql: read,
      discoveredBaselineFiles: discovered(),
    })
    expect(evidence.problems.map((p) => p.detail).join(' ')).toMatch(/KNOWN PRODUCTION/)
  })

  // REVIEWER A, EXECUTED AGAINST THE FIRST VERSION: deleting all three privilege
  // fields left `hosted-storage-set-role-ready` SATISFIED, citing "MEMBER=false,
  // USAGE=false, SET=false — refuted by catalogue" — a verdict quoting three
  // measurements that no longer existed, because the loader wrote `?? false`.
  it.each(['is_member', 'inherits_privileges', 'can_set_role', 'current_user', 'session_user'])(
    'refuses the whole apply-identity attestation when %s is absent',
    (field) => {
      const evidence = loadMeasuredEvidence({
        readJson: (rel) => {
          const value = readJson(rel)
          if (rel !== APPLY_IDENTITY_ARTEFACT || value === null) return value
          const v = value as { observed: Record<string, unknown> }
          const observed = { ...v.observed }
          delete observed[field]
          return { ...v, observed }
        },
        readBaselineSql: read,
        discoveredBaselineFiles: discovered(),
      })
      expect(evidence.inputs.applyIdentity).toBeNull()
      const ids = evaluateApplyAuthorization(evidence.inputs)
        .criteria.filter((c) => !c.satisfied)
        .map((c) => c.id)
      expect(ids).toContain('hosted-storage-set-role-ready')
      expect(ids).toContain('hosted-storage-apply-identity-probed')
    },
  )

  // Same reviewer, same class: `connectionHost` was built as
  // `db.${projectRef}.supabase.co` — from the very ref the criterion compares it
  // against — so the mismatch branch was unreachable by construction and
  // renaming the project in both artefacts still read as "corroborated".
  it('does not manufacture the corroborating host from the ref it corroborates', () => {
    const evidence = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    const identity = evidence.inputs.stagingIdentity
    // The host is now RECORDED — the operator supplied it — and it is the real
    // Session Pooler host, not `db.${projectRef}.supabase.co` composed from the
    // very ref it is supposed to corroborate.
    expect(identity).not.toBeNull()
    expect(identity!.value.connectionHost).toBe('aws-0-us-east-2.pooler.supabase.com')
    expect(identity!.value.connectionHost).not.toContain(identity!.value.projectRef)
  })

  // A POOLER HOST CANNOT CORROBORATE, AND SAYS SO PRECISELY.
  //
  // `aws-0-<region>.pooler.supabase.com` is regional and shared: the ref lives
  // in the pooler username. Accepting it would not be a small relaxation —
  // every project in the region presents that exact hostname, so the second
  // signal would corroborate nothing at all.
  it('refuses a pooler host as the second signal when no login role is recorded', () => {
    const noRole = (rel: string) => {
      const value = readJson(rel)
      if (rel !== APPLY_IDENTITY_ARTEFACT || value === null) return value
      const v = { ...(value as Record<string, unknown>) }
      delete v.poolerUser
      return v
    }
    const blocker = live(noRole).baselineStartGate.blocking.find(
      (b) => b.id === 'target-identity-corroborated',
    )
    expect(blocker, 'without the login role it must block').toBeDefined()
    expect(blocker!.reason).toMatch(/SESSION POOLER host/)
    expect(blocker!.reason).toMatch(/regional and shared/)
  })

  // …and WITH the login role it corroborates, through the role rather than the host.
  it('corroborates through the login role once it is recorded', () => {
    const c = live().criteria.find((x) => x.id === 'target-identity-corroborated')!
    expect(c.satisfied, c.detail).toBe(true)
    expect(c.detail).toMatch(/Session Pooler login role/)
  })

  it('does not substitute a provenance the artefact does not record', () => {
    const evidence = loadMeasuredEvidence({
      readJson: (rel) => {
        const value = readJson(rel)
        if (value === null) return value
        const v = { ...(value as Record<string, unknown>) }
        delete v.measuredBy
        return v
      },
      readBaselineSql: read,
      discoveredBaselineFiles: discovered(),
    })
    expect(evidence.inputs.classCProbes?.measuredBy ?? '').toBe('')
  })

  // A0 WAS RUN AND PASSED; ONLY ITS RECORD WAS MISSING. The audit asked whether
  // it needed re-execution — it did not — so the values are now ingested from
  // the requirements document, which states each one explicitly. What is still
  // absent is the query text, and that is what keeps the criterion refusing.
  it('ingests CHECKPOINT A0 from its artefact, and it is now satisfied', () => {
    const evidence = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(evidence.inputs.checkpointA0).not.toBeNull()
    expect(evidence.inputs.checkpointA0!.value).toMatchObject({
      result: 'PASS',
      sessionWasReadOnly: true,
      projectIsNew: true,
      stellaSurfaceAbsent: true,
      writesPerformed: 0,
      publicRelationCount: 0,
    })
    expect(evidence.inputs.checkpointA0!.query).toBe(CHECKPOINT_A0_SQL)
    expect(blockingIds(live())).not.toContain('checkpoint-a0-pass')
  })

  // NO DOUBLE STANDARD, driven by INJECTION rather than by the artefact's
  // current state. `zero-production-data` used to read the A0 attestation
  // without demanding its provenance, so an A0 with no recorded query would have
  // satisfied it while `checkpoint-a0-pass` refused the identical object. Strip
  // the query and BOTH must refuse — that is the property, and it survives the
  // evidence changing underneath it.
  it('holds zero-production-data to the same provenance standard as A0 itself', () => {
    const noQuery = (rel: string) => {
      const value = readJson(rel)
      if (rel !== CHECKPOINT_A0_ARTEFACT || value === null) return value
      return { ...(value as object), queries: [] }
    }
    const ids = blockingIds(live(noQuery))
    expect(ids).toContain('checkpoint-a0-pass')
    expect(ids).toContain('zero-production-data')
  })

  it('refuses to invent A0 when its artefact is absent', () => {
    const evidence = loadMeasuredEvidence({
      readJson: (rel) => (rel === CHECKPOINT_A0_ARTEFACT ? null : readJson(rel)),
      readBaselineSql: read,
      discoveredBaselineFiles: discovered(),
    })
    expect(evidence.inputs.checkpointA0).toBeNull()
  })

  it('never records a SET LOCAL ROLE demonstration that was correctly not attempted', () => {
    const evidence = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(evidence.inputs.setLocalRoleDemo).toBeNull()
    expect(evidence.inputs.storagePath).toBe('B-managed-channel')
  })

  it('quotes the queries the artefacts recorded, not the module constants', () => {
    const evidence = loadMeasuredEvidence({
      readJson: (rel) => {
        const value = readJson(rel)
        if (rel !== SQL_EDITOR_ARTEFACT || value === null) return value
        // Blank the recorded SQL: the class-C criterion must then refuse,
        // because it verifies the operator's query — not ours.
        const v = value as { probes: { sql?: string }[] }
        return { ...v, probes: v.probes.map((p) => ({ ...p, sql: '' })) }
      },
      readBaselineSql: read,
      discoveredBaselineFiles: discovered(),
    })
    const report = evaluateApplyAuthorization(evidence.inputs)
    expect(report.criteria.filter((c) => !c.satisfied).map((c) => c.id)).toContain(
      'class-c-probes-affirmative',
    )
  })
})

describe('the report cannot diverge from the gate', () => {
  const onDisk = JSON.parse(read(APPLY_STATUS_ARTEFACT)!) as {
    criterionCount: number
    satisfiedCount: number
    blockingCount: number
    blockingIds: string[]
    applyAuthorized: boolean
    baselineApplied: boolean
    stagingApplied: boolean
    observed: unknown
  }

  it('records the same criterion count the gate defines', () => {
    expect(onDisk.criterionCount).toBe(APPLY_AUTHORIZATION_CRITERIA.length)
  })

  // THE ONE THAT CLOSES THE DEFECT. The published numbers and the computed
  // verdict are the same object; a report quoting anything else fails here.
  it('records exactly the blockers the gate computes over the measured evidence', () => {
    const computed = blockingIds(live())
    expect(onDisk.blockingIds).toEqual(computed)
    expect(onDisk.blockingCount).toBe(computed.length)
    expect(onDisk.satisfiedCount).toBe(APPLY_AUTHORIZATION_CRITERIA.length - computed.length)
  })

  it('records the observed values verbatim', () => {
    const evidence = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(onDisk.observed).toEqual(JSON.parse(JSON.stringify(evidence.observed)))
  })

  // THIS TEST USED TO ASSERT THE DEFECT. It said applyAuthorized "cannot say
  // otherwise" — which was true only because the script published a constant.
  // The invariant that actually matters is that the file and the gate agree,
  // whatever the gate computes.
  it('publishes exactly what the gate computes, in either direction', () => {
    expect(onDisk.applyAuthorized).toBe(live().applyAuthorized)
  })

  it('and authorisation never implies the baseline was applied', () => {
    expect(onDisk.baselineApplied).toBe(false)
    expect(onDisk.stagingApplied).toBe(false)
  })

  it('publishes the blockers the gate computes, and A0 is no longer among them', () => {
    expect(onDisk.blockingIds).toEqual(blockingIds(live()))
    expect(onDisk.blockingIds).not.toContain('checkpoint-a0-pass')
    expect(onDisk.blockingIds).not.toContain('zero-production-data')
  })
})

describe('the canonical CHECKPOINT A0 block, for the re-run the evidence needs', () => {
  it('reads only — nothing in it writes', () => {
    const upper = CHECKPOINT_A0_SQL.toUpperCase()
    for (const forbidden of ['INSERT ', 'UPDATE ', 'DELETE ', 'CREATE ', 'DROP ', 'ALTER ', 'GRANT ']) {
      expect(upper, forbidden).not.toContain(forbidden)
    }
    expect(CHECKPOINT_A0_SQL).toContain('BEGIN READ ONLY;')
    expect(CHECKPOINT_A0_SQL).toContain('ROLLBACK;')
  })

  it('covers every fact the A0 contract names', () => {
    for (const marker of [
      "current_setting('transaction_read_only')",
      'version()',
      "to_regnamespace('auth')",
      "to_regnamespace('public')",
      "to_regprocedure('auth.uid()')",
      "to_regnamespace('uellix_bootstrap')",
      "to_regnamespace('uellix_stella')",
      "to_regclass('public.stella_interactions')",
      'staging_sentinel',
    ]) {
      expect(CHECKPOINT_A0_SQL, marker).toContain(marker)
    }
  })

  // THE ONE THE HISTORICAL RUN DID NOT TAKE. Four absent names cannot tell a new
  // project from a restored dump of a different product.
  it('adds the relation count that distinguishes a new project from a restored one', () => {
    expect(CHECKPOINT_A0_SQL).toContain('public_relation_count')
    expect(CHECKPOINT_A0_SQL).toMatch(/nspname = 'public'/)
  })

  // THE RE-RUN HAPPENED, so the artefact now records the block VERBATIM. Pinning
  // it byte-for-byte is what makes a later edit to the canonical query show up as
  // a KNOWN STALE artefact instead of a silent mismatch between what the gate
  // expects and what was actually executed.
  it('records the canonical block byte-identically as the query that ran', () => {
    const a0 = JSON.parse(readFileSync(path.join(ROOT, CHECKPOINT_A0_ARTEFACT), 'utf8')) as {
      queries: string[]
    }
    expect(a0.queries).toHaveLength(1)
    expect(a0.queries[0]).toBe(CHECKPOINT_A0_SQL)
  })
})

describe('zero-production-data separates the corpus claim from the target claim', () => {
  const withA0 = (over: Record<string, unknown>) => (rel: string) => {
    const value = readJson(rel)
    if (rel !== CHECKPOINT_A0_ARTEFACT || value === null) return value
    const v = value as { observed: Record<string, unknown> }
    return { ...v, queries: ['SELECT 1;'], observed: { ...v.observed, ...over } }
  }

  it('refuses while the relation count is unmeasured, even with A0 otherwise attested', () => {
    const b = live(withA0({ publicRelationCount: null })).baselineStartGate.blocking.find(
      (x) => x.id === 'zero-production-data',
    )
    expect(b, 'must still block').toBeDefined()
    expect(b!.reason).toMatch(/did not count the relations in schema `public`/)
  })

  it('refuses a target whose public schema already holds relations', () => {
    const b = live(withA0({ publicRelationCount: 42 })).baselineStartGate.blocking.find(
      (x) => x.id === 'zero-production-data',
    )
    expect(b, 'must block on a restored dump').toBeDefined()
    expect(b!.reason).toMatch(/holds 42 relation\(s\)/)
  })

  it('passes only with the corpus clean AND the target observed empty', () => {
    const ids = live(withA0({ publicRelationCount: 0 })).baselineStartGate.blocking.map((x) => x.id)
    expect(ids).not.toContain('zero-production-data')
  })
})

describe('the published verdict is the gate verdict, including when it says yes', () => {
  const onDisk = JSON.parse(readFileSync(path.join(ROOT, APPLY_STATUS_ARTEFACT), 'utf8')) as {
    applyAuthorized: boolean
    baselineApplied: boolean
    stagingApplied: boolean
    hostedReady: boolean
    providerReady: boolean
    baselineStartGate: { total: number; satisfied: number; blocking: unknown[] }
  }

  // THE DEFECT THIS PINS. `applyAuthorized` was the literal type `false` and the
  // script published it as a constant. That was honest while the answer could
  // only be false, and became a lie the moment the start gate could be
  // satisfied: the artefact would keep saying `false` while the gate computed
  // `true`, and a report quoting it would contradict the thing it quotes.
  it('publishes the computed authorisation, not a constant', () => {
    expect(onDisk.applyAuthorized).toBe(live().applyAuthorized)
  })

  // …and the four that describe events which have not happened stay pinned.
  it('still pins the four words that describe things nothing here does', () => {
    expect(onDisk.baselineApplied).toBe(false)
    expect(onDisk.stagingApplied).toBe(false)
    expect(onDisk.hostedReady).toBe(false)
    expect(onDisk.providerReady).toBe(false)
  })

  it('derives authorisation from the START gate alone', () => {
    const report = live()
    expect(report.applyAuthorized).toBe(report.baselineStartGate.blocking.length === 0)

    // UPDATED 2026-08-08. The second half used to read
    // `baselineCompletionGate.blocking.length > 0`, which proved "authorisation
    // is not a claim the baseline is done" by pointing at a completion gate that
    // happened to be blocked. Unit 41's boundary is now verified, so that gate
    // is satisfied — and the property it was standing in for still holds, so it
    // is asserted directly instead of through a number that moved:
    //
    //   applyAuthorized says the baseline may START.
    //   baselineApplied says whether it HAS been applied, and it is false.
    //
    // UPDATED 2026-08-09. The third line read
    // `stagingRuntimeGate.blocking.length > 0` — again a number standing in for
    // the property. The evidence bucket has since been created and re-measured,
    // so that gate is satisfied and NO gate blocks any more. The property is
    // unchanged and is asserted where it actually lives: this report never
    // claims the baseline was applied, whatever the gates say.
    expect(report.applyAuthorized).toBe(true)
    expect(report.baselineApplied).toBe(false)
    expect(report.stagingApplied).toBe(false)
    expect(report.hostedReady).toBe(false)
    expect(report.providerReady).toBe(false)
  })
})

describe('the Session Pooler login role corroborates the target', () => {
  it('derives exactly the staging ref, and it is not on the production denylist', () => {
    expect(projectRefFromPoolerUser('postgres.bvyzblhqymxruxdguaee')).toBe(KNOWN_STAGING_PROJECT_REF)
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).not.toContain(KNOWN_STAGING_PROJECT_REF)
  })

  it('is recorded as a username and nothing else', () => {
    const artefact = JSON.parse(readFileSync(path.join(ROOT, APPLY_IDENTITY_ARTEFACT), 'utf8')) as Record<
      string,
      unknown
    >
    expect(artefact.poolerUser).toBe('postgres.bvyzblhqymxruxdguaee')
    // No credential ever enters this file: nothing shaped like a DSN, a JWT or a key.
    const serialized = JSON.stringify(artefact)
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//)
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./)
    expect(serialized).not.toMatch(/\bsb[ps]_[A-Za-z0-9_-]{8,}/)
  })

  it('closes target-identity-corroborated', () => {
    expect(blockingIds(live())).not.toContain('target-identity-corroborated')
  })
})

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
  APPLY_IDENTITY_ARTEFACT,
  APPLY_STATUS_ARTEFACT,
  CHECKPOINT_A0_ARTEFACT,
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

  it('means there is more than one blocker, not one', () => {
    expect(blockingIds(live()).length).toBeGreaterThanOrEqual(2)
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

  it('still refuses the apply — one criterion satisfied is not authorisation', () => {
    expect(
      live(withEvidence({ queries: IDENTITY_QUERIES }, { transaction_read_only: 'on' })).applyAuthorized,
    ).toBe(false)
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

  it('reports the SQL Editor probes as recorded', () => {
    const { observed } = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(observed.sqlEditor).toEqual({
      ownsStorageObjects: false,
      evidenceBucketExists: false,
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
    expect(evidence.inputs.stagingIdentity).toBeNull()
    expect(blockingIds(live())).toContain('target-identity-corroborated')
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
  it('ingests CHECKPOINT A0 rather than inventing it, and still refuses without its query', () => {
    const evidence = loadMeasuredEvidence({ readJson, readBaselineSql: read, discoveredBaselineFiles: discovered() })
    expect(evidence.inputs.checkpointA0).not.toBeNull()
    expect(evidence.inputs.checkpointA0!.value).toMatchObject({
      result: 'PASS',
      sessionWasReadOnly: true,
      projectIsNew: true,
      stellaSurfaceAbsent: true,
      writesPerformed: 0,
    })
    expect(evidence.inputs.checkpointA0!.query).toBe('')
    expect(blockingIds(live())).toContain('checkpoint-a0-pass')
  })

  // NO DOUBLE STANDARD. `zero-production-data` read the same attestation and
  // never demanded its provenance, so an A0 with no recorded query would have
  // satisfied it while `checkpoint-a0-pass` refused the identical object.
  it('holds zero-production-data to the same provenance standard as A0 itself', () => {
    expect(blockingIds(live())).toContain('zero-production-data')
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

  it('says applyAuthorized=false and cannot say otherwise', () => {
    expect(onDisk.applyAuthorized).toBe(false)
    expect(live().applyAuthorized).toBe(false)
  })

  it('publishes more than one blocker, and each with its four parts', () => {
    expect(onDisk.blockingCount).toBeGreaterThanOrEqual(2)
    expect(onDisk.blockingIds).toContain('checkpoint-a0-pass')
  })
})

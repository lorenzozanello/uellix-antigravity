// tests/hosted/baseline-apply-authorization.test.ts
// TRAIN 5C1 — Phase 2, Phase 10 and Phase 11.
//
// Two things are being tested and they pull in opposite directions, which is the
// point: that the gate CAN say yes when everything holds, and that it says no
// the moment any single thing does not. A gate that only ever refused would be
// safe and useless; one that only ever passed would be the reason this whole
// programme exists.
//
// The fixture below is a HYPOTHETICAL satisfying state. It is not a claim about
// the real staging project — the real attestations are absent, which is exactly
// why the live evaluation at the bottom of this file expects a refusal.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  APPLY_AUTHORIZATION_CRITERIA,
  evaluateApplyAuthorization,
  type ApplyAuthorizationInputs,
} from '@/db/hosted/baseline-apply-authorization'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  productionDenylistStatus,
  verifyStagingTarget,
} from '@/db/hosted/target-identity'

const ROOT = process.cwd()
const STAGING_REF = 'sssssssssssssssssss' + 's'
const PROD_REF = 'pppppppppppppppppppp'

const readBaselineSql = (file: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8')
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
    for (const name of readdirSync(path.join(ROOT, dir)).sort()) if (accept(name)) out.push(`${dir}/${name}`)
  }
  return out
}

/** Every precondition met — a state that does NOT currently exist. */
function satisfying(): ApplyAuthorizationInputs {
  return {
    readBaselineSql,
    discoveredBaselineFiles: discovered(),
    production: { hosts: [...KNOWN_PRODUCTION_IDENTIFIERS.hosts], projectRefs: [PROD_REF] },
    checkpointA0: {
      value: {
        result: 'PASS',
        sessionWasReadOnly: true,
        projectIsNew: true,
        stellaSurfaceAbsent: true,
        writesPerformed: 0,
      },
      query: 'BEGIN READ ONLY; SELECT current_setting(\'transaction_read_only\'); …',
      measuredBy: 'operator, Supabase SQL editor',
    },
    classCProbes: {
      value: {
        canCreateTriggerOnAuthUsers: true,
        ownsStorageObjects: true,
        evidenceBucketExists: true,
        applyIdentityRecorded: true,
        storageAdminMember: true,
        storageAdminInherits: true,
        canSetRoleStorageAdmin: true,
        setLocalRoleDemonstrated: true,
      },
      // All FIVE §2.7 queries, quoted verbatim. The gate requires every canonical
      // string, so adding a probe to CLASS_C_PROBES correctly invalidates any
      // attestation that predates it — which is what happened when
      // applyIdentityRecorded and canSetRoleStorageAdmin were added.
      query:
        "SELECT has_table_privilege(current_user, 'auth.users', 'TRIGGER'); " +
        "SELECT pg_has_role(current_user, relowner, 'USAGE') FROM pg_class WHERE oid = 'storage.objects'::regclass; " +
        "SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uellix-evidence'); " +
        'SELECT current_user, session_user, version(); ' +
        "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER'); " +
        "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'USAGE'); " +
        "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'SET'); " +
        'SET LOCAL ROLE supabase_storage_admin;',
      measuredBy: 'operator, in the identity that will apply the baseline',
    },
    stagingIdentity: {
      value: {
        declaredEnvironment: 'staging',
        projectRef: STAGING_REF,
        connectionHost: `db.${STAGING_REF}.supabase.co`,
      },
      query: 'read from the Supabase dashboard',
      measuredBy: 'operator',
    },
    featureFlags: {
      value: {},
      query: 'secret manager inventory, names and values of the nine STELLA_* flags',
      measuredBy: 'operator',
    },
    /* ---- Train 5C2 ---- */
    applyIdentity: {
      value: {
        currentUser: 'postgres',
        sessionUser: 'postgres',
        transactionReadOnly: true,
        isMember: true,
        inheritsPrivileges: false,
        canSetRole: true,
      },
      query:
        'SELECT current_user, session_user, version(), current_setting(\'transaction_read_only\'); ' +
        "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER') AS is_member, " +
        "pg_has_role(current_user, 'supabase_storage_admin', 'USAGE') AS inherits_privileges, " +
        "pg_has_role(current_user, 'supabase_storage_admin', 'SET') AS can_set_role;",
      measuredBy: 'operator, psql direct connection — the identity that will apply PHASE_BASELINE',
    },
    setLocalRoleDemo: {
      value: {
        executed: true,
        currentUserAfter: 'supabase_storage_admin',
        sessionUserAfter: 'postgres',
        transactionReadOnlyAfter: true,
      },
      query: 'BEGIN READ ONLY; SET LOCAL ROLE supabase_storage_admin; SELECT current_user, session_user; RESET ROLE; ROLLBACK;',
      measuredBy: 'operator, same connection',
    },
    storagePath: 'A-set-role',
    evidenceBucket: {
      value: { exists: true },
      query: "SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uellix-evidence');",
      measuredBy: 'operator',
    },
    journalProvenance: {
      kind: 'hosted-journal',
      recordedFields: ['package_id', 'phase', 'sha256', 'applied_at', 'status'],
      writesAfterCommitOnly: true,
      detail: 'a hosted journal written only after each unit commits',
    },
  }
}

/* ========================================================================== */
/* PHASE 2 — the six denylist cases the train required                        */
/* ========================================================================== */

describe('Phase 2 — the production denylist', () => {
  const target = (over: Partial<Parameters<typeof verifyStagingTarget>[0]> = {}) => ({
    declaredEnvironment: 'staging',
    declaredProjectRef: STAGING_REF,
    connectionHost: `db.${STAGING_REF}.supabase.co`,
    sentinel: { environment: 'staging', projectRef: STAGING_REF },
    ...over,
  })
  const withProd = { hosts: [...KNOWN_PRODUCTION_IDENTIFIERS.hosts], projectRefs: [PROD_REF] }

  it('1. accepts a staging ref that is not on the denylist', () => {
    const verdict = verifyStagingTarget(target(), withProd)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.projectRef).toBe(STAGING_REF)
  })

  it('2. refuses a production ref, even with three forged agreeing signals', () => {
    const verdict = verifyStagingTarget(
      target({
        declaredProjectRef: PROD_REF,
        connectionHost: `db.${PROD_REF}.supabase.co`,
        sentinel: { environment: 'staging', projectRef: PROD_REF },
      }),
      withProd,
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('3. refuses a production host', () => {
    const verdict = verifyStagingTarget(target({ connectionHost: 'app.uellix.com' }), withProd)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('4. refuses a SUBDOMAIN of a production domain', () => {
    // `endsWith('.' + host)`, so a host nobody listed but that lives under a
    // listed domain is still vetoed. This is the case a literal list misses.
    const verdict = verifyStagingTarget(target({ connectionHost: 'db.uellix.com' }), withProd)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('5. refuses environment "production", and every near-miss spelling of staging', () => {
    for (const env of ['production', 'Staging', 'staging ', '', 'prod']) {
      const verdict = verifyStagingTarget(target({ declaredEnvironment: env }), withProd)
      expect(verdict.ok, env).toBe(false)
      if (!verdict.ok) {
        expect(verdict.code, env).toBe(
          env === 'production' || env !== 'staging' ? 'HOSTED_TARGET_ENVIRONMENT_NOT_STAGING' : verdict.code,
        )
      }
    }
  })

  it('6. an EMPTY denylist is refused — for authorising a write, not for a dry run', () => {
    // The distinction is the design. An empty list removes a VETO, so a dry run
    // against it still answers a well-posed question and must keep working. What
    // must not happen is authorising the first hosted WRITE while the veto that
    // would catch "this is production" has never been loaded.
    expect(productionDenylistStatus({ hosts: ['app.uellix.com'], projectRefs: [] }).loaded).toBe(false)
    expect(productionDenylistStatus({ hosts: [], projectRefs: [PROD_REF] }).loaded).toBe(true)

    // A dry run is unaffected.
    expect(verifyStagingTarget(target(), { hosts: [], projectRefs: [] }).ok).toBe(true)

    // The apply gate is not.
    const report = evaluateApplyAuthorization({
      ...satisfying(),
      production: { hosts: [...KNOWN_PRODUCTION_IDENTIFIERS.hosts], projectRefs: [] },
    })
    expect(report.applyAuthorized).toBe(false)
    expect(report.blocking.join(' ')).toContain('production-denylist-loaded')
  })

  it('refuses a malformed denylist entry, which is an absent veto in a present one\'s clothes', () => {
    expect(productionDenylistStatus({ hosts: [], projectRefs: ['too-short'] }).loaded).toBe(false)
    expect(productionDenylistStatus({ hosts: [], projectRefs: ['ABCDEFGHIJKLMNOPQRST'] }).loaded).toBe(false)
  })

  it('IS NOW LOADED — P5 closed 2026-08-07 — and the staging ref is not in it', () => {
    // For three trains this asserted the list was EMPTY, because the
    // repository's one candidate was labelled production in
    // docs/AUDIT_2026-07-06.md and staging in
    // docs/audits/2026-07-15-uellix-p1a-integration-rls.md. The operator
    // resolved it from the Supabase dashboard: the July audit was wrong. RR-24.
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).toEqual(['ctaxtgujyyprgynmnvtq'])
    expect(productionDenylistStatus().loaded).toBe(true)
    // And the thing that must never happen: the target in its own veto.
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).not.toContain('bvyzblhqymxruxdguaee')
  })
})

/* ========================================================================== */
/* PHASE 10 — the gate                                                        */
/* ========================================================================== */

describe('the apply-authorization gate', () => {
  it('satisfies everything EXCEPT the management channel, which no evidence closes', () => {
    // RR-25 IS NOW CLOSED, and this expectation is the record of it: the
    // previous train's blocking list was ['hosted-baseline-journal-ready'],
    // because `journalInsertSql` had no caller and no artefact carried the
    // append. Fifty-one generated wrappers now do, so that criterion passes and
    // the list shrank by one.
    //
    // What remains blocking is not a gap in this repository. The Dashboard
    // Storage Policies UI compiles its form into CREATE POLICY text and submits
    // it through the same executeSql path as the SQL Editor — measured to be an
    // unprivileged postgres — so no channel we have evidence for can apply
    // PART B. Only a hosted attempt can settle it, and an attempt is a write.
    const report = evaluateApplyAuthorization(satisfying())
    expect(report.blocking.map((b) => b.split(':')[0])).toEqual([
      'hosted-storage-management-channel-verified',
    ])
    expect(report.applyAuthorized).toBe(false)
  })

  it('covers every dependency Phase 10 and Train 5C2 Phase 14 named', () => {
    // Phase 10 named twelve dependencies; `hashes` and `order` are not separable
    // — verifyBaselineManifest checks both in one pass and a partial answer is
    // meaningless — so they are one criterion. Train 5C2 added six, and the
    // management-channel determination added a seventh.
    expect(APPLY_AUTHORIZATION_CRITERIA.map((c) => c.id)).toEqual([
      'checkpoint-a0-pass',
      'production-denylist-loaded',
      'target-identity-corroborated',
      'class-c-probes-affirmative',
      // Train 5C2, Phase 14 — the six Storage / identity / journal gates.
      'hosted-storage-apply-identity-probed',
      'hosted-storage-set-role-ready',
      'hosted-storage-policy-adaptation-ready',
      'hosted-evidence-bucket-provisioning-ready',
      'hosted-storage-policy-boundary-ready',
      'hosted-baseline-journal-ready',
      'hosted-storage-management-channel-verified',
      'manifest-hashes-and-order',
      'no-class-d-units',
      'zero-production-data',
      'no-service-role-widening',
      'feature-flags-false',
      'postconditions-ready',
      'recovery-plan-conservative',
    ])
  })

  it('MEMBER is not SET, and USAGE is not SET — Branch A refuses both substitutions', () => {
    const setRole = APPLY_AUTHORIZATION_CRITERIA.find((c) => c.id === 'hosted-storage-set-role-ready')!
    const base = satisfying()

    // MEMBER=true, SET=false. The exact confusion the operator's PostgreSQL 17
    // correction named: membership is not permission to assume.
    const memberOnly = setRole.evaluate({
      ...base,
      storagePath: 'A-set-role',
      applyIdentity: { ...base.applyIdentity!, value: { ...base.applyIdentity!.value, isMember: true, canSetRole: false } },
    })
    expect(memberOnly.satisfied).toBe(false)
    expect(memberOnly.detail).toContain('MEMBER is true')

    // USAGE=true, SET=false. Inheriting privileges is not permission to SET ROLE
    // either — different privilege, different question.
    expect(
      setRole.evaluate({
        ...base,
        storagePath: 'A-set-role',
        applyIdentity: {
          ...base.applyIdentity!,
          value: { ...base.applyIdentity!.value, inheritsPrivileges: true, canSetRole: false },
        },
      }).satisfied,
    ).toBe(false)

    // SET=true is still not enough on its own: the operation must be shown.
    expect(
      setRole.evaluate({ ...base, storagePath: 'A-set-role', setLocalRoleDemo: null }).satisfied,
    ).toBe(false)
  })

  it('refuses a SET LOCAL ROLE demonstration in which the SESSION escalated', () => {
    const setRole = APPLY_AUTHORIZATION_CRITERIA.find((c) => c.id === 'hosted-storage-set-role-ready')!
    const base = satisfying()
    const escalated = setRole.evaluate({
      ...base,
      setLocalRoleDemo: {
        ...base.setLocalRoleDemo!,
        value: { ...base.setLocalRoleDemo!.value, sessionUserAfter: 'supabase_storage_admin' },
      },
    })
    expect(escalated.satisfied).toBe(false)
    expect(escalated.detail).toContain('session that escalated')
  })

  it('refuses Branch B when SET is available, so the manual channel is never a lazy default', () => {
    const setRole = APPLY_AUTHORIZATION_CRITERIA.find((c) => c.id === 'hosted-storage-set-role-ready')!
    expect(setRole.evaluate({ ...satisfying(), storagePath: 'B-managed-channel' }).satisfied).toBe(false)
  })

  it('refuses any path at all before the identity has been probed', () => {
    for (const path of ['A-set-role', 'B-managed-channel', null] as const) {
      const r = evaluateApplyAuthorization({ ...satisfying(), storagePath: path, applyIdentity: null })
      expect(r.applyAuthorized, String(path)).toBe(false)
    }
  })

  it('NEGATIVE CONTROL: every criterion fails against its own mutation', () => {
    const failures: string[] = []
    for (const criterion of APPLY_AUTHORIZATION_CRITERIA) {
      const broken = criterion.negativeControl.mutate(satisfying())
      if (criterion.evaluate(broken).satisfied) {
        failures.push(`${criterion.id} (${criterion.negativeControl.description})`)
      }
    }
    expect(failures, 'criteria that pass their own negative control do not read their input').toEqual([])
  })

  it('refuses every attestation that is simply ABSENT', () => {
    for (const key of ['checkpointA0', 'classCProbes', 'stagingIdentity', 'featureFlags'] as const) {
      const report = evaluateApplyAuthorization({ ...satisfying(), [key]: null })
      expect(report.applyAuthorized, key).toBe(false)
    }
  })

  it('refuses a class-C attestation whose query is not the one §2.7 specifies', () => {
    const inputs = satisfying()
    const report = evaluateApplyAuthorization({
      ...inputs,
      classCProbes: { ...inputs.classCProbes!, query: 'SELECT true; SELECT true; SELECT true;' },
    })
    expect(report.applyAuthorized).toBe(false)
    expect(report.blocking.join(' ')).toContain('class-c-probes-affirmative')
  })

  it('refuses an A0 attestation with no provenance', () => {
    const inputs = satisfying()
    const report = evaluateApplyAuthorization({
      ...inputs,
      checkpointA0: { ...inputs.checkpointA0!, measuredBy: '' },
    })
    expect(report.applyAuthorized).toBe(false)
  })

  it('refuses a probe attestation that names the WRONG table and privilege', () => {
    // The honest mistake, not the forgery: right function, wrong question.
    // `SELECT has_table_privilege(current_user, 'public.users', 'SELECT')`
    // contains the substring the old check looked for.
    const inputs = satisfying()
    const report = evaluateApplyAuthorization({
      ...inputs,
      classCProbes: {
        ...inputs.classCProbes!,
        query:
          "SELECT has_table_privilege(current_user, 'public.users', 'SELECT'); " +
          "SELECT pg_has_role(current_user, 'postgres', 'USAGE'); " +
          'SELECT count(*) FROM storage.buckets;',
      },
    })
    expect(report.applyAuthorized).toBe(false)
    expect(report.blocking.join(' ')).toContain('class-c-probes-affirmative')
  })

  it('refuses a probe attestation that is only a comment containing the right words', () => {
    const inputs = satisfying()
    const report = evaluateApplyAuthorization({
      ...inputs,
      classCProbes: {
        ...inputs.classCProbes!,
        query: '-- has_table_privilege pg_has_role storage.buckets',
      },
    })
    expect(report.applyAuthorized).toBe(false)
  })

  it('requires provenance on ALL FOUR attestations, not just A0', () => {
    for (const key of ['checkpointA0', 'classCProbes', 'stagingIdentity', 'featureFlags'] as const) {
      const inputs = satisfying()
      const blanked = evaluateApplyAuthorization({
        ...inputs,
        [key]: { ...inputs[key]!, measuredBy: '' },
      })
      expect(blanked.applyAuthorized, `${key} with no provenance`).toBe(false)

      const unqueried = evaluateApplyAuthorization({
        ...inputs,
        [key]: { ...inputs[key]!, query: '  ' },
      })
      expect(unqueried.applyAuthorized, `${key} with no query`).toBe(false)
    }
  })

  it('never reports baselineApplied, stagingApplied, hostedReady or providerReady', () => {
    for (const report of [
      evaluateApplyAuthorization(satisfying()),
      evaluateApplyAuthorization({ ...satisfying(), checkpointA0: null }),
    ]) {
      expect(report.baselineApplied).toBe(false)
      expect(report.stagingApplied).toBe(false)
      expect(report.hostedReady).toBe(false)
      expect(report.providerReady).toBe(false)
    }
  })
})

/* ========================================================================== */
/* THE ACTUAL STATE OF THE REPOSITORY, RIGHT NOW                              */
/* ========================================================================== */

describe('the live verdict for Uellix Staging as of Train 5C1', () => {
  it('is NOT authorised, and names exactly what is missing', () => {
    // No attestation exists: the operator has not yet supplied the staging
    // project ref or run the three probes, and the production denylist is
    // deliberately empty. This test is the executable form of the train's
    // BLOCKED result, and it will start failing — correctly — the moment the
    // real attestations are wired in.
    const live = evaluateApplyAuthorization({
      readBaselineSql,
      discoveredBaselineFiles: discovered(),
      production: KNOWN_PRODUCTION_IDENTIFIERS,
      checkpointA0: null,
      classCProbes: null,
      stagingIdentity: null,
      featureFlags: null,
      // Train 5C2: the apply identity has not been probed, the storage path has
      // not been selected, the bucket does not exist and RR-25 is unresolved.
      applyIdentity: null,
      setLocalRoleDemo: null,
      storagePath: null,
      evidenceBucket: null,
      journalProvenance: null,
    })

    expect(live.applyAuthorized).toBe(false)
    const blocking = live.blocking.join(' | ')

    // Four attestations are still absent — the operator has not yet run the
    // three §2.7 probes or inventoried the flags — plus zero-production-data,
    // which depends on A0's statement about the target.
    expect(blocking).toContain('checkpoint-a0-pass')
    expect(blocking).toContain('target-identity-corroborated')
    expect(blocking).toContain('class-c-probes-affirmative')
    expect(blocking).toContain('feature-flags-false')
    expect(blocking).toContain('zero-production-data')

    // P5 IS CLOSED: the denylist no longer blocks.
    expect(blocking).not.toContain('production-denylist-loaded')
    expect(
      live.criteria.find((c) => c.id === 'production-denylist-loaded')?.satisfied,
    ).toBe(true)

    // …and everything the repository CAN establish on its own is satisfied.
    const repositoryOnly = live.criteria.filter((c) =>
      ['production-denylist-loaded', 'manifest-hashes-and-order', 'no-class-d-units', 'no-service-role-widening', 'postconditions-ready', 'recovery-plan-conservative'].includes(c.id),
    )
    expect(repositoryOnly.every((c) => c.satisfied), JSON.stringify(repositoryOnly, null, 2)).toBe(true)
  })
})

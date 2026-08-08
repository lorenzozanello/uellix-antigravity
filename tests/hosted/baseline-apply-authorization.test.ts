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
  GATE_ADMITS_PHASE,
  evaluateApplyAuthorization,
  type ApplyAuthorizationInputs,
} from '@/db/hosted/baseline-apply-authorization'
import {
  KNOWN_PRODUCTION_IDENTIFIERS,
  productionDenylistStatus,
  projectRefFromPoolerUser,
  verifyStagingTarget,
} from '@/db/hosted/target-identity'
import { BASELINE_POSTCONDITIONS } from '@/db/hosted/baseline-postconditions'
import type { PrivilegeProbes } from '@/db/hosted/hosted-provisioning-runner'

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
        // A new project: schema public holds nothing before the baseline runs.
        publicRelationCount: 0,
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
        // Direct connection: the host carries the ref, so no pooler role.
        poolerUser: null,
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
        // Branch B, and the measured reality: no membership in any grade.
        isMember: false,
        inheritsPrivileges: false,
        canSetRole: false,
      },
      query:
        'SELECT current_user, session_user, version(), current_setting(\'transaction_read_only\'); ' +
        "SELECT pg_has_role(current_user, 'supabase_storage_admin', 'MEMBER') AS is_member, " +
        "pg_has_role(current_user, 'supabase_storage_admin', 'USAGE') AS inherits_privileges, " +
        "pg_has_role(current_user, 'supabase_storage_admin', 'SET') AS can_set_role;",
      measuredBy: 'operator, psql direct connection — the identity that will apply PHASE_BASELINE',
    },
    // Branch B forbids a demonstration: attempting an operation the grant
    // already refuses teaches nothing the catalogue has not already said.
    setLocalRoleDemo: null,
    // BRANCH B, BECAUSE BRANCH A IS UNREACHABLE BY CONSTRUCTION.
    //
    // This fixture used to select 'A-set-role', and that made it describe a world
    // that cannot exist: SET_ROLE_PATH_VERIFIED is a `false as const` with no
    // setter, so the storage criterion refuses Branch A unconditionally. A
    // fixture whose name is `satisfying()` and which can never satisfy the gate
    // makes every "everything else is fine" assertion in this file vacuous —
    // they would all be measuring the same permanent refusal.
    //
    // Branch B with the boundary verified is the only reachable satisfied state,
    // and it is also the branch the real measurements select.
    storagePath: 'B-managed-channel',
    capabilityProbe: { state: 'CAPABILITY_PROBE_COMPLETE' as const },
    capabilityDemonstrated: true,
    managedBoundaryVerified: true,
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
  it('CAN say yes — over a hypothetical state that is actually reachable', () => {
    // WHAT THIS TEST IS AND IS NOT.
    //
    // It proves the gate is not a machine that only ever refuses: given a world
    // where every precondition genuinely holds, it says yes. It is NOT a
    // statement about the staging project — `pnpm apply:status` answers that from
    // the recorded artefacts, and it currently refuses on nine criteria.
    //
    // Two earlier versions of this expectation were wrong in the same way. The
    // first quoted this fixture's blocking count as the project's status. The
    // second described a fixture selecting Branch A, which the pinned
    // SET_ROLE_PATH_VERIFIED makes unreachable — so "everything except one" was
    // really "a permanent refusal plus everything else being untested".
    const report = evaluateApplyAuthorization(satisfying())
    expect(report.blocking, JSON.stringify(report.blocking, null, 2)).toEqual([])
    expect(report.applyAuthorized).toBe(true)
    // …and the runtime gate is separate, and also satisfied in this world.
    expect(report.stagingRuntimeGate.blocking).toEqual([])
  })

  it('is not authorised by the runtime gate — authorisation is the baseline gate alone', () => {
    const report = evaluateApplyAuthorization({
      ...satisfying(),
      evidenceBucket: { value: { exists: false }, query: 'SELECT …', measuredBy: 'operator' },
    })
    expect(report.applyAuthorized).toBe(true)
    expect(report.stagingRuntimeGate.blocking).toHaveLength(1)
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
      'hosted-storage-channel-capability-demonstrated',
      // The completion half of the split — post-PART-A, so it cannot be a
      // precondition of starting the baseline.
      'hosted-storage-canonical-boundary-verified',
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
    // Branch A is stated explicitly: this test is ABOUT Branch A, and the
    // fixture now selects B because A is unreachable in the gate as a whole.
    const escalated = setRole.evaluate({
      ...base,
      storagePath: 'A-set-role',
      applyIdentity: {
        ...base.applyIdentity!,
        value: { ...base.applyIdentity!.value, isMember: true, canSetRole: true },
      },
      setLocalRoleDemo: {
        value: {
          executed: true,
          currentUserAfter: 'supabase_storage_admin',
          sessionUserAfter: 'supabase_storage_admin',
          transactionReadOnlyAfter: true,
        },
        query: 'BEGIN READ ONLY; SET LOCAL ROLE supabase_storage_admin; SELECT current_user, session_user; RESET ROLE; ROLLBACK;',
        measuredBy: 'operator, same connection',
      },
    })
    expect(escalated.satisfied).toBe(false)
    expect(escalated.detail).toContain('session that escalated')
  })

  it('refuses Branch B when SET is available, so the manual channel is never a lazy default', () => {
    const setRole = APPLY_AUTHORIZATION_CRITERIA.find((c) => c.id === 'hosted-storage-set-role-ready')!
    const base = satisfying()
    expect(
      setRole.evaluate({
        ...base,
        storagePath: 'B-managed-channel',
        applyIdentity: { ...base.applyIdentity!, value: { ...base.applyIdentity!.value, canSetRole: true } },
      }).satisfied,
    ).toBe(false)
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
      capabilityProbe: null,
      capabilityDemonstrated: false,
      managedBoundaryVerified: false,
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

/* ========================================================================== */
/* TRAIN 5C2 continuation — the gate SEMANTICS the operator asked me to audit  */
/* ========================================================================== */

describe('the storage disjunction, split so it cannot be circular', () => {
  const channel = APPLY_AUTHORIZATION_CRITERIA.find(
    (c) => c.id === 'hosted-storage-channel-capability-demonstrated',
  )!
  const boundary = APPLY_AUTHORIZATION_CRITERIA.find(
    (c) => c.id === 'hosted-storage-canonical-boundary-verified',
  )!

  // THE CIRCULARITY THE OPERATOR FOUND, ASSERTED AWAY.
  //
  //   baseline start → needed the canonical boundary
  //                  → needed unit 41 PART A
  //                  → needed baseline start.
  it('puts the capability question BEFORE the baseline and the surface question AFTER', () => {
    expect(channel.gate).toBe('baseline-start')
    expect(channel.dependsOnPhase).toBe('pre-baseline')
    expect(boundary.gate).toBe('baseline-completion')
    expect(boundary.dependsOnPhase).toBe('post-part-a')
  })

  // THE STRUCTURAL GUARD, so the next one cannot be written either.
  it('admits no baseline-start criterion whose evidence needs the baseline', () => {
    for (const c of APPLY_AUTHORIZATION_CRITERIA) {
      expect(
        GATE_ADMITS_PHASE[c.gate].includes(c.dependsOnPhase),
        `${c.id}: gate ${c.gate} cannot consume ${c.dependsOnPhase} evidence`,
      ).toBe(true)
    }
  })

  it('lets the start gate pass on a demonstrated channel with NO canonical policy installed', () => {
    const v = channel.evaluate({ ...satisfying(), managedBoundaryVerified: false })
    expect(v.satisfied, v.detail).toBe(true)
  })

  it('and the completion gate still refuses in that same state', () => {
    const v = boundary.evaluate({ ...satisfying(), managedBoundaryVerified: false })
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/demonstrated channel is not an installed surface/)
  })

  // THE AUDIT. SET=false is permanent on this project. A criterion that required
  // SET_ROLE_PATH_VERIFIED to become true before the baseline could be
  // authorised would be demanding that a historical measurement change — which
  // is not strictness, it is a gate that has stopped carrying information.
  it('is satisfied by the capability arm alone, with SET measured false', () => {
    const base = satisfying()
    const v = channel.evaluate({
      ...base,
      storagePath: 'B-managed-channel',
      applyIdentity: {
        ...base.applyIdentity!,
        value: {
          ...base.applyIdentity!.value,
          isMember: false,
          inheritsPrivileges: false,
          canSetRole: false,
        },
      },
      capabilityDemonstrated: true,
      capabilityProbe: { state: 'CAPABILITY_PROBE_COMPLETE' },
    })
    expect(v.satisfied, v.detail).toBe(true)
    expect(v.detail).toMatch(/MANAGED_CHANNEL_CAPABILITY_DEMONSTRATED/)
  })

  it('blocks with SET false and no channel demonstrated', () => {
    const v = channel.evaluate({
      ...satisfying(),
      storagePath: 'B-managed-channel',
      capabilityDemonstrated: false,
      capabilityProbe: { state: 'CAPABILITY_PROBE_NOT_RUN' },
    })
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/SET_ROLE_PATH_VERIFIED is false and cannot become true/)
  })

  // THE OPERATOR'S POINT: provenance is not a new measurement.
  it('cannot be closed by adding queries or a connection host to the artefact', () => {
    const v = channel.evaluate({
      ...satisfying(),
      storagePath: 'B-managed-channel',
      capabilityDemonstrated: false,
      capabilityProbe: { state: 'CAPABILITY_PROBE_NOT_RUN' },
    })
    expect(v.detail).toMatch(/Recording queries or a connection host in an artefact cannot change that/)
  })

  // The SET ROLE arm contributes nothing in EITHER direction — it is a pinned
  // false, so the disjunction is decided entirely by the managed arm.
  it('never closes through the SET ROLE arm, whatever the probe said', () => {
    for (const canSetRole of [true, false]) {
      const base = satisfying()
      const v = channel.evaluate({
        ...base,
        storagePath: 'B-managed-channel',
        capabilityDemonstrated: false,
        applyIdentity: { ...base.applyIdentity!, value: { ...base.applyIdentity!.value, canSetRole } },
      })
      expect(v.satisfied, `canSetRole=${canSetRole}`).toBe(false)
    }
  })

  // Capability is not correctness. A channel proven able to create SOME policy
  // has not created THESE policies, and the two must not share a flag.
  it('does not treat a successful capability probe as a verified boundary', () => {
    const v = boundary.evaluate({
      ...satisfying(),
      capabilityProbe: { state: 'CAPABILITY_PROBE_COMPLETE' },
      capabilityDemonstrated: true,
      managedBoundaryVerified: false,
    })
    expect(v.satisfied).toBe(false)
  })
})

describe('class-C semantics: a false is not automatically a failure', () => {
  const classC = APPLY_AUTHORIZATION_CRITERIA.find((c) => c.id === 'class-c-probes-affirmative')!
  const withProbes = (
    over: Partial<PrivilegeProbes>,
    rest: Partial<ApplyAuthorizationInputs> = {},
  ) => {
    const base = satisfying()
    return classC.evaluate({
      ...base,
      ...rest,
      classCProbes: { ...base.classCProbes!, value: { ...base.classCProbes!.value, ...over } },
    })
  }

  it('PROBE_MISSING — an unmeasured probe refuses', () => {
    const v = withProbes({ canCreateTriggerOnAuthUsers: null })
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/^PROBE_MISSING/)
  })

  it('PROBE_INVALID — a probe measured by a query nobody recorded refuses', () => {
    const base = satisfying()
    const v = classC.evaluate({ ...base, classCProbes: { ...base.classCProbes!, query: 'SELECT 1;' } })
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/^PROBE_INVALID/)
  })

  it('PROBE_RESULT_UNSUPPORTED — an apply-required false has no adaptation behind it', () => {
    const v = withProbes({ canCreateTriggerOnAuthUsers: false })
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/^PROBE_RESULT_UNSUPPORTED/)
  })

  // THE ONE THE AUDIT DEMANDED. ownsStorageObjects=false is the MEASURED,
  // permanent state, and it SELECTS the managed route rather than blocking one.
  it('PROBE_RESULT_SUPPORTED_BY_SELECTED_PATH — ownsStorageObjects=false, managed path selected', () => {
    const v = withProbes(
      { ownsStorageObjects: false, canSetRoleStorageAdmin: false, setLocalRoleDemonstrated: false },
      { storagePath: 'B-managed-channel' },
    )
    expect(v.satisfied, v.detail).toBe(true)
    expect(v.detail).toMatch(/^PROBE_RESULT_SUPPORTED_BY_SELECTED_PATH/)
  })

  it('the same false with NO path selected is unsupported, not supported', () => {
    const v = withProbes({ ownsStorageObjects: false }, { storagePath: null })
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/^PROBE_RESULT_UNSUPPORTED/)
  })

  it('never demands that a historical measurement change to true', () => {
    // The property, stated as a test: there IS an input where every probe this
    // train measured false is still false and the criterion is satisfied.
    const v = withProbes(
      {
        ownsStorageObjects: false,
        storageAdminMember: false,
        storageAdminInherits: false,
        canSetRoleStorageAdmin: false,
        setLocalRoleDemonstrated: false,
        evidenceBucketExists: false,
      },
      { storagePath: 'B-managed-channel' },
    )
    expect(v.satisfied, v.detail).toBe(true)
  })
})

describe('the bucket blocks runtime, not the baseline', () => {
  const bucketAbsent = (): ApplyAuthorizationInputs => ({
    ...satisfying(),
    evidenceBucket: {
      value: { exists: false },
      query: "SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'uellix-evidence');",
      measuredBy: 'operator',
    },
  })

  it('an absent bucket does not refuse the baseline gate', () => {
    const report = evaluateApplyAuthorization(bucketAbsent())
    expect(report.baselineStartGate.blocking.map((b) => b.id)).toEqual([])
    expect(report.applyAuthorized).toBe(true)
  })

  // THE OBLIGATION DID NOT MOVE, ONLY THE MOMENT IT BLOCKS.
  it('and still refuses the runtime gate, and B0-15 still exists', () => {
    const report = evaluateApplyAuthorization(bucketAbsent())
    expect(report.stagingRuntimeGate.blocking.map((b) => b.id)).toEqual([
      'hosted-evidence-bucket-provisioning-ready',
    ])
    expect(BASELINE_POSTCONDITIONS.some((p) => p.id === 'B0-15-evidence-bucket-exists')).toBe(true)
  })

  it('partitions the criteria across three gates, none empty, none in two', () => {
    const byGate = (g: string) => APPLY_AUTHORIZATION_CRITERIA.filter((c) => c.gate === g)
    const start = byGate('baseline-start')
    const completion = byGate('baseline-completion')
    const runtime = byGate('staging-runtime')
    expect(start.length + completion.length + runtime.length).toBe(APPLY_AUTHORIZATION_CRITERIA.length)
    for (const g of [start, completion, runtime]) expect(g.length).toBeGreaterThan(0)
  })
})

describe('every blocker carries its four parts separately', () => {
  const report = () =>
    evaluateApplyAuthorization({
      ...satisfying(),
      checkpointA0: null,
      applyIdentity: null,
      evidenceBucket: null,
    })

  it('names id, observedEvidence, expectedProperty, reason and sourceArtifact', () => {
    const all = [...report().baselineStartGate.blocking, ...report().stagingRuntimeGate.blocking]
    expect(all.length).toBeGreaterThan(0)
    for (const b of all) {
      expect(b.id, 'id').toBeTruthy()
      expect(b.observedEvidence.length, `${b.id} observedEvidence`).toBeGreaterThan(10)
      expect(b.expectedProperty.length, `${b.id} expectedProperty`).toBeGreaterThan(10)
      expect(b.reason.length, `${b.id} reason`).toBeGreaterThan(10)
      expect(b.sourceArtifact.length, `${b.id} sourceArtifact`).toBeGreaterThan(5)
    }
  })

  // observedEvidence is the MEASUREMENT, reason is the CONCLUSION. Collapsing
  // them is how "SET=false" became "the SET ROLE path is refuted" and then
  // outlived the measurement that justified it.
  it('keeps the measurement distinct from the conclusion', () => {
    const a0 = report().baselineStartGate.blocking.find((b) => b.id === 'checkpoint-a0-pass')!
    expect(a0.observedEvidence).not.toBe(a0.reason)
    expect(a0.sourceArtifact).not.toBe(a0.expectedProperty)
  })
})

describe('the Session Pooler names the project in its LOGIN ROLE, not its host', () => {
  const corroboration = APPLY_AUTHORIZATION_CRITERIA.find((c) => c.id === 'target-identity-corroborated')!
  const viaPooler = (poolerUser: string | null) => {
    const base = satisfying()
    return corroboration.evaluate({
      ...base,
      stagingIdentity: {
        ...base.stagingIdentity!,
        value: {
          ...base.stagingIdentity!.value,
          connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
          poolerUser,
        },
      },
    })
  }

  it('corroborates through the pooler login role when the host cannot', () => {
    const v = viaPooler(`postgres.${STAGING_REF}`)
    expect(v.satisfied, v.detail).toBe(true)
    expect(v.detail).toMatch(/Session Pooler login role/)
  })

  it('still refuses a pooler host with no login role recorded', () => {
    const v = viaPooler(null)
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/no login role was recorded/)
  })

  // The whole point of signal 2: it must be able to DISAGREE with the
  // declaration. A login role naming another project is the mismatch branch.
  it('refuses a login role naming a different project than the declaration', () => {
    const v = viaPooler('postgres.zzzzzzzzzzzzzzzzzzzz')
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/One is wrong and this gate will not guess which/)
  })

  it('refuses the production ref even when it is the one that routed the connection', () => {
    const base = satisfying()
    const v = corroboration.evaluate({
      ...base,
      production: KNOWN_PRODUCTION_IDENTIFIERS,
      stagingIdentity: {
        ...base.stagingIdentity!,
        value: {
          declaredEnvironment: 'staging',
          projectRef: 'ctaxtgujyyprgynmnvtq',
          connectionHost: 'aws-0-us-east-2.pooler.supabase.com',
          poolerUser: 'postgres.ctaxtgujyyprgynmnvtq',
        },
      },
    })
    expect(v.satisfied).toBe(false)
    expect(v.detail).toMatch(/production denylist/)
  })

  // A USERNAME IS NOT A CREDENTIAL, AND A DSN IS NOT A USERNAME. If an operator
  // pastes a full connection string, it must be refused rather than stored.
  it.each([
    'postgres.bvyzblhqymxruxdguaee:hunter2',
    'postgresql://postgres.bvyzblhqymxruxdguaee@aws-0-us-east-2.pooler.supabase.com:5432/postgres',
    'postgres.bvyzblhqymxruxdguaee@host',
    'postgres bvyzblhqymxruxdguaee',
  ])('refuses %s, which could carry a credential', (value) => {
    expect(projectRefFromPoolerUser(value)).toBeNull()
    expect(viaPooler(value).satisfied).toBe(false)
  })

  it('parses only the exact postgres.<ref> shape', () => {
    expect(projectRefFromPoolerUser(`postgres.${STAGING_REF}`)).toBe(STAGING_REF)
    expect(projectRefFromPoolerUser('postgres')).toBeNull()
    expect(projectRefFromPoolerUser('postgres.short')).toBeNull()
    expect(projectRefFromPoolerUser('')).toBeNull()
  })
})

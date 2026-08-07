// tests/hosted/hosted-provisioning-runner.test.ts
// TRAIN 5C0 — Phase 7 and Phase 12. The phased runner, and the attack matrix.
//
// The thirteen attacks of Phase 12 are tagged ATTACK below. Each one must fail
// CLOSED — a specific refusal code, never a plan with a warning attached — and
// each is paired with the positive case it is the negation of, so a runner that
// refused everything would fail this file just as loudly as one that refused
// nothing.

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BASELINE_ORDER, BASELINE_UNITS, verifyBaselineOrder } from '@/db/hosted/baseline-manifest'
import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'
import { planHostedApply } from '@/db/hosted/hosted-migrator'
import { wrapperPathFor } from '@/db/hosted/baseline-journal-wrapper'
import {
  PROVISIONING_PHASES,
  deriveEmptinessProbes,
  STELLA_FEATURE_FLAGS,
  planProvisioningPhase,
  type ProvisioningRequest,
  type TargetStateProbe,
} from '@/db/hosted/hosted-provisioning-runner'

const ROOT = process.cwd()
const REF = 'abcdefghijklmnopqrst'

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

const stellaSources = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const name of HOSTED_CHAIN) {
    out[name] = readFileSync(path.join(ROOT, 'db', 'prepared', `${name}.sql`), 'utf8')
  }
  return out
}
const SOURCES = stellaSources()

const target = {
  declaredEnvironment: 'staging',
  declaredProjectRef: REF,
  connectionHost: `db.${REF}.supabase.co`,
  sentinel: null as { environment: string; projectRef: string } | null,
}

/** All three class-C probes affirmative. Absent or false is refused; see below. */
const PRIVILEGES_OK = {
  canCreateTriggerOnAuthUsers: true,
  ownsStorageObjects: true,
  evidenceBucketExists: true,
  applyIdentityRecorded: true,
  storageAdminMember: true,
  storageAdminInherits: true,
  canSetRoleStorageAdmin: true,
  setLocalRoleDemonstrated: true,
} as const

const VIRGIN: TargetStateProbe = {
  baselineUnitsInstalled: [],
  bootstrapSchemaPresent: false,
  sentinel: null,
  stellaPackagesInstalled: {},
  businessRowCounts: null,
  privileges: PRIVILEGES_OK,
}

/** Every table the fifty units create, all at zero. Derived, never hand-listed. */
const PROBED_TABLES = deriveEmptinessProbes(readBaselineSql)
const emptyCounts = (): Record<string, number> =>
  Object.fromEntries(PROBED_TABLES.map((t) => [t, 0]))

const BASELINE_DONE: TargetStateProbe = {
  baselineUnitsInstalled: [...BASELINE_ORDER],
  bootstrapSchemaPresent: false,
  sentinel: null,
  stellaPackagesInstalled: {},
  businessRowCounts: emptyCounts(),
  privileges: PRIVILEGES_OK,
  // Unit 41 needs BOTH halves. Its PART B runs through the managed channel, so
  // an ABSENT state means unknown, and the runner deletes 41 from the installed
  // set — which is what makes "PART A applied" stop reading as "unit 41 done".
  storageUnitState: 'UNIT_41_COMPLETE',
}

// Every chain package probed EXPLICITLY. Train 5B's planner treats an absent
// probe as unknown rather than as "not installed", so a fixture that omitted the
// nine would be testing the probe rule instead of whatever it claimed to test.
const BOOTSTRAPPED: TargetStateProbe = {
  ...BASELINE_DONE,
  bootstrapSchemaPresent: true,
  sentinel: { environment: 'staging', projectRef: REF },
  stellaPackagesInstalled: {
    ...Object.fromEntries(HOSTED_CHAIN.map((n) => [n, false])),
    stella_hosted_0001_managed_role_bootstrap: true,
  },
}

function request(overrides: Partial<ProvisioningRequest> = {}): ProvisioningRequest {
  return {
    phase: 'PHASE_BASELINE',
    target: { ...target },
    mode: 'dry-run',
    state: VIRGIN,
    featureFlags: {},
    readBaselineSql,
    stellaSources: SOURCES,
    discoveredBaselineFiles: discovered(),
    ...overrides,
  }
}

const refusal = (r: ReturnType<typeof planProvisioningPhase>) => {
  if (r.ok) throw new Error(`expected a refusal, got a plan for ${r.phase} with ${r.steps.length} steps`)
  return r
}
const plan = (r: ReturnType<typeof planProvisioningPhase>) => {
  if (!r.ok) throw new Error(`expected a plan, got ${r.code}: ${r.message}`)
  return r
}

/* ========================================================================== */
/* The happy path, phase by phase                                            */
/* ========================================================================== */

describe('the three phases, in sequence', () => {
  it('exposes them in the only order they may occur', () => {
    expect(PROVISIONING_PHASES).toEqual([
      'PHASE_BASELINE',
      'PHASE_STELLA_BOOTSTRAP',
      'PHASE_STELLA_CHAIN',
    ])
  })

  it('PHASE_BASELINE plans unit ZERO then all 50 units in manifest order, and permits no writes', () => {
    const result = plan(planProvisioningPhase(request()))
    // UNIT ZERO IS A STEP, NOT SETUP. The ledger table must exist before unit 1
    // can INSERT its row, and a prerequisite nobody plans is one somebody skips.
    expect(result.steps[0].id).toBe('000_journal_bootstrap')
    expect(result.steps.slice(1).map((s) => s.id)).toEqual([...BASELINE_ORDER])
    expect(result.steps).toHaveLength(51)
    expect(result.writesPermitted).toBe(false)
    expect(result.sequenceComplete).toBe(false)
    expect(result.nextAction).toMatch(/CHECKPOINT B0/)
  })

  it('every baseline step carries the pinned hash and a single-transaction command', () => {
    const result = plan(planProvisioningPhase(request()))
    for (const step of result.steps.slice(1)) {
      const unit = BASELINE_UNITS.find((u) => u.id === step.id)
      expect(unit, step.id).toBeDefined()
      expect(step.sha256).toBe(unit!.sha256)
      expect(step.command).toContain('psql -1 -v ON_ERROR_STOP=1')
    }
  })

  it('applies every unit through its journal wrapper, never the raw file — RR-25', () => {
    // The defect this closes: the plan named `psql -f <migration>` and nothing
    // wrote a ledger, so `baselineUnitsInstalled` was a list somebody typed.
    const result = plan(planProvisioningPhase(request()))
    for (const step of result.steps.slice(1)) {
      const unit = BASELINE_UNITS.find((u) => u.id === step.id)!
      expect(step.file, step.id).toBe(wrapperPathFor(unit))
      expect(step.command, step.id).toContain('uellix_project_ref')
    }
  })

  it('PHASE_STELLA_BOOTSTRAP plans exactly the bootstrap and stops at the sentinel', () => {
    const result = plan(planProvisioningPhase(request({ phase: 'PHASE_STELLA_BOOTSTRAP', state: BASELINE_DONE })))
    expect(result.steps.map((s) => s.id)).toEqual(['stella_hosted_0001_managed_role_bootstrap'])
    expect(result.nextAction).toMatch(/OPERATOR writes uellix_bootstrap\.staging_sentinel/)
    expect(result.sequenceComplete).toBe(false)
  })

  it('PHASE_STELLA_CHAIN plans the remaining nine once the sentinel exists', () => {
    const result = plan(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_CHAIN',
          state: BOOTSTRAPPED,
          target: { ...target, sentinel: { environment: 'staging', projectRef: REF } },
        }),
      ),
    )
    expect(result.steps).toHaveLength(9)
    expect(result.steps.map((s) => s.id)).not.toContain('stella_hosted_0001_managed_role_bootstrap')
    expect(result.steps.at(-1)!.id).toBe('stella_0018_category_bound_operation_tickets')
    expect(result.sequenceComplete).toBe(true)
  })

  it('APPLY refuses while the production ref denylist is empty — the veto must be loaded first', () => {
    // Adversarial review of Train 5C1: the apply-authorization gate consulted
    // `productionDenylistStatus`, and NOTHING consulted the gate. Both planners
    // minted writesPermitted: true with the ref veto never loaded. The check now
    // lives on the write path, where the risk is.
    const r = refusal(
      planProvisioningPhase(
        request({
          mode: 'apply',
          applyConfirmation: `hosted_apply:${REF}`,
          production: { hosts: ['app.uellix.com'], projectRefs: [] },
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_PRODUCTION_DENYLIST_EMPTY')
  })

  it('…but a DRY RUN with an empty denylist still works, because it removes a veto, not a gate', () => {
    const p = plan(
      planProvisioningPhase(request({ production: { hosts: ['app.uellix.com'], projectRefs: [] } })),
    )
    expect(p.writesPermitted).toBe(false)
    expect(p.steps).toHaveLength(51)
  })

  it('apply mode requires a confirmation minted for THIS project', () => {
    const base = {
      phase: 'PHASE_BASELINE' as const,
      mode: 'apply' as const,
      production: { hosts: ['app.uellix.com'], projectRefs: ['pppppppppppppppppppp'] },
    }
    expect(refusal(planProvisioningPhase(request(base))).code).toBe('HOSTED_APPLY_CONFIRMATION_REQUIRED')
    expect(
      refusal(planProvisioningPhase(request({ ...base, applyConfirmation: 'hosted_apply:zzzzzzzzzzzzzzzzzzzz' }))).code,
    ).toBe('HOSTED_APPLY_CONFIRMATION_MISMATCH')
    expect(
      plan(planProvisioningPhase(request({ ...base, applyConfirmation: `hosted_apply:${REF}` }))).writesPermitted,
    ).toBe(true)
  })
})

/* ========================================================================== */
/* Phase 12 — the attack matrix                                              */
/* ========================================================================== */

describe('ATTACK 1 — Stella without a complete baseline', () => {
  it('refuses the bootstrap when one unit is missing', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_BOOTSTRAP',
          state: { ...BASELINE_DONE, baselineUnitsInstalled: BASELINE_ORDER.slice(0, 49) },
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_BASELINE_INCOMPLETE')
    expect(r.message).toContain('008_marketing_leads_rls.sql')
  })

  it('refuses the chain when the baseline is missing entirely', () => {
    const r = refusal(planProvisioningPhase(request({ phase: 'PHASE_STELLA_CHAIN', state: VIRGIN })))
    expect(r.code).toBe('PROVISIONING_BASELINE_INCOMPLETE')
  })
})

describe('ATTACK 2 — a policy ordered before the table it protects', () => {
  it('verifyBaselineOrder refuses 008 hoisted above 0035', () => {
    const reordered = [...BASELINE_UNITS]
    const policyIndex = reordered.findIndex((u) => u.id === '008_marketing_leads_rls.sql')
    const tableIndex = reordered.findIndex((u) => u.id === '0035_phase5_marketing_leads.sql')
    const [policy] = reordered.splice(policyIndex, 1)
    reordered.splice(tableIndex, 0, policy)

    const problems = verifyBaselineOrder(reordered)
    expect(problems.some((p) => p.kind === 'ORDER_BROKEN' && p.unit === '008_marketing_leads_rls.sql')).toBe(true)
  })

  it('and refuses 0039 hoisted above the Supabase unit that defines its functions', () => {
    const reordered = [...BASELINE_UNITS]
    const i39 = reordered.findIndex((u) => u.id === '0039_grant_rls_helper_execution.sql')
    const iStorage = reordered.findIndex((u) => u.id === '20260716000001_storage_policies.sql')
    const [u39] = reordered.splice(i39, 1)
    reordered.splice(iStorage, 0, u39)

    expect(
      verifyBaselineOrder(reordered).some(
        (p) => p.kind === 'ORDER_BROKEN' && p.detail.includes('20260716000001_storage_policies.sql'),
      ),
    ).toBe(true)
  })
})

describe('ATTACK 3 — a file omitted', () => {
  it('refuses PHASE_BASELINE when a unit cannot be read', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          readBaselineSql: (f) => (f === 'db/migrations/0031_rls_core.sql' ? null : readBaselineSql(f)),
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_BASELINE_MANIFEST_INVALID')
    expect(r.message).toContain('MISSING_FILE')
  })
})

describe('ATTACK 4 — a file duplicated', () => {
  it('refuses a unit id that appears twice', () => {
    const doubled = [...BASELINE_UNITS, { ...BASELINE_UNITS[0], ordinal: 51 }]
    expect(verifyBaselineOrder(doubled).some((p) => p.kind === 'DUPLICATE_UNIT')).toBe(true)
  })

  it('refuses two unit ids pointing at one file', () => {
    const aliased = [...BASELINE_UNITS, { ...BASELINE_UNITS[0], id: 'alias.sql', ordinal: 51 }]
    expect(
      verifyBaselineOrder(aliased).some((p) => p.kind === 'DUPLICATE_UNIT' && p.unit === 'alias.sql'),
    ).toBe(true)
  })

  it('refuses an orphan file on disk that no unit claims', () => {
    const r = refusal(
      planProvisioningPhase(request({ discoveredBaselineFiles: [...discovered(), 'db/migrations/0040_smuggled.sql'] })),
    )
    expect(r.code).toBe('PROVISIONING_BASELINE_MANIFEST_INVALID')
  })
})

describe('ATTACK 5 — a changed hash', () => {
  it('refuses PHASE_BASELINE when any unit drifts by one byte', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          readBaselineSql: (f) =>
            f === 'db/policies/002_stella_interactions_rls.sql'
              ? `${readBaselineSql(f)}\n-- drift\n`
              : readBaselineSql(f),
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_BASELINE_MANIFEST_INVALID')
    expect(r.message).toContain('SHA_MISMATCH')
  })
})

describe('ATTACK 6 — a changed order', () => {
  it('refuses a renumbered chain', () => {
    const shuffled = BASELINE_UNITS.map((u, i) => (i === 5 ? { ...u, ordinal: 99 } : u))
    expect(verifyBaselineOrder(shuffled).some((p) => p.kind === 'ORDER_BROKEN')).toBe(true)
  })
})

describe('ATTACK 7 — a production seed smuggled into the baseline', () => {
  it('refuses a unit that gains a literal VALUES insert', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          readBaselineSql: (f) =>
            f === 'db/migrations/0000_quick_husk.sql'
              ? `${readBaselineSql(f)}\nINSERT INTO organizations (name, slug) VALUES ('Fundación Real', 'real');\n`
              : readBaselineSql(f),
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_BASELINE_MANIFEST_INVALID')
    // Both signals fire: the bytes moved AND the meaning did.
    expect(r.message).toMatch(/SHA_MISMATCH|SCAN_MISMATCH/)
  })
})

describe('ATTACK 8 — service_role introduced', () => {
  it('refuses a unit that starts granting to service_role', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          readBaselineSql: (f) =>
            f === 'db/migrations/0012_stella_interactions.sql'
              ? `${readBaselineSql(f)}\nGRANT ALL ON public.stella_interactions TO service_role;\n`
              : readBaselineSql(f),
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_BASELINE_MANIFEST_INVALID')
  })
})

describe('ATTACK 9 — a superuser dependency introduced', () => {
  it('refuses a unit that starts reading rolsuper', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          readBaselineSql: (f) =>
            f === 'db/migrations/0029_integrity.sql'
              ? `${readBaselineSql(f)}\nDO $$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN RAISE EXCEPTION 'no'; END IF; END $$;\n`
              : readBaselineSql(f),
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_BASELINE_MANIFEST_INVALID')
    expect(r.message).toContain('GLOBAL_INVARIANT_VIOLATED')
  })
})

describe('ATTACK 10 — production as the target', () => {
  it.each([
    ['app.uellix.com', 'a known production host'],
    ['uellix-antigravity.vercel.app', 'the hardcoded fallback origin'],
  ])('refuses %s (%s) in every phase', (host) => {
    for (const phase of PROVISIONING_PHASES) {
      const state = phase === 'PHASE_BASELINE' ? VIRGIN : phase === 'PHASE_STELLA_BOOTSTRAP' ? BASELINE_DONE : BOOTSTRAPPED
      const r = refusal(
        planProvisioningPhase(request({ phase, state, target: { ...target, connectionHost: host } })),
      )
      expect(r.code, phase).toBe('HOSTED_TARGET_IS_PRODUCTION')
    }
  })

  it('refuses a declared project ref on the production denylist, even with a matching sentinel', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_CHAIN',
          state: BOOTSTRAPPED,
          target: { ...target, sentinel: { environment: 'staging', projectRef: REF } },
          production: { hosts: [], projectRefs: [REF] },
        }),
      ),
    )
    expect(r.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  it('refuses a target that does not declare itself staging', () => {
    const r = refusal(
      planProvisioningPhase(request({ target: { ...target, declaredEnvironment: 'production' } })),
    )
    expect(r.code).toBe('HOSTED_TARGET_ENVIRONMENT_NOT_STAGING')
  })
})

describe('ATTACK 11 — the sentinel written as an automatic step', () => {
  it('refuses in every phase, before any other check', () => {
    for (const phase of PROVISIONING_PHASES) {
      const r = refusal(planProvisioningPhase(request({ phase, sentinelWriteRequested: true })))
      expect(r.code, phase).toBe('PROVISIONING_SENTINEL_IS_NOT_A_MIGRATION')
    }
  })

  it('refuses even when everything else about the request is valid', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_BOOTSTRAP',
          state: BASELINE_DONE,
          mode: 'apply',
          applyConfirmation: `hosted_apply:${REF}`,
          sentinelWriteRequested: true,
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_SENTINEL_IS_NOT_A_MIGRATION')
  })
})

describe('ATTACK 12 — the chain before the sentinel', () => {
  it('refuses PHASE_STELLA_CHAIN while the sentinel row is absent', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_CHAIN',
          state: { ...BOOTSTRAPPED, sentinel: null },
          target: { ...target, sentinel: null },
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_SENTINEL_REQUIRED')
  })

  it('refuses the chain before the bootstrap has created the sentinel table at all', () => {
    const r = refusal(
      planProvisioningPhase(request({ phase: 'PHASE_STELLA_CHAIN', state: BASELINE_DONE })),
    )
    expect(r.code).toBe('PROVISIONING_BOOTSTRAP_MISSING')
  })

  it('refuses a sentinel that names a different project', () => {
    const other = 'zyxwvutsrqponmlkjihg'
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_CHAIN',
          state: { ...BOOTSTRAPPED, sentinel: { environment: 'staging', projectRef: other } },
          target: { ...target, sentinel: { environment: 'staging', projectRef: other } },
        }),
      ),
    )
    expect(r.code).toBe('HOSTED_TARGET_SENTINEL_MISMATCH')
  })

  it('refuses a sentinel that declares the database production, under EVERY policy', () => {
    // The waiver excuses ABSENCE only. A sentinel that exists and contradicts is
    // fatal in the pre-bootstrap phases too — and it is refused on IDENTITY
    // grounds rather than on virginity grounds, because identity is checked
    // first by design: a database we were never allowed to touch should be
    // reported as such, not as a database in the wrong state.
    const lying = { environment: 'production', projectRef: REF }
    const r = refusal(
      planProvisioningPhase(request({ phase: 'PHASE_BASELINE', state: { ...VIRGIN, sentinel: lying }, target: { ...target, sentinel: lying } })),
    )
    expect(r.code).toBe('HOSTED_TARGET_SENTINEL_NOT_STAGING')

    const r2 = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_BOOTSTRAP',
          state: { ...BASELINE_DONE, sentinel: lying },
          target: { ...target, sentinel: lying },
        }),
      ),
    )
    expect(r2.code).toBe('HOSTED_TARGET_SENTINEL_NOT_STAGING')
  })
})

describe('ATTACK 13 — a feature flag left true', () => {
  it.each(STELLA_FEATURE_FLAGS)('refuses when %s is true', (flag) => {
    const r = refusal(planProvisioningPhase(request({ featureFlags: { [flag]: 'true' } })))
    expect(r.code).toBe('PROVISIONING_FEATURE_FLAG_ENABLED')
    expect(r.message).toContain(flag)
  })

  it('treats an unrecognised value as ENABLED, because a typo that reads as off is never found', () => {
    expect(refusal(planProvisioningPhase(request({ featureFlags: { STELLA_ENABLED: 'maybe' } }))).code).toBe(
      'PROVISIONING_FEATURE_FLAG_ENABLED',
    )
    expect(refusal(planProvisioningPhase(request({ featureFlags: { STELLA_ENABLED: '1' } }))).code).toBe(
      'PROVISIONING_FEATURE_FLAG_ENABLED',
    )
  })

  it('accepts the spellings of false', () => {
    for (const off of ['false', 'FALSE', '0', 'no', 'off', '']) {
      expect(planProvisioningPhase(request({ featureFlags: { STELLA_ENABLED: off } })).ok, off).toBe(true)
    }
    expect(planProvisioningPhase(request({ featureFlags: { STELLA_ENABLED: false } })).ok).toBe(true)
  })
})

describe('ATTACK 14 — a class-C privilege the platform may not grant (adversarial review A)', () => {
  it('refuses PHASE_BASELINE when the privilege probes were not run at all', () => {
    const r = refusal(
      planProvisioningPhase(request({ state: { ...VIRGIN, privileges: undefined } })),
    )
    expect(r.code).toBe('PROVISIONING_PRIVILEGE_PROBE_MISSING')
  })

  it.each([
    'canCreateTriggerOnAuthUsers',
    'ownsStorageObjects',
    'evidenceBucketExists',
  ] as const)('refuses when %s is unmeasured', (key) => {
    const r = refusal(
      planProvisioningPhase(
        request({ state: { ...VIRGIN, privileges: { ...PRIVILEGES_OK, [key]: null } } }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_PRIVILEGE_PROBE_MISSING')
    expect(r.message).toContain(key)
  })

  it.each(['canCreateTriggerOnAuthUsers', 'ownsStorageObjects', 'evidenceBucketExists'] as const)(
    'refuses when %s is FALSE — before planning a single step',
    (key) => {
      const r = refusal(
        planProvisioningPhase(
          request({ state: { ...VIRGIN, privileges: { ...PRIVILEGES_OK, [key]: false } } }),
        ),
      )
      expect(r.code).toBe('PROVISIONING_PRIVILEGE_UNAVAILABLE')
      expect(r.message).toContain(key)
    },
  )

  it('the two class-C units are exactly the ones the probes cover', () => {
    expect(BASELINE_UNITS.filter((u) => u.managed === 'C-requires-adaptation').map((u) => u.id)).toEqual([
      '20260716000000_auth_trigger.sql',
      '20260716000001_storage_policies.sql',
    ])
  })
})

/* ========================================================================== */
/* The compensating control for the deferred sentinel                        */
/* ========================================================================== */

describe('the sentinel waiver is paid for, not granted', () => {
  it('PHASE_BASELINE refuses a target that is not virgin', () => {
    const r = refusal(
      planProvisioningPhase(request({ state: { ...VIRGIN, baselineUnitsInstalled: ['0000_quick_husk.sql'] } })),
    )
    expect(r.code).toBe('PROVISIONING_TARGET_NOT_VIRGIN')
    expect(r.message).toContain('DESTROY_AND_REPROVISION')
  })

  it('PHASE_STELLA_BOOTSTRAP refuses when emptiness was not measured at all', () => {
    const r = refusal(
      planProvisioningPhase(
        request({ phase: 'PHASE_STELLA_BOOTSTRAP', state: { ...BASELINE_DONE, businessRowCounts: null } }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_EMPTINESS_PROBE_MISSING')
  })

  it('refuses when a single required probe is absent — an unprobed table is unknown, not empty', () => {
    const partial = emptyCounts()
    delete partial['public.stella_interactions']
    const r = refusal(
      planProvisioningPhase(
        request({ phase: 'PHASE_STELLA_BOOTSTRAP', state: { ...BASELINE_DONE, businessRowCounts: partial } }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_EMPTINESS_PROBE_MISSING')
    expect(r.message).toContain('public.stella_interactions')
  })

  it('probes EVERY table the fifty units create, not a hand-picked shortlist', () => {
    // Adversarial review B: the list used to be nine names written by hand, and
    // it omitted the three tables the baseline's ONLY DML writes to. A
    // partially-restored production copy with empty tenancy tables would have
    // passed.
    for (const table of ['public.funders', 'public.project_investments', 'public.financial_proxies']) {
      expect(PROBED_TABLES, `${table} is written by 0018 and must be probed`).toContain(table)
    }
    expect(PROBED_TABLES.length).toBeGreaterThan(25)
  })

  it('refuses when a table 0018 writes to holds rows, even if the tenancy tables are empty', () => {
    const subsetRestore = { ...emptyCounts(), 'public.project_investments': 4200 }
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_BOOTSTRAP',
          state: { ...BASELINE_DONE, businessRowCounts: subsetRestore },
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_TARGET_NOT_EMPTY')
    expect(r.message).toContain('public.project_investments=4200')
  })

  it('refuses when any probed table holds a row', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_BOOTSTRAP',
          state: { ...BASELINE_DONE, businessRowCounts: { ...emptyCounts(), 'public.organizations': 1 } },
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_TARGET_NOT_EMPTY')
    expect(r.message).toContain('public.organizations=1')
  })

  it('does NOT accept two signals once the sentinel table exists — the chain requires three', () => {
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_CHAIN',
          state: { ...BOOTSTRAPPED, sentinel: null },
          target: { ...target, sentinel: null },
        }),
      ),
    )
    expect(r.code).toBe('PROVISIONING_SENTINEL_REQUIRED')
  })
})

describe('the sentinel boundary cannot be crossed inside one apply', () => {
  it('planHostedApply refuses an apply that carries the bootstrap AND the chain', () => {
    const r = planHostedApply({
      target: { ...target, sentinel: { environment: 'staging', projectRef: REF } },
      packages: [...HOSTED_CHAIN],
      mode: 'apply',
      applyConfirmation: `hosted_apply:${REF}`,
      installedProbes: {},
      sources: SOURCES,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('HOSTED_SENTINEL_BOUNDARY_CROSSED')
  })

  it('a bootstrapOnly APPLY demands the emptiness attestation the waiver is paid with', () => {
    // Adversarial review A: "set by the runner, never by an operator" was a
    // comment. A direct call reached a two-signal apply of the role/ownership
    // bootstrap with no emptiness evidence at this layer.
    const r = planHostedApply({
      target: { ...target, sentinel: null },
      packages: ['stella_hosted_0001_managed_role_bootstrap'],
      mode: 'apply',
      applyConfirmation: `hosted_apply:${REF}`,
      installedProbes: {},
      sources: SOURCES,
      bootstrapOnly: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('HOSTED_EMPTINESS_ATTESTATION_REQUIRED')
  })

  it('a bootstrapOnly plan must be exactly the bootstrap', () => {
    const r = planHostedApply({
      target: { ...target, sentinel: null },
      packages: ['stella_hosted_0001_managed_role_bootstrap', 'grounding_0002_document_versions'],
      mode: 'apply',
      applyConfirmation: `hosted_apply:${REF}`,
      installedProbes: {},
      sources: SOURCES,
      bootstrapOnly: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('HOSTED_BOOTSTRAP_ONLY_PLAN_INVALID')
  })

  it('REGRESSION: a first provisioning can now be PLANNED at all', () => {
    // Train 5B could not. verifyStagingTarget demanded the sentinel from every
    // plan, and the bootstrap is the package that creates its table, so the very
    // first hosted apply was unreachable. This is the assertion that would have
    // caught it.
    const dryRun = planHostedApply({
      target: { ...target, sentinel: null },
      packages: [...HOSTED_CHAIN],
      mode: 'dry-run',
      installedProbes: {},
      sources: SOURCES,
    })
    expect(dryRun.ok, dryRun.ok ? '' : `${dryRun.code}: ${dryRun.message}`).toBe(true)
    if (dryRun.ok) expect(dryRun.log.join(' ')).toContain('sentinel DEFERRED')
  })

  it('and the default sentinel policy is unchanged for everything else', () => {
    const chainOnly = planHostedApply({
      target: { ...target, sentinel: null },
      packages: HOSTED_CHAIN.filter((n) => n !== 'stella_hosted_0001_managed_role_bootstrap'),
      mode: 'dry-run',
      installedProbes: { stella_hosted_0001_managed_role_bootstrap: true },
      sources: SOURCES,
    })
    expect(chainOnly.ok).toBe(false)
    if (!chainOnly.ok) expect(chainOnly.code).toBe('HOSTED_TARGET_SENTINEL_MISSING')
  })
})

describe('phase sequencing', () => {
  it('refuses an unknown phase', () => {
    const r = refusal(planProvisioningPhase(request({ phase: 'PHASE_WHATEVER' as never })))
    expect(r.code).toBe('PROVISIONING_PHASE_UNKNOWN')
  })

  it('refuses re-running the bootstrap phase once uellix_bootstrap exists', () => {
    const r = refusal(
      planProvisioningPhase(request({ phase: 'PHASE_STELLA_BOOTSTRAP', state: BOOTSTRAPPED })),
    )
    expect(r.code).toBe('PROVISIONING_PHASE_OUT_OF_SEQUENCE')
  })

  it('refuses PHASE_STELLA_CHAIN when a supersession probe was not supplied', () => {
    // An unprobed successor is unknown, not absent. Train 5B found this failing
    // OPEN once; the phased runner must not reintroduce it by forwarding a
    // half-filled probe map.
    const r = refusal(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_CHAIN',
          state: {
            ...BOOTSTRAPPED,
            stellaPackagesInstalled: { stella_hosted_0001_managed_role_bootstrap: true },
          },
          target: { ...target, sentinel: { environment: 'staging', projectRef: REF } },
        }),
      ),
    )
    expect(r.code).toBe('HOSTED_PROBE_MISSING')
  })

  it('reports the sequence complete only when the chain is fully installed', () => {
    const done = plan(
      planProvisioningPhase(
        request({
          phase: 'PHASE_STELLA_CHAIN',
          state: {
            ...BOOTSTRAPPED,
            stellaPackagesInstalled: Object.fromEntries(HOSTED_CHAIN.map((n) => [n, true])),
          },
          target: { ...target, sentinel: { environment: 'staging', projectRef: REF } },
        }),
      ),
    )
    expect(done.sequenceComplete).toBe(true)
    expect(done.steps).toEqual([])
    expect(done.nextAction).toBeNull()
  })
})

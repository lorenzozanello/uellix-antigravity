// tests/hosted/hosted-migrator.test.ts
// TRAIN 5B — Phase 7. The hosted apply surface, which is a PLANNER: it opens no
// connection and this suite could not make it open one.
//
// `db/migrator.ts` requests the `local_migration` capability, which accepts
// loopback and container targets only. That is correct and stays correct — this
// module is the separate surface Phase 7 asks for, and the separation is the
// reason a hosted mistake cannot be made with the local tool.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { HOSTED_CHAIN } from '@/db/hosted/hosted-package-manifest'
import { planHostedApply, type HostedApplyRequest } from '@/db/hosted/hosted-migrator'

const REF = 'abcdefghijklmnopqrst'

function sources(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    out[name] = readFileSync(path.join(process.cwd(), 'db', 'prepared', `${name}.sql`), 'utf8')
  }
  return out
}

// The base fixture is the WHOLE chain, because a plan that includes the
// bootstrap is a first provisioning and must apply all ten packages. A fixture
// that tripped a completeness rule instead of the rule under test would make
// every assertion in this file ambiguous.
function request(overrides: Partial<HostedApplyRequest> = {}): HostedApplyRequest {
  const packages = [...HOSTED_CHAIN]
  return {
    target: {
      declaredEnvironment: 'staging',
      declaredProjectRef: REF,
      connectionHost: `db.${REF}.supabase.co`,
      sentinel: { environment: 'staging', projectRef: REF },
    },
    packages,
    mode: 'dry-run',
    installedProbes: {},
    sources: sources(packages),
    ...overrides,
  }
}

describe('planHostedApply — dry run', () => {
  it('produces one step per package, in chain order, and permits no writes', () => {
    const plan = planHostedApply(request())

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.writesPermitted).toBe(false)
    expect(plan.steps.map((s) => s.package)).toEqual([...HOSTED_CHAIN])
  })

  it('records the source hash AND the generated hash for every step', () => {
    const plan = planHostedApply(request())

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    for (const step of plan.steps) {
      expect(step.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(step.generatedSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('never puts SQL in the log lines — only names, hashes and counts', () => {
    const plan = planHostedApply(request())

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    for (const line of plan.log) {
      expect(line).not.toContain('CREATE ')
      expect(line).not.toContain('GRANT ')
      expect(line).not.toContain('postgresql://')
    }
  })
})

// TRAIN 5C0 AMENDMENT TO THIS SUITE'S FIXTURE.
//
// The base `request()` above is the whole ten-package chain, and its comment
// explains why: a plan containing the bootstrap was a first provisioning and had
// to carry all ten. That is no longer an appliable shape. Train 5C0 established
// that a human writes uellix_bootstrap.staging_sentinel BETWEEN the bootstrap
// and the chain, so an apply that spans both crosses a boundary no confirmation
// authorizes, and `planHostedApply` now refuses it with
// HOSTED_SENTINEL_BOUNDARY_CROSSED before it ever reaches the apply gate.
//
// The confirmation contract itself is unchanged, so these tests keep testing it
// — against the shape that an apply is now allowed to have.
const applyRequest = (overrides: Partial<HostedApplyRequest> = {}): HostedApplyRequest =>
  request({
    packages: ['stella_hosted_0001_managed_role_bootstrap'],
    sources: sources(['stella_hosted_0001_managed_role_bootstrap']),
    bootstrapOnly: true,
    emptinessAttested: true,
    // TRAIN 5C1. Apply mode now refuses while the production project-ref veto is
    // empty, so an apply-mode fixture has to load one. The refusal itself is
    // tested separately below; here it would only mask the confirmation contract
    // these three cases exist to pin.
    production: { hosts: ['app.uellix.com'], projectRefs: ['pppppppppppppppppppp'] },
    target: {
      declaredEnvironment: 'staging',
      declaredProjectRef: REF,
      connectionHost: `db.${REF}.supabase.co`,
      sentinel: null,
    },
    ...overrides,
  })

describe('planHostedApply — apply mode requires its own explicit confirmation', () => {
  it('refuses apply with no confirmation, even against a fully valid target', () => {
    const plan = planHostedApply(applyRequest({ mode: 'apply' }))

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_APPLY_CONFIRMATION_REQUIRED')
  })

  it('refuses a confirmation minted for a different project', () => {
    const plan = planHostedApply(
      applyRequest({ mode: 'apply', applyConfirmation: `hosted_apply:zyxwvutsrqponmlkjihg` }),
    )

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_APPLY_CONFIRMATION_MISMATCH')
  })

  it('accepts the exact confirmation, and only then permits writes', () => {
    const plan = planHostedApply(
      applyRequest({ mode: 'apply', applyConfirmation: `hosted_apply:${REF}` }),
    )

    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.writesPermitted).toBe(true)
  })

  it('refuses APPLY while the production project-ref denylist is empty', () => {
    // The default KNOWN_PRODUCTION_IDENTIFIERS ships with projectRefs: [], and
    // this planner is one of two paths to writesPermitted: true. A guard on one
    // of two doors is a guard on neither.
    const plan = planHostedApply(
      applyRequest({
        mode: 'apply',
        applyConfirmation: `hosted_apply:${REF}`,
        production: { hosts: ['app.uellix.com'], projectRefs: [] },
      }),
    )
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_PRODUCTION_DENYLIST_EMPTY')
  })

  it('refuses an apply that spans the bootstrap AND the chain, however well confirmed', () => {
    const plan = planHostedApply(request({ mode: 'apply', applyConfirmation: `hosted_apply:${REF}` }))

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_SENTINEL_BOUNDARY_CROSSED')
  })

  it('a dry run IGNORES a valid confirmation — read-only means read-only', () => {
    const plan = planHostedApply(
      request({ mode: 'dry-run', applyConfirmation: `hosted_apply:${REF}` }),
    )

    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.writesPermitted).toBe(false)
  })
})

describe('planHostedApply — target identity is checked before anything else', () => {
  it('refuses a production target and never reaches package planning', () => {
    const plan = planHostedApply(
      request({
        target: {
          declaredEnvironment: 'staging',
          declaredProjectRef: REF,
          connectionHost: 'app.uellix.com',
          sentinel: { environment: 'staging', projectRef: REF },
        },
      }),
    )

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_TARGET_IS_PRODUCTION')
  })

  // TRAIN 5C0. This test used to run the FULL chain with sentinel: null and
  // assert a refusal. That assertion was the circularity, written down: the
  // full chain includes the bootstrap, the bootstrap is what creates the
  // sentinel's table, so the refusal it was pinning meant the first hosted
  // provisioning could never be planned. It looked like a security property and
  // was a deadlock.
  //
  // The property it MEANT to pin is real and is kept, exactly: a plan that does
  // not create the sentinel's table has no excuse for the row being absent.
  it('refuses a missing sentinel for any plan that is not creating the sentinel table', () => {
    const chainOnly = HOSTED_CHAIN.filter((n) => n !== 'stella_hosted_0001_managed_role_bootstrap')
    const plan = planHostedApply(
      request({
        packages: chainOnly,
        sources: sources(chainOnly),
        installedProbes: { stella_hosted_0001_managed_role_bootstrap: true },
        target: {
          declaredEnvironment: 'staging',
          declaredProjectRef: REF,
          connectionHost: `db.${REF}.supabase.co`,
          sentinel: null,
        },
      }),
    )

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_TARGET_SENTINEL_MISSING')
  })
})

describe('planHostedApply — package order', () => {
  it('refuses a package that is not in the hosted chain', () => {
    const plan = planHostedApply(
      request({ packages: ['stella_0004_role_separation'], sources: { stella_0004_role_separation: '-- x' } }),
    )

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_PACKAGE_NOT_IN_CHAIN')
  })

  it('refuses packages presented out of chain order', () => {
    const names = ['grounding_0003_evidence_chunks', 'grounding_0002_document_versions']
    const plan = planHostedApply(request({ packages: names, sources: sources(names) }))

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_PACKAGE_OUT_OF_ORDER')
  })

  it('refuses stella_0014 when the stella_0015 probe reports its successor installed', () => {
    const names = ['stella_0014_operation_tickets']
    const plan = planHostedApply(
      request({
        packages: names,
        sources: sources(names),
        installedProbes: { stella_0015_project_bound_operation_tickets: true },
      }),
    )

    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('DB_MIGRATOR_PACKAGE_ORDER_VIOLATION')
      expect(plan.message).toContain('stella_0015_project_bound_operation_tickets')
    }
  })

  it('refuses stella_0005c_rollback when stella_0017 is installed — the registry rule that is a ROLLBACK', () => {
    const plan = planHostedApply(
      request({
        packages: ['stella_0005c_rollback'],
        sources: { stella_0005c_rollback: '-- x' },
        installedProbes: { stella_0017_governed_stella_consumption: true },
      }),
    )

    expect(plan.ok).toBe(false)
    // It is not in the hosted chain at all, which is a STRONGER refusal than
    // the order rule and must be the one reported.
    if (!plan.ok) expect(plan.code).toBe('HOSTED_PACKAGE_NOT_IN_CHAIN')
  })
})

describe('planHostedApply — source integrity', () => {
  it('refuses when a canonical source has drifted from its manifest pin', () => {
    const base = request()
    const drifted = { ...base.sources }
    drifted['grounding_0002_document_versions'] =
      `-- somebody edited this\n${drifted['grounding_0002_document_versions']}`

    const plan = planHostedApply({ ...base, sources: drifted })

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_SOURCE_SHA_MISMATCH')
  })

  it('refuses when a source is missing entirely rather than skipping the package', () => {
    const plan = planHostedApply(request({ sources: {} }))

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_SOURCE_MISSING')
  })
})

describe('planHostedApply — the whole chain', () => {
  it('plans all ten packages in order when every source is present', () => {
    const plan = planHostedApply(request({ packages: [...HOSTED_CHAIN], sources: sources(HOSTED_CHAIN) }))

    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.steps).toHaveLength(10)
  })

  it('refuses a chain that omits the grounding packages — Phase 5 treats them as a unit', () => {
    const names = HOSTED_CHAIN.filter((n) => !n.startsWith('grounding_'))
    const plan = planHostedApply(request({ packages: names, sources: sources(names) }))

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_GROUNDING_UNIT_INCOMPLETE')
  })

  it('refuses a chain that stops before stella_0018 — R6a and R6b would stay open', () => {
    const names = HOSTED_CHAIN.filter((n) => n !== 'stella_0018_category_bound_operation_tickets')
    const plan = planHostedApply(request({ packages: names, sources: sources(names) }))

    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('HOSTED_TICKET_CHAIN_INCOMPLETE')
  })

  it('REFUSES an incremental plan whose supersession probe was never supplied', () => {
    // Adversarial review A: `installedProbes[x] === true` used to read a missing
    // key as "not installed", so a runner that forgot to probe got a plan that
    // re-applied a superseded package.
    const names = ['stella_0014_operation_tickets']
    const plan = planHostedApply(
      request({
        packages: names,
        sources: sources(names),
        installedProbes: { stella_hosted_0001_managed_role_bootstrap: true },
      }),
    )

    expect(plan.ok).toBe(false)
    if (!plan.ok) {
      expect(plan.code).toBe('HOSTED_PROBE_MISSING')
      expect(plan.message).toContain('stella_0015_project_bound_operation_tickets')
    }
  })

  it('does NOT demand probes on a first provisioning — nothing can be installed yet', () => {
    const plan = planHostedApply(request({ installedProbes: {} }))

    expect(plan.ok).toBe(true)
  })

  it('allows a single grounding package only when the other two are already installed', () => {
    const names = ['grounding_0003_evidence_chunks']
    const plan = planHostedApply(
      request({
        packages: names,
        sources: sources(names),
        installedProbes: {
          stella_hosted_0001_managed_role_bootstrap: true,
          grounding_0002_document_versions: true,
          grounding_0004_runtime_attestation: true,
        },
      }),
    )

    expect(plan.ok).toBe(true)
  })
})

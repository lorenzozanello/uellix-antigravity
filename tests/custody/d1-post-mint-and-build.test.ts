// @vitest-environment node
// tests/custody/d1-post-mint-and-build.test.ts
//
// The v1.0.4 N11 exit split, the post-mint failure table, the mint-route
// record, and the production build closure. Pure; no vault, no socket.
//
// Mutation controls carried here: N11 closed before the verification it
// requires; mint success with deposit failure and no compensation.

import { describe, expect, it } from 'vitest'

import {
  MINT_ROUTES,
  MINT_ROUTE_DECISION_STATUS,
  POST_MINT_SCENARIOS,
  n11Status,
  type PostMintFacts,
} from '@/scripts/custody/d1-post-mint'
import { PRODUCTION_ENTRY_POINTS, deriveClosure, requiresOf } from '@/scripts/custody/build-production-entrypoints'

const ALL: PostMintFacts = {
  mutationIssued: true,
  mutationAccepted: true,
  validUntilEqualsN09: true,
  n30ExitMet: true,
  n13RanOnDeliveredValue: true,
  n13Kp1Passed: true,
}

describe('n11Status under the v1.0.4 exit split', () => {
  it('is CLOSED only when every fact holds', () => {
    expect(n11Status(ALL)).toBe('CLOSED')
  })
  it('CONTROL N11-closed-before-verification: any missing post-mint fact keeps N11 open', () => {
    for (const k of Object.keys(ALL) as (keyof PostMintFacts)[]) {
      expect(n11Status({ ...ALL, [k]: false }), k).not.toBe('CLOSED')
    }
    expect(n11Status({ ...ALL, n13Kp1Passed: false })).toBe('ACT_COMPLETE__USABILITY_FAILED')
    expect(n11Status({ ...ALL, n30ExitMet: false })).toBe('ACT_COMPLETE__USABILITY_PENDING')
    expect(n11Status({ ...ALL, mutationIssued: false })).toBe('NOT_EXECUTED')
  })
})

describe('the post-mint failure table', () => {
  const byId = new Map(POST_MINT_SCENARIOS.map((s) => [s.id, s]))

  it('covers the six scenarios of the lane plus the refused mint', () => {
    expect([...byId.keys()].sort()).toEqual(['PM-0', 'PM-1', 'PM-2', 'PM-3', 'PM-4', 'PM-5', 'PM-6'])
  })
  it('CONTROL mint-success/deposit-failure-without-compensation: an undeposited live credential is always withdrawn', () => {
    const pm1 = byId.get('PM-1')!
    expect(pm1.compensation).toBe('ROTATE_AGAIN_OR_PASSWORD_NULL__UNDER_A_FRESH_HUMAN_CONFIRMATION')
    expect(pm1.fresh_hc1_required_before_any_further_credential_mutation).toBe(true)
  })
  it('every scenario requires a fresh HC-1 before any further credential mutation, and none answers NB-8', () => {
    for (const s of POST_MINT_SCENARIOS) {
      expect(s.fresh_hc1_required_before_any_further_credential_mutation).toBe(true)
      expect(s.password_null_permitted).toMatch(/UNRESOLVED_NB8/)
    }
  })
  it('a failed verification or a failed cleanup removes the entry through the governed path', () => {
    expect(byId.get('PM-3')!.compensation).toMatch(/^GOVERNED_REMOVAL_OF_THE_ENTRY/)
    expect(byId.get('PM-5')!.compensation).toMatch(/^GOVERNED_REMOVAL_OF_THE_ENTRY/)
  })
})

describe('the mint route record', () => {
  it('does not choose: two routes, neither executable without an owner decision', () => {
    expect(MINT_ROUTES.map((r) => r.name)).toEqual(['MANAGEMENT_PLANE', 'SQL_BOUND_PARAMETER'])
    expect(MINT_ROUTE_DECISION_STATUS).toBe('OWNER_DECISION_REQUIRED_MINT_ROUTE')
    for (const r of MINT_ROUTES) expect(r.unresolved.length).toBeGreaterThan(0)
  })
  it('carries no credential-shaped example', () => {
    expect(JSON.stringify(MINT_ROUTES)).not.toMatch(/postgres(?:ql)?:\/\//i)
  })
})

describe('the production build closure is derived from what TypeScript emits', () => {
  const closure = deriveClosure(process.cwd(), PRODUCTION_ENTRY_POINTS)

  it('includes every entry point and requires nothing from node_modules', () => {
    for (const e of PRODUCTION_ENTRY_POINTS) expect(closure.has(e)).toBe(true)
    for (const text of closure.values()) {
      for (const spec of requiresOf(text)) expect(spec.startsWith('node:') || spec.startsWith('.')).toBe(true)
    }
  })

  it('follows no type-only import', () => {
    expect(closure.has('db/safety/database-target.ts')).toBe(false)
  })

  it('refuses a static require of a package', () => {
    const files: Record<string, string> = { 'a/entry.ts': "import postgres from 'postgres'\nexport const x = postgres\n" }
    expect(() => deriveClosure('/r', ['a/entry.ts'], (abs) => files[abs.replace(/\\/g, '/').replace(/^\/r\//, '')]!)).toThrow(/node_modules/)
  })
})

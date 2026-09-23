// @vitest-environment node
// tests/custody/d1-post-mint-and-build.test.ts
//
// The v1.0.4 N11 exit split, the post-mint failure table, the mint-route
// record, and the production build closure. Pure; no vault, no socket.
//
// Mutation controls carried here: N11 closed before the verification it
// requires; mint success with deposit failure and no compensation; automatic
// PASSWORD NULL without its own confirmation; ROTATE AGAIN on a spent HC-1.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  HUMAN_CONFIRMATION_REQUIRED_FRESH_HC1,
  HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL,
  MINT_ROUTES,
  MINT_ROUTE_DECISION_STATUS,
  MINT_ROUTE_OWNER_DECISION_FILE,
  POST_MINT_SCENARIOS,
  compensationGate,
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

describe('the post-mint state table', () => {
  const byId = new Map(POST_MINT_SCENARIOS.map((s) => [s.id, s]))

  it('covers every boundary of the ratified route, from the transaction to the governed removal', () => {
    expect([...byId.keys()]).toEqual(['PM-0', 'PM-1', 'PM-2', 'PM-3', 'PM-4', 'PM-5', 'PM-6', 'PM-7', 'PM-8', 'PM-9', 'PM-10', 'PM-11'])
  })
  it('CONTROL mint-success/deposit-failure-without-compensation: an undeposited live credential must be rotated or withdrawn', () => {
    for (const id of ['PM-1', 'PM-2', 'PM-3']) {
      const s = byId.get(id)!
      expect(s.credential, id).toBe('LIVE_ON_TARGET_UNUSABLE_OR_UNPROVEN')
      expect(s.rotate_again, id).toBe('REQUIRED_UNDER_FRESH_HC1_OR_WITHDRAW')
      expect(s.password_null, id).toBe('AVAILABLE_ONLY_UNDER_HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL')
    }
  })
  it('no state permits an automatic credential mutation, and every state needs a fresh HC-1 before one', () => {
    for (const s of POST_MINT_SCENARIOS) {
      expect(s.automatic_credential_mutation, s.id).toBe(false)
      expect(s.fresh_hc1_required_before_any_credential_mutation, s.id).toBe(true)
    }
  })
  it('a failure before COMMIT leaves no new credential and nothing to compensate', () => {
    expect(byId.get('PM-0')).toMatchObject({ credential: 'NO_NEW_CREDENTIAL', password_null: 'NOT_APPLICABLE', rotate_again: 'NOT_REQUIRED' })
  })
})

describe('the compensation gates', () => {
  const SPENT = ['HC1@87520a97', 'HC1-MINT']
  it('CONTROL automatic-PASSWORD-NULL: an HC-1, spent or fresh, never authorizes PASSWORD NULL', () => {
    expect(compensationGate({ action: 'PASSWORD_NULL', confirmation: null, spent: SPENT })).toMatchObject({ permitted: false, requires: HUMAN_CONFIRMATION_REQUIRED_PASSWORD_NULL })
    expect(compensationGate({ action: 'PASSWORD_NULL', confirmation: { id: 'HC1-MINT', kind: 'HC-1', signed: true }, spent: SPENT }).permitted).toBe(false)
    expect(compensationGate({ action: 'PASSWORD_NULL', confirmation: { id: 'HC1-NEW', kind: 'HC-1', signed: true }, spent: SPENT }).permitted).toBe(false)
    expect(compensationGate({ action: 'PASSWORD_NULL', confirmation: { id: 'PN-1', kind: 'PASSWORD_NULL', signed: false }, spent: SPENT }).permitted).toBe(false)
    expect(compensationGate({ action: 'PASSWORD_NULL', confirmation: { id: 'PN-1', kind: 'PASSWORD_NULL', signed: true }, spent: SPENT }).permitted).toBe(true)
  })
  it('CONTROL automatic-ROTATE-AGAIN-with-spent-HC-1: only a fresh, signed HC-1 authorizes a rotation', () => {
    expect(compensationGate({ action: 'ROTATE_AGAIN', confirmation: { id: 'HC1@87520a97', kind: 'HC-1', signed: true }, spent: SPENT })).toMatchObject({ permitted: false, requires: HUMAN_CONFIRMATION_REQUIRED_FRESH_HC1 })
    expect(compensationGate({ action: 'ROTATE_AGAIN', confirmation: { id: 'HC1-MINT', kind: 'HC-1', signed: true }, spent: SPENT }).permitted).toBe(false)
    expect(compensationGate({ action: 'ROTATE_AGAIN', confirmation: { id: 'PN-1', kind: 'PASSWORD_NULL', signed: true }, spent: SPENT }).permitted).toBe(false)
    expect(compensationGate({ action: 'ROTATE_AGAIN', confirmation: { id: 'HC1-NEW', kind: 'HC-1', signed: true }, spent: SPENT }).permitted).toBe(true)
  })
})

describe('the mint route record', () => {
  it('keeps both routes analysed and records the owner\'s ratification of B, which authorizes no act', () => {
    expect(MINT_ROUTES.map((r) => r.name)).toEqual(['MANAGEMENT_PLANE', 'SQL_BOUND_PARAMETER'])
    expect(MINT_ROUTE_DECISION_STATUS).toBe('RATIFIED_B_SQL_BOUND_PARAMETER')
    const owner = JSON.parse(readFileSync(join(process.cwd(), MINT_ROUTE_OWNER_DECISION_FILE), 'utf8')) as { DECISIONS_VERBATIM: Record<string, string> }
    expect(owner.DECISIONS_VERBATIM).toEqual({
      D1_MINT_ROUTE: 'B_SQL_BOUND_PARAMETER',
      D1_MINT_OPERATOR_TOOL: 'EPHEMERAL_NODE_PG_OUTSIDE_REPOSITORY',
      D1_PASSWORD_NULL_REQUIRES_SEPARATE_HUMAN_CONFIRMATION: 'YES',
      SIGNED: 'YES',
    })
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

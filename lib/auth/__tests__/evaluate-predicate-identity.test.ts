/**
 * lib/auth/__tests__/evaluate-predicate-identity.test.ts
 *
 * N-22 — PREDICATE IDENTITY over all SEVEN Evaluate authority concepts,
 * asserted STRUCTURALLY because it is undetectable behaviourally.
 * Plus M-12, M-13 and M-14, which prove N-22 is not vacuous.
 *
 * MANIFEST PATH CONFORMANCE
 * ------------------------
 * EVALUATE_COMMERCIAL_V1_TEST_MANIFEST_v1.0.0.json names this file as
 * lib/auth/__tests__/evaluate-predicate-identity.test.ts, and that is where it
 * lives. An earlier revision of this package placed it under lib/auth/tests/
 * and recorded the mismatch as an open finding rather than silently widening
 * scope; the coordinator write-set restatement resolved it to __tests__, which
 * agrees with the manifest. Finding CLOSED.
 *
 * N-22 clause (6) — "each Evaluate server action calls the predicate matching
 * its own act" — is DEFERRED_TO_W_EV_5, not PASS. No Evaluate server action
 * exists. See the clause (6) describe block below, which asserts the surface
 * is empty rather than asserting the clause over an empty set.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  EVALUATE_CONCEPTS,
  EVALUATE_EXTENSIONS,
  analyzeEvaluateSource,
  evaluateServerActionSurface,
  extractConstant,
  extractFunction,
  orderedProhibitionPairs,
  stripComments,
} from './evaluate-source-analyzer'
import { ALL_ROLES, ROLE_HIERARCHY, type Role } from '../roles'

const PERMISSIONS_PATH = path.join(process.cwd(), 'lib', 'auth', 'permissions.ts')
const SOURCE = readFileSync(PERMISSIONS_PATH, 'utf8')

// ---------------------------------------------------------------------------
// Analyzer self-checks. A structural control is only worth its cost if it can
// be shown to FAIL. Every assertion below exists because a checker that cannot
// go red is indistinguishable from one that is not running.
// ---------------------------------------------------------------------------

describe('analyzer is non-vacuous (positive controls)', () => {
  it('reads a non-trivial permissions.ts, not an empty or missing file', () => {
    expect(SOURCE.length).toBeGreaterThan(5000)
    expect(SOURCE).toContain('lib/auth/permissions.ts')
  })

  it('extracts the seven predicates and the seven constants from the real file', () => {
    const code = stripComments(SOURCE)
    for (const c of EVALUATE_CONCEPTS) {
      expect(extractFunction(code, c.predicate), c.predicate).not.toBeNull()
      expect(extractConstant(code, c.constant), c.constant).not.toBeNull()
    }
  })

  it('reports a MISSING predicate rather than silently passing', () => {
    const mutated = SOURCE.replace('export function canArchiveEvaluation', 'function canArchiveEvaluationRenamed')
    expect(mutated).not.toBe(SOURCE)
    const findings = analyzeEvaluateSource(mutated)
    expect(findings.some((f) => f.clause === '1')).toBe(true)
  })

  it('reports a hierarchy substitution', () => {
    const mutated = SOURCE.replace(
      'return EVALUATE_CREATE_ROLES.includes(role)',
      "return hasRole(role, 'impact_manager')"
    )
    expect(mutated).not.toBe(SOURCE)
    expect(analyzeEvaluateSource(mutated).some((f) => f.clause === '5')).toBe(true)
  })

  it('reports a constant derived from another constant', () => {
    const mutated = SOURCE.replace(
      "const EVALUATE_ARCHIVE_ROLES: readonly Role[] = ['impact_manager', 'organization_admin']",
      'const EVALUATE_ARCHIVE_ROLES: readonly Role[] = [...EVALUATE_DECISION_ROLES]'
    )
    expect(mutated).not.toBe(SOURCE)
    expect(analyzeEvaluateSource(mutated).some((f) => f.clause === '4')).toBe(true)
  })

  it('does NOT flag prohibited tokens that appear only in prose', () => {
    // permissions.ts deliberately names hasRole and isInReviewSet in the
    // Evaluate commentary, explaining why each is forbidden. Those must not
    // register as violations, or the control would be unimplementable.
    expect(SOURCE).toContain('hasRole')
    expect(SOURCE).toContain('isInReviewSet')
    expect(analyzeEvaluateSource(SOURCE)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// N-22 clauses (1)-(5)
// ---------------------------------------------------------------------------

describe('N-22 (1) each of the seven exists as its own named export', () => {
  it.each(EVALUATE_CONCEPTS.map((c) => [c.predicate, c.concept]))(
    '%s is a named export (%s)',
    (predicate) => {
      expect(extractFunction(stripComments(SOURCE), predicate as string)).not.toBeNull()
    }
  )

  it('there are exactly seven concepts, predicates and constants', () => {
    expect(EVALUATE_CONCEPTS).toHaveLength(7)
    expect(new Set(EVALUATE_CONCEPTS.map((c) => c.predicate)).size).toBe(7)
    expect(new Set(EVALUATE_CONCEPTS.map((c) => c.constant)).size).toBe(7)
  })
})

describe('N-22 (2) each predicate reads its OWN closed constant', () => {
  it.each(EVALUATE_CONCEPTS.map((c) => [c.predicate, c.constant]))(
    '%s reads %s',
    (predicate, constant) => {
      const fn = extractFunction(stripComments(SOURCE), predicate as string)
      expect(fn).not.toBeNull()
      expect(fn!.body).toContain(constant as string)
    }
  )
})

describe('N-22 (3) 42 ordered prohibition pairs', () => {
  const pairs = orderedProhibitionPairs()

  it('the matrix is complete by construction: 7 x 6 = 42 unique ordered pairs', () => {
    expect(pairs).toHaveLength(42)
    expect(new Set(pairs.map((p) => p.subject + '->' + p.otherPredicate)).size).toBe(42)
    for (const c of EVALUATE_CONCEPTS) {
      expect(pairs.filter((p) => p.subject === c.predicate)).toHaveLength(6)
    }
  })

  it.each(pairs.map((p) => [p.subject, p.otherConstant, p.otherPredicate]))(
    '%s neither reads %s nor delegates to %s',
    (subject, otherConstant, otherPredicate) => {
      const fn = extractFunction(stripComments(SOURCE), subject as string)
      expect(fn).not.toBeNull()
      expect(fn!.body).not.toContain(otherConstant as string)
      expect(fn!.body).not.toContain(otherPredicate as string)
    }
  )

  it('does NOT assert the seven role sets differ — extensional equality is permitted', () => {
    // Requiring the extensions to differ would contradict the ratified role
    // semantics. What must differ is CONSTANT IDENTITY, never extension.
    const extensions = EVALUATE_CONCEPTS.map((c) =>
      [...EVALUATE_EXTENSIONS[c.constant]].sort().join(',')
    )
    expect(new Set(extensions).size).toBe(3)
    const equalExtensionPairs = pairs.filter(
      (p) =>
        [...EVALUATE_EXTENSIONS[p.subjectConstant]].sort().join(',') ===
        [...EVALUATE_EXTENSIONS[p.otherConstant]].sort().join(',')
    )
    expect(equalExtensionPairs).toHaveLength(14)
  })
})

describe('N-22 (4) no constant is derived, spread or computed from another', () => {
  it.each(EVALUATE_CONCEPTS.map((c) => [c.constant]))('%s is a standalone literal array', (constant) => {
    const k = extractConstant(stripComments(SOURCE), constant as string)
    expect(k).not.toBeNull()
    expect(k!.initializer).not.toContain('...')
    for (const other of EVALUATE_CONCEPTS) {
      if (other.constant === constant) continue
      expect(k!.initializer).not.toContain(other.constant)
    }
  })
})

describe('N-22 (5) no hierarchy admission and no review/Stella-set derivation', () => {
  const FORBIDDEN = ['hasRole', 'ROLE_HIERARCHY', '>=', 'isInReviewSet', 'REVIEW_ROLES', 'STELLA_ROLES']

  it.each(EVALUATE_CONCEPTS.map((c) => [c.predicate]))('%s contains no forbidden construct', (predicate) => {
    const fn = extractFunction(stripComments(SOURCE), predicate as string)
    expect(fn).not.toBeNull()
    for (const token of FORBIDDEN) {
      expect(fn!.body, predicate + ' must not use ' + token).not.toContain(token)
    }
    expect(fn!.signature, predicate + ' must not accept a role set').not.toMatch(/Role\s*\[\s*\]/)
  })

  it('the whole Evaluate surface analyzes clean', () => {
    expect(analyzeEvaluateSource(SOURCE)).toEqual([])
  })
})

describe('N-22 (6) server-action binding — DEFERRED_TO_W_EV_5', () => {
  it('no Evaluate server action exists, so the clause is deferred and NOT asserted', () => {
    // Measured, not assumed. If this ever becomes non-empty, clause (6) has
    // become executable and this test must be replaced by the real assertion
    // rather than updated to keep passing.
    const tracked = execGitTrackedPaths()
    const surface = evaluateServerActionSurface(tracked)
    expect(tracked.length).toBeGreaterThan(100)
    expect(surface).toEqual([])
  })
})

function execGitTrackedPaths(): string[] {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: process.cwd() })
    .split(/\r?\n/)
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// M-12 / M-13 / M-14 — mutation controls.
//
// Each mutation is behaviour-preserving by construction: it substitutes a
// predicate whose extension is IDENTICAL today. The control is the ASYMMETRY —
// every role-varying fixture stays GREEN while N-22 turns RED. A suite in
// which these leave everything green has no predicate-identity coverage at
// all, regardless of how many role fixtures it carries.
// ---------------------------------------------------------------------------

/** Membership under a constant's ratified extension, for all six roles. */
function extensionVector(constant: string): boolean[] {
  return ALL_ROLES.map((r: Role) => EVALUATE_EXTENSIONS[constant].includes(r))
}

interface MutationCase {
  id: string
  subject: string
  subjectConstant: string
  donorConstant: string
  donorPredicate: string
}

const MUTATIONS: MutationCase[] = [
  {
    id: 'M-12',
    subject: 'canDraftEvaluationTemplate',
    subjectConstant: 'EVALUATE_TEMPLATE_DRAFT_ROLES',
    donorConstant: 'EVALUATE_DECISION_ROLES',
    donorPredicate: 'canDecideEvaluation',
  },
  {
    id: 'M-13',
    subject: 'canArchiveEvaluation',
    subjectConstant: 'EVALUATE_ARCHIVE_ROLES',
    donorConstant: 'EVALUATE_DECISION_ROLES',
    donorPredicate: 'canDecideEvaluation',
  },
  {
    id: 'M-14',
    subject: 'canCreateEvaluation',
    subjectConstant: 'EVALUATE_CREATE_ROLES',
    donorConstant: 'EVALUATE_DECISION_ROLES',
    donorPredicate: 'canDecideEvaluation',
  },
]

describe.each(MUTATIONS)('$id mutation control', (m) => {
  it('is behaviourally UNDETECTABLE: the donor extension is identical for all six roles', () => {
    // This is the GREEN half. No role-varying fixture can separate them, so
    // every such fixture necessarily stays green under the substitution.
    expect(extensionVector(m.subjectConstant)).toEqual(extensionVector(m.donorConstant))
    expect(ALL_ROLES).toHaveLength(6)
  })

  it('constant substitution turns N-22 RED', () => {
    const original = 'return ' + m.subjectConstant + '.includes(role)'
    expect(SOURCE).toContain(original)
    const mutated = SOURCE.replace(original, 'return ' + m.donorConstant + '.includes(role)')
    expect(mutated).not.toBe(SOURCE)

    const findings = analyzeEvaluateSource(mutated)
    expect(findings.length).toBeGreaterThan(0)
    // Specifically: the subject no longer reads its own constant (clause 2)
    // and now reads the donor's (clause 3).
    expect(findings.some((f) => f.clause === '2' && f.detail.includes(m.subject))).toBe(true)
    expect(findings.some((f) => f.clause === '3' && f.detail.includes(m.donorConstant))).toBe(true)
  })

  it('predicate delegation turns N-22 RED', () => {
    const original = 'return ' + m.subjectConstant + '.includes(role)'
    const mutated = SOURCE.replace(original, 'return ' + m.donorPredicate + '(role, role)')
    expect(mutated).not.toBe(SOURCE)

    const findings = analyzeEvaluateSource(mutated)
    expect(findings.some((f) => f.clause === '3' && f.detail.includes('delegates to ' + m.donorPredicate))).toBe(true)
  })

  it('the pristine source is GREEN — the asymmetry is real, not an always-red checker', () => {
    expect(analyzeEvaluateSource(SOURCE)).toEqual([])
  })
})

describe('M-12 second half — generic hierarchical helper substitution', () => {
  it('hasRole substitution turns N-22 RED and ALSO diverges behaviourally on super_admin', () => {
    const original = "return EVALUATE_TEMPLATE_DRAFT_ROLES.includes(role)"
    expect(SOURCE).toContain(original)
    const mutated = SOURCE.replace(original, "return hasRole(role, 'impact_manager')")

    // Structural: clause (5).
    const findings = analyzeEvaluateSource(mutated)
    expect(findings.some((f) => f.clause === '5' && f.detail.includes('hasRole'))).toBe(true)

    // Behavioural: unlike the constant substitutions above, THIS one is also
    // role-detectable — hasRole(super_admin, X) is true for every X, so the
    // super_admin draft denial flips. Both halves must turn red.
    const draftSet = EVALUATE_EXTENSIONS.EVALUATE_TEMPLATE_DRAFT_ROLES
    expect(draftSet).not.toContain('super_admin')
    // ROLE_HIERARCHY: super_admin=100 >= impact_manager=60, so hasRole admits it.
    expect(hierarchyWouldAdmit('super_admin', 'impact_manager')).toBe(true)
  })
})

function hierarchyWouldAdmit(userRole: Role, requiredRole: Role): boolean {
  // Reproduces hasRole() WITHOUT calling it, so this control measures the
  // hierarchy itself rather than trusting the helper under test.
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole]
}

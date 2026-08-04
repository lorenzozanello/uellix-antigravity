// tests/capability-policy-contract.test.ts
//
// The capability contract, applied to the packages as they are on disk.
//
// tests/capability-isolation.test.ts asserts SHAPE: five forward scripts, nine
// cap_invitation_* policies, three of them RESTRICTIVE, one grant per function.
// Every one of those properties is invariant under the twenty-two mutations
// that survived it. This file asserts CONTENT: for each of the 36 policies, the
// exact table, mode, command, TO list, USING and WITH CHECK; for each conferred
// privilege, the exact privilege, columns, object and grantee; and for each
// function, the business guards and the ORDER they run in.
//
// The gates themselves live in tests/helpers/capability-gates.ts as a pure
// function, because tests/capability-mutation.test.ts has to run the same code
// over deliberately broken copies. If a gate ever moves back into an assertion
// that reads the disk itself, the mutation harness stops being able to see it
// and the guarantee it provides quietly evaporates.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  evaluateCapabilityGates,
  CAPABILITY_SQL_FILES,
  POLICY_CONTRACT,
  GRANT_CONTRACT,
  FORWARD,
  DISCLOSURE_FLAGS,
  type Sources,
} from './helpers/capability-gates'
import {
  parsePolicies,
  analyzeSecurity,
  unparsedSecurityStatements,
} from './helpers/sql-structure'

const PREPARED = path.resolve(process.cwd(), 'db', 'prepared')

export function loadSources(): Sources {
  const out: Record<string, string> = {}
  for (const f of CAPABILITY_SQL_FILES) out[f] = readFileSync(path.join(PREPARED, f), 'utf8')
  return out
}

const SOURCES = loadSources()

describe('capability contract — the packages on disk satisfy every gate', () => {
  it('produces no violations at all', () => {
    const violations = evaluateCapabilityGates(SOURCES)
    // Printed in full rather than counted: a gate that fires has to say what it
    // saw, or the next person debugging it re-derives the whole contract.
    expect(violations.map((v) => `${v.gate}: ${v.detail}`)).toEqual([])
  })
})

describe('capability contract — nothing in the packages is unreadable', () => {
  it.each(CAPABILITY_SQL_FILES)('%s contains no unparsed security statement', (file) => {
    // The fail-closed half of the guarantee, asserted on its own rather than
    // only through the aggregate gate. "Zero violations" is a claim about the
    // contract; "zero unparsed" is a claim about the PARSER, and the second one
    // is what makes the first one mean anything: a reader that silently drops
    // what it cannot understand reports the same zero either way.
    expect(
      unparsedSecurityStatements(SOURCES[file]).map(
        (u) => `${u.reason} @${u.line} (${u.origin}): ${u.lead}`,
      ),
    ).toEqual([])
  })

  it('descends into the executable bodies rather than treating them as opaque', () => {
    // The rollbacks issue almost all of their DCL from inside DO blocks. If the
    // scanner stopped at the dollar quote, every one of those files would parse
    // as "no security statements at all" — and every rollback gate would be
    // green for a file that could contain anything.
    const rb = analyzeSecurity(SOURCES['stella_0006_rollback.sql'])
    const fromBodies = rb.revokes.filter((r) => r.origin !== 'file')
    expect(fromBodies.length, 'no statement was read from an executable body').toBeGreaterThan(0)
  })

  it('reads a role attribute statement for every capability role', () => {
    // Structured rather than regex-matched, so a quoted spelling of the role is
    // the same role. Without this the role-attribute gate can only report on
    // the statements it happened to recognise.
    const roles = [
      ['stella_0006_invitation_capability.sql', 'uellix_cap_invitation'],
      ['stella_0007_public_verification_capability.sql', 'uellix_cap_verification'],
      ['stella_0008_stripe_webhook_identity.sql', 'uellix_cap_stripe'],
      ['stella_0009_public_lead_capability.sql', 'uellix_cap_lead'],
      ['stella_0010_organization_bootstrap_capability.sql', 'uellix_cap_bootstrap'],
    ] as const
    for (const [file, role] of roles) {
      const stmts = analyzeSecurity(SOURCES[file]).roleStatements.filter((s) => s.role === role)
      expect(stmts.some((s) => s.verb === 'ALTER'), `${file}: no ALTER ROLE for ${role}`).toBe(true)
      expect(stmts.some((s) => s.verb === 'CREATE'), `${file}: no CREATE ROLE for ${role}`).toBe(true)
    }
  })

  it('the campaign contains no whole-catalogue ownership statement and no default privilege', () => {
    for (const file of CAPABILITY_SQL_FILES) {
      const a = analyzeSecurity(SOURCES[file])
      expect(a.ownedStatements, `${file}: REASSIGN/DROP OWNED`).toEqual([])
      expect(a.defaultPrivileges, `${file}: ALTER DEFAULT PRIVILEGES`).toEqual([])
    }
  })
})

describe('capability contract — the contract itself is complete', () => {
  it('names every policy the five packages create, and no other', () => {
    // Guards the guard. A policy added to a package without a contract row would
    // otherwise be judged by nothing, and the gate would still be green.
    for (const file of Object.values(FORWARD)) {
      const onDisk = parsePolicies(SOURCES[file]).map((p) => p.name).sort()
      const declared = POLICY_CONTRACT.filter((p) => p.file === file).map((p) => p.name).sort()
      expect(declared, file).toEqual(onDisk)
    }
  })

  it('covers every policy on disk, and the count is derived from the SQL', () => {
    // `expect(POLICY_CONTRACT).toHaveLength(36)` was a fact about
    // capability-gates.ts, not about the packages: it could only fail if
    // someone edited the constant. The number has to come from the files.
    const onDisk = Object.values(FORWARD).reduce(
      (n, f) => n + parsePolicies(SOURCES[f]).length,
      0,
    )
    expect(POLICY_CONTRACT).toHaveLength(onDisk)
  })

  it('pins a TO clause for every policy on disk, and never a widened role', () => {
    // Reads the SQL, not the constant. Iterating POLICY_CONTRACT to check that
    // POLICY_CONTRACT has no widened role restates the constant; gate 2 already
    // covers the files, and this is the assertion that says so out loud.
    for (const file of Object.values(FORWARD)) {
      for (const p of parsePolicies(SOURCES[file])) {
        expect(p.roles.length, `${p.name} has no TO clause`).toBeGreaterThan(0)
        // A RESTRICTIVE policy can only ever NARROW what the role it names may
        // do, so naming a pre-existing role is not a widening. Exactly one
        // policy in the campaign does it, and it does it because
        // `authenticated` is the PostgREST principal the privilege escalation
        // ran through — bounding it anywhere else would miss the browser.
        const narrowing =
          p.name === 'cap_members_no_super_admin_grant' && p.permissive === 'RESTRICTIVE'
        if (narrowing) continue
        for (const r of p.roles)
          expect(['public', 'anon', 'authenticated', 'service_role'], `${p.name} → ${r}`).not.toContain(r)
      }
    }
  })

  it('cap_members_no_super_admin_grant covers all three runtime principals, not just the reachable two', () => {
    // uellix_writer is NOLOGIN and granted to uellix_app with SET FALSE, so it
    // is not reachable via SET ROLE today — the omission would not have been
    // exploitable. The policy names it anyway, because the guarantee must not
    // rest on that role attribute never changing: a RESTRICTIVE policy can
    // only narrow, so naming a third role costs nothing.
    const policy = parsePolicies(SOURCES[FORWARD.CAP07]).find(
      (p) => p.name === 'cap_members_no_super_admin_grant',
    )
    expect(policy, 'cap_members_no_super_admin_grant is absent').toBeDefined()
    expect(policy!.roles).toEqual(
      expect.arrayContaining(['uellix_app', 'authenticated', 'uellix_writer']),
    )
    expect(policy!.roles).toHaveLength(3)
  })

  it('pins a predicate on every policy that can carry one', () => {
    // A policy with neither USING nor WITH CHECK bounds nothing. INSERT has no
    // USING and SELECT/DELETE have no WITH CHECK, so the requirement is that at
    // least one of the two is present — and that a RESTRICTIVE policy is not
    // unbounded on EVERY clause it has.
    for (const file of Object.values(FORWARD)) {
      for (const p of parsePolicies(SOURCES[file])) {
        expect(p.using ?? p.withCheck, `${p.name} carries no predicate`).not.toBeNull()
        if (p.permissive !== 'RESTRICTIVE') continue
        const clauses = [p.using, p.withCheck].filter((x): x is string => x !== null)
        // The previous form compared the filtered array to ['true'], so a
        // RESTRICTIVE FOR ALL with USING (true) WITH CHECK (true) — the only
        // fully unbounded shape, and the exact one this test exists to forbid —
        // produced ['true','true'] and passed.
        expect(
          clauses.every((c) => c === 'true'),
          `${p.name} is RESTRICTIVE and unbounded on every clause it has`,
        ).toBe(false)
      }
    }
  })

  it('declares a non-empty privilege contract for every package', () => {
    for (const file of Object.values(FORWARD)) {
      const declared = GRANT_CONTRACT[file]
      expect(declared, `${file} has no grant contract`).toBeDefined()
      // `toBeDefined()` passes for []. A package that confers privileges and
      // declares none would have been judged by nothing.
      expect(declared!.length, `${file} declares no privileges`).toBeGreaterThan(0)
    }
  })

  it('derives the CAP-02 publication flags from the table, not from a constant', () => {
    // The finding M-08 records is that a gate walking a hardcoded list of names
    // cannot see the name that is not on it. Asserting `DISCLOSURE_FLAGS`
    // has length 6 repeats that mistake one flag later: it pins the constant
    // against itself. The set has to come from the CREATE TABLE.
    const table = /CREATE TABLE IF NOT EXISTS public\.report_public_disclosures \(([\s\S]*?)\n\);/.exec(
      SOURCES[FORWARD.CAP02],
    )
    expect(table, 'the disclosure table is not created').not.toBeNull()
    const declared = [...table![1].matchAll(/^\s*(show_\w+)\s+boolean/gm)].map((m) => m[1]).sort()
    expect(declared).toEqual([...DISCLOSURE_FLAGS].sort())
    expect(declared).toContain('show_issued_on')
    expect(declared).toContain('show_report_variant')
  })
})

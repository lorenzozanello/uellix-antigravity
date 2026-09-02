// tests/hosted/prechain-remediation.test.ts
// COMMIT 5.2 — the forward-only prechain remediation, as a contract.
//
// The engine half — that the package applies to an exact-staging-shaped
// PostgreSQL 17.6 instance, that a second apply is refused, and that governed
// T1..T9 then reach 9/9 — is measured by `pnpm certify:pg176 --remediation`.
// What lives here is everything that must hold WITHOUT Docker: the identity,
// the pin, the witness, and the machine-enforced dependency between the
// remediation and T1.
//
// Each test below is written from the failure it prevents, because a contract
// that only passes when everything is already right is not a contract.

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

import {
  authorizeGovernedT1,
  classifyRemediation,
  EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES,
  PRECHAIN_GRANTS,
  PRECHAIN_REMEDIATION,
  sha256OfPreparedSql,
  type RemediationObservation,
} from '@/db/hosted/prechain-remediation'
import {
  collapseByObject,
  derivePrechainRequirements,
} from '@/db/hosted/authority/certification/prechain-requirements'

const ROOT = process.cwd()
const SQL = readFileSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile), 'utf8')

/* -------------------------------------------------------------------------- */
/* Identity and pin                                                            */
/* -------------------------------------------------------------------------- */

describe('the package is registered, pinned, and is NOT a chain package', () => {
  it('exists at the path the registry names', () => {
    expect(existsSync(path.join(ROOT, PRECHAIN_REMEDIATION.sourceFile))).toBe(true)
    expect(PRECHAIN_REMEDIATION.kind).toBe('prechain-remediation')
  })

  it('matches its pinned digest', () => {
    // The gate that makes a checked-in operator script auditable rather than
    // merely present. An edited byte moves this and the mismatch is the point.
    expect(sha256OfPreparedSql(SQL)).toBe(PRECHAIN_REMEDIATION.sourceSha256)
  })

  it('normalizes line endings before hashing, so a CRLF checkout still matches', () => {
    expect(sha256OfPreparedSql('a;\r\nb;\r\n')).toBe(sha256OfPreparedSql('a;\nb;\n'))
  })

  it('is not one of the nine witnessed chain packages', async () => {
    // If it were, it would acquire chain witnesses, appear in nextChainPackage,
    // and become something an operator could be told to apply "next" — which is
    // exactly wrong: it is a PREREQUISITE of T1, not a member of the sequence.
    const { WITNESSED_PACKAGES } = await import('@/db/hosted/package-witnesses')
    const { CHAIN_PACKAGE_FILES } = await import('@/db/hosted/authority/window-plan')

    expect(WITNESSED_PACKAGES).not.toContain(PRECHAIN_REMEDIATION.id)
    expect(CHAIN_PACKAGE_FILES.map((e) => e.sourceFile)).not.toContain(
      `${PRECHAIN_REMEDIATION.id}.sql`,
    )
  })

  it('ships no rollback script, and says why in a reviewable sentence', () => {
    expect(existsSync(path.join(ROOT, 'db/prepared/stella_hosted_0002_rollback.sql'))).toBe(false)
    expect(PRECHAIN_REMEDIATION.forwardOnlyNoRollbackReason).toMatch(/FORWARD-ONLY/)
    expect(PRECHAIN_REMEDIATION.forwardOnlyNoRollbackReason.length).toBeGreaterThan(200)
  })

  it('names the COMMENT omission as a decision rather than dropping it silently', () => {
    expect(PRECHAIN_REMEDIATION.commentOmission).toMatch(/USAGE/)
    expect(PRECHAIN_REMEDIATION.commentOmission).toMatch(/metadata/)
    // And the SQL itself carries the reason where a reader will meet it.
    expect(SQL).toMatch(/NO COMMENT ON is issued for this function/)
  })
})

/* -------------------------------------------------------------------------- */
/* The SQL itself                                                              */
/* -------------------------------------------------------------------------- */

describe('the SQL grants exactly the derived prerequisite set', () => {
  it('grants every object the derivation requires, and no other', () => {
    // The inventory is compared against the DERIVATION, not against itself.
    // The derivation spells a function without its argument list (it comes
    // from a GRANT identity); the inventory spells it with `()` because that is
    // what the SQL writes. Normalised on both sides rather than on one.
    const bare = (o: string): string => o.replace(/\(\)$/, '')
    const derived = new Set(
      collapseByObject(derivePrechainRequirements(ROOT)).map((c) => bare(c.object)),
    )
    const granted = new Set(PRECHAIN_GRANTS.map((g) => bare(g.object)))

    for (const object of derived) {
      expect(granted, `derived requirement not granted: ${object}`).toContain(object)
    }
    // The shim is granted too and is NOT one of the eight — it is a prerequisite
    // of the installer rather than of uellix_owner, so it is stated explicitly.
    for (const object of granted) {
      expect(
        derived.has(object) || object === 'public.uellix_auth_uid',
        `granted something nothing depends on: ${object}`,
      ).toBe(true)
    }
  })

  it('issues no GRANT ALL, nothing to PUBLIC, and nothing to a runtime role', () => {
    expect(SQL).not.toMatch(/GRANT\s+ALL\b/i)
    expect(SQL).not.toMatch(/\bTO\s+PUBLIC\b/i)
    expect(SQL).not.toMatch(/GRANT[^;]*\bTO\s+(uellix_app|uellix_writer|uellix_auditor|anon|authenticated|service_role)\b/i)
  })

  it('transfers no ownership', () => {
    // A remediation that moved ownership "for convenience" would be a far
    // larger authority change than the one reviewed, and would do it quietly.
    //
    // Scanned over EXECUTABLE lines only. The header explains the failure by
    // quoting `ALTER SCHEMA uellix_bootstrap OWNER TO uellix_owner` — the
    // statement in stella_hosted_0001 that causes it — and a rule that read
    // prose would refuse the package for describing the problem it solves.
    const executable = SQL.split('\n')
      .filter((l) => !/^\s*--/.test(l))
      .join('\n')

    expect(executable).not.toMatch(/ALTER\s+(TABLE|FUNCTION|SCHEMA)[^;]*OWNER\s+TO/i)
  })

  it('creates no capability role', () => {
    expect(SQL).not.toMatch(/CREATE\s+ROLE\s+uellix_cap_/i)
  })

  it('changes only CREATEROLE on the installer', () => {
    const alters = SQL.match(/^ALTER ROLE[^;]*;/gm) ?? []
    expect(alters).toEqual(['ALTER ROLE uellix_migrator WITH CREATEROLE;'])
    expect(SQL).not.toMatch(/ALTER ROLE[^;]*(SUPERUSER|BYPASSRLS|CREATEDB|REPLICATION)/i)
  })

  it('borrows the schema privilege and gives it back, in that order', () => {
    const borrow = SQL.indexOf('GRANT USAGE, CREATE ON SCHEMA uellix_bootstrap TO postgres;')
    const replace = SQL.indexOf('CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities')
    const giveBack = SQL.indexOf('REVOKE USAGE, CREATE ON SCHEMA uellix_bootstrap FROM postgres;')

    expect(borrow).toBeGreaterThan(-1)
    expect(replace).toBeGreaterThan(borrow)
    expect(giveBack).toBeGreaterThan(replace)
  })

  it('executes nothing dynamically', () => {
    // The cross-cutting invariant of every prepared package: a static contract
    // can read a literal and cannot read a composed string.
    expect(SQL).not.toMatch(/EXECUTE\s+format\(/i)
  })

  it('carries the two certified function bodies verbatim from the bootstrap', () => {
    // Lifted rather than transcribed. If the bootstrap's bodies change and this
    // package is not rebuilt, the two projects diverge silently — a fresh
    // provision would get one contract and a remediated one the other.
    const bootstrap = readFileSync(
      path.join(ROOT, 'db/prepared/stella_hosted_0001_managed_role_bootstrap.sql'),
      'utf8',
    )
    const body = (source: string, head: string): string => {
      const lines = source.split(/\r?\n/)
      const start = lines.findIndex((l) => l.startsWith(head))
      expect(start, `missing ${head}`).toBeGreaterThan(-1)
      const end = lines.findIndex((l, i) => i >= start && l === 'END $$;')
      return lines.slice(start, end + 1).join('\n')
    }

    for (const head of [
      'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_hosted_capabilities(',
      'CREATE OR REPLACE FUNCTION uellix_bootstrap.assert_capability_membership_topology(',
    ]) {
      expect(body(SQL, head), head).toBe(body(bootstrap, head))
    }
  })
})

/* -------------------------------------------------------------------------- */
/* The witness                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE_STATE: RemediationObservation = {
  installerHasCreateRole: false,
  installerCanSetOwner: true,
  installerCanCreateInDatabase: false,
  ownerHoldsE01Grants: false,
  installerHoldsVisibilityGrants: false,
  topologyAssertionPresent: false,
  capabilitiesBodyIsCertified: false,
  bootstrapSchemaAcl: [...EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES],
  capabilityRolesPresent: [],
}

const TARGET_STATE: RemediationObservation = {
  ...SOURCE_STATE,
  installerHasCreateRole: true,
  installerCanCreateInDatabase: true,
  ownerHoldsE01Grants: true,
  installerHoldsVisibilityGrants: true,
  topologyAssertionPresent: true,
  capabilitiesBodyIsCertified: true,
}

describe('the witness classifies by catalog facts, never by "the file was run"', () => {
  it('the measured staging source state is ABSENT', () => {
    // The first version of the witness counted `installerCanSetOwner` among
    // its identifying facts. That fact is TRUE before this package runs —
    // stella_hosted_0001 §2b establishes it — so a pristine staging project
    // classified PARTIAL_OR_INCONSISTENT and the T1 gate refused the very
    // apply it exists to authorise. A witness must be made of facts the
    // package ITSELF produces.
    const classified = classifyRemediation(SOURCE_STATE)
    expect(classified.state).toBe('ABSENT')
    expect(classified.present).toEqual([])
  })

  it('the post-remediation state is INSTALLED', () => {
    expect(classifyRemediation(TARGET_STATE).state).toBe('INSTALLED')
  })

  it('a half-applied state is PARTIAL_OR_INCONSISTENT, never INSTALLED', () => {
    const half = { ...TARGET_STATE, topologyAssertionPresent: false }
    const classified = classifyRemediation(half)
    expect(classified.state).toBe('PARTIAL_OR_INCONSISTENT')
    expect(classified.missing).toContain('the capability topology assertion exists')
  })

  it('a LEAKED borrowed privilege is PARTIAL even when everything else is right', () => {
    // THE RESIDUE THIS PACKAGE IS MEASURED ON. Every target fact holds and the
    // schema is still open to postgres: calling that INSTALLED would ship the
    // one thing the borrow window exists to prevent.
    const leaked = {
      ...TARGET_STATE,
      bootstrapSchemaAcl: [...EXPECTED_BOOTSTRAP_SCHEMA_GRANTEES, 'postgres'],
    }
    const classified = classifyRemediation(leaked)
    expect(classified.state).toBe('PARTIAL_OR_INCONSISTENT')
    expect(classified.problems.join('\n')).toMatch(/unexpected explicit grantee: postgres/)
  })

  it('reads the schema ACL, because has_schema_privilege cannot answer this', () => {
    // pg_read_all_data is granted to postgres WITH INHERIT on every Supabase
    // project and confers USAGE on every schema, so the predicate stays TRUE
    // after the revoke. Measured — and the reason the observation carries an
    // ACL array rather than a boolean.
    const source = readFileSync(path.join(ROOT, 'db/hosted/prechain-remediation.ts'), 'utf8')
    expect(source).toMatch(/pg_read_all_data/)
    expect(source).toMatch(/NOT `has_schema_privilege/)
  })

  it('treats a capability role at PRECHAIN as inconsistent', () => {
    const started = { ...TARGET_STATE, capabilityRolesPresent: ['uellix_cap_grounding'] }
    expect(classifyRemediation(started).state).toBe('PARTIAL_OR_INCONSISTENT')
  })
})

/* -------------------------------------------------------------------------- */
/* The T1 dependency                                                           */
/* -------------------------------------------------------------------------- */

describe('governed T1 is machine-blocked until the remediation is INSTALLED', () => {
  it('refuses T1 while the remediation is ABSENT', () => {
    const result = authorizeGovernedT1(classifyRemediation(SOURCE_STATE), [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('REMEDIATION_ABSENT')
  })

  it('refuses T1 while the remediation is PARTIAL', () => {
    const partial = classifyRemediation({ ...TARGET_STATE, ownerHoldsE01Grants: false })
    const result = authorizeGovernedT1(partial, [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('REMEDIATION_PARTIAL')
  })

  it('refuses T1 when the remediation is INSTALLED but the gate refuses', () => {
    // Reconciled and then drifted. Neither condition substitutes for the other.
    const result = authorizeGovernedT1(classifyRemediation(TARGET_STATE), [
      { code: 'PRECHAIN_PRIVILEGE_MISSING', detail: 'uellix_owner lost REFERENCES on projects' },
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('PRECHAIN_GATE_FAILED')
  })

  it('authorises T1 only when BOTH hold', () => {
    expect(authorizeGovernedT1(classifyRemediation(TARGET_STATE), []).ok).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* The old bootstrap                                                           */
/* -------------------------------------------------------------------------- */

describe('stella_hosted_0001 is first-provision only', () => {
  it('is not the remediation vehicle, and the registry names the replacement', () => {
    expect(PRECHAIN_REMEDIATION.id).not.toMatch(/0001/)
    expect(PRECHAIN_REMEDIATION.sourceFile).toMatch(/stella_hosted_0002/)
  })

  it('records why replaying it cannot work', () => {
    // The measurement, in the package a reader reaches first.
    expect(SQL).toMatch(/must be owner of schema uellix_bootstrap/)
    expect(SQL).toMatch(/SEVENTEEN statements/)
  })

  it('refuses to run against a project the bootstrap has not touched', () => {
    expect(SQL).toMatch(/uellix_bootstrap is absent — apply stella_hosted_0001 first/)
  })
})

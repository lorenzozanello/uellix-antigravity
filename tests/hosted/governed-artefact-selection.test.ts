// tests/hosted/governed-artefact-selection.test.ts
// COMMIT 5.5 — which artefact an operator is told to apply.
//
// ---------------------------------------------------------------------------
// THE INCIDENT THIS FILE EXISTS FOR
// ---------------------------------------------------------------------------
// T1 was planned correctly against staging — remediation INSTALLED, prechain
// gate PASS, attempt consumed — and the write failed:
//
//   grounding_0002_document_versions.hosted.sql:915
//   ERROR:  permission denied for schema uellix_grounding
//
// Nothing about the decision was wrong. The FILE was. The chain is derived
// twice, in one direction:
//
//   db/prepared/*.sql                            canonical, the source of truth
//     -> rewrite-rules.ts                        what managed Supabase cannot run
//   db/prepared/hosted/*.hosted.sql              the MIDDLE artefact
//     -> governed-generator.ts                   who executes each statement
//   db/prepared/hosted/governed/*.governed.sql   what is applied
//
// The middle artefact still carries the canonical `SET ROLE` / `RESET ROLE`
// bookkeeping, which — in the generator's own words — "assumes a superuser
// applying the package, which is the one thing managed Supabase does not have".
// The operator boundary emitted its path.
//
// The tests below pin the two facts that make this a class of defect rather
// than one bad line: the middle artefact carries FIFTY-FOUR statements that
// would run as the installer inside a schema it does not own, and the governed
// artefact carries none.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  FIRST_PROVISION_BOOTSTRAP,
  GOVERNED_APPLY_DIRECTORY,
  GovernedArtefactRefusal,
  resolveGovernedApplyTarget,
  resolveOperationalApplyTarget,
  verifyArtefactDigest,
} from '@/db/hosted/governed-artefact'
import { CHAIN_PACKAGE_FILES } from '@/db/hosted/authority/window-plan'
import { CHAIN_WRITE_ORDER } from '@/db/hosted/fresh-observation'

const ROOT = process.cwd()

/* -------------------------------------------------------------------------- */
/* The resolver                                                                */
/* -------------------------------------------------------------------------- */

describe('the operational resolver names the governed artefact', () => {
  it('maps every chain package to a pinned governed file', () => {
    for (const packageName of CHAIN_WRITE_ORDER) {
      const target = resolveGovernedApplyTarget(packageName, ROOT)
      expect(target.packageName).toBe(packageName)
      expect(target.relativePath).toBe(
        `${GOVERNED_APPLY_DIRECTORY}/${packageName}.governed.sql`,
      )
      expect(target.digest).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('uses the chain plan for the T-number rather than a second list', () => {
    expect(resolveGovernedApplyTarget(CHAIN_WRITE_ORDER[0] as string, ROOT).packageId).toBe('T1')
    const last = CHAIN_WRITE_ORDER[CHAIN_WRITE_ORDER.length - 1] as string
    expect(resolveGovernedApplyTarget(last, ROOT).packageId).toBe(
      CHAIN_PACKAGE_FILES[CHAIN_PACKAGE_FILES.length - 1]?.packageId,
    )
  })

  it('refuses a package that is not in the governed chain', () => {
    expect(() => resolveGovernedApplyTarget('stella_hosted_0002_prechain_authority_reconciliation', ROOT))
      .toThrow(GovernedArtefactRefusal)
    expect(() => resolveGovernedApplyTarget('not_a_package', ROOT)).toThrow(GovernedArtefactRefusal)
  })

  it('refuses bytes that no longer match the pin', () => {
    expect(() =>
      resolveGovernedApplyTarget(CHAIN_WRITE_ORDER[0] as string, ROOT, () => '-- edited\n'),
    ).toThrow(/CERT_DIGEST_MISMATCH/)
  })

  it('refuses to resolve outside the governed directory', () => {
    expect(GOVERNED_APPLY_DIRECTORY).toBe('db/prepared/hosted/governed')
  })
})

/* -------------------------------------------------------------------------- */
/* The bootstrap exception, bound to an identity (MEDIUM-1)                    */
/* -------------------------------------------------------------------------- */

describe('exactly one package may be applied from the middle artefact', () => {
  it('permits the first-provision bootstrap, by literal name', () => {
    const target = resolveOperationalApplyTarget(FIRST_PROVISION_BOOTSTRAP, ROOT)
    expect(target.kind).toBe('first-provision-bootstrap')
    expect(target.relativePath).toBe(
      `db/prepared/hosted/${FIRST_PROVISION_BOOTSTRAP}.hosted.sql`,
    )
  })

  it('resolves every chain package to the governed directory', () => {
    for (const packageName of CHAIN_WRITE_ORDER) {
      const target = resolveOperationalApplyTarget(packageName, ROOT)
      expect(target.kind, packageName).toBe('governed')
      expect(target.relativePath, packageName).toMatch(
        /^db\/prepared\/hosted\/governed\/.+\.governed\.sql$/,
      )
      expect(target.relativePath, packageName).not.toContain('.hosted.sql')
    }
  })

  it('refuses a package nobody registered', () => {
    expect(() => resolveOperationalApplyTarget('not_a_package', ROOT)).toThrow(
      GovernedArtefactRefusal,
    )
  })

  it('refuses a name that merely resembles the bootstrap', () => {
    // The exception is an identity, not a prefix, a pattern or a category. A
    // package called `..._bootstrap_v2` is a different package.
    for (const near of [
      `${FIRST_PROVISION_BOOTSTRAP}_v2`,
      `${FIRST_PROVISION_BOOTSTRAP} `,
      'stella_hosted_0002_prechain_authority_reconciliation',
      'STELLA_HOSTED_0001_MANAGED_ROLE_BOOTSTRAP',
    ]) {
      expect(() => resolveOperationalApplyTarget(near, ROOT), near).toThrow(
        GovernedArtefactRefusal,
      )
    }
  })

  it('refuses a future chain package that has no governed artefact yet', () => {
    // The failure mode this closes: a tenth package is added to the chain, the
    // governed artefact is not generated with it, and the resolver quietly
    // serves the middle file because the package "is not governed".
    expect(() => resolveOperationalApplyTarget('grounding_0005_not_generated_yet', ROOT)).toThrow(
      /HOSTED_PACKAGE_NOT_GOVERNED/,
    )
  })

  it('never falls back to the middle artefact when governed resolution fails', () => {
    // Every way the governed side can fail, for a REAL chain package. None of
    // them may produce a target at all, let alone an ungoverned one.
    const t1 = CHAIN_WRITE_ORDER[0] as string
    const unreadable = () => {
      throw new Error('ENOENT')
    }
    expect(() => resolveOperationalApplyTarget(t1, ROOT, unreadable)).toThrow(
      /CERT_ARTEFACT_UNREADABLE/,
    )
    expect(() => resolveOperationalApplyTarget(t1, ROOT, () => '-- moved\n')).toThrow(
      /CERT_DIGEST_MISMATCH/,
    )
  })

  it('names the exception once, and it is the bootstrap', () => {
    expect(FIRST_PROVISION_BOOTSTRAP).toBe('stella_hosted_0001_managed_role_bootstrap')
    expect(CHAIN_WRITE_ORDER).not.toContain(FIRST_PROVISION_BOOTSTRAP)
  })
})

/* -------------------------------------------------------------------------- */
/* The class of defect, measured                                               */
/* -------------------------------------------------------------------------- */

/** Schemas the chain creates AUTHORIZATION uellix_owner. */
const OWNER_HELD_SCHEMAS = ['uellix_grounding', 'uellix_stella', 'uellix_stella_ops']
const INSTALLER = 'uellix_migrator'

/**
 * Statements that would execute as the installer inside a schema it does not
 * own — the exact shape of the staging failure.
 *
 * Tracks `SET ROLE` / `RESET ROLE` the way psql does: RESET returns to the
 * login role, which for a managed apply is the installer.
 */
function installerContextDdlInOwnerSchemas(sql: string): string[] {
  const out: string[] = []
  let role = INSTALLER
  sql.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    const set = /^SET ROLE\s+([A-Za-z0-9_]+)\s*;/.exec(line)
    if (set) {
      role = set[1] as string
      return
    }
    if (/^RESET ROLE\s*;/.test(line)) {
      role = INSTALLER
      return
    }
    const ddl =
      /^(CREATE (?:OR REPLACE )?(?:FUNCTION|VIEW|TABLE|MATERIALIZED VIEW|INDEX|TRIGGER)|ALTER (?:FUNCTION|TABLE|VIEW))\s+([^\s(]+)/i.exec(
        line,
      )
    if (ddl === null) return
    const target = (ddl[2] as string).replace(/"/g, '')
    const schema = target.includes('.') ? (target.split('.')[0] as string) : 'public'
    if (OWNER_HELD_SCHEMAS.includes(schema) && role === INSTALLER) {
      out.push(`${line.slice(0, 80)} (line ${i + 1})`)
    }
  })
  return out
}

describe('the two derived families differ by exactly this defect class', () => {
  it('the governed artefacts execute no owner-schema DDL as the installer', () => {
    for (const packageName of CHAIN_WRITE_ORDER) {
      const sql = readFileSync(
        path.join(ROOT, `${GOVERNED_APPLY_DIRECTORY}/${packageName}.governed.sql`),
        'utf8',
      )
      expect(installerContextDdlInOwnerSchemas(sql), packageName).toEqual([])
    }
  })

  it('the middle artefacts carry the defect in every package — so the check is not vacuous', () => {
    // If this ever reaches zero the detector has stopped detecting, not the
    // middle artefact become safe: `.hosted.sql` is a derivation INPUT and is
    // never meant to be applied to a managed project.
    let total = 0
    for (const packageName of CHAIN_WRITE_ORDER) {
      const sql = readFileSync(
        path.join(ROOT, `db/prepared/hosted/${packageName}.hosted.sql`),
        'utf8',
      )
      const hits = installerContextDdlInOwnerSchemas(sql)
      expect(hits.length, packageName).toBeGreaterThan(0)
      total += hits.length
    }
    expect(total).toBe(54)
  })

  it('T1 fails first at the statement staging failed at', () => {
    const sql = readFileSync(
      path.join(ROOT, `db/prepared/hosted/${CHAIN_WRITE_ORDER[0]}.hosted.sql`),
      'utf8',
    )
    expect(installerContextDdlInOwnerSchemas(sql)[0]).toContain(
      'CREATE OR REPLACE FUNCTION uellix_grounding.register_document_version',
    )
  })
})

/* -------------------------------------------------------------------------- */
/* The plan -> execution binding (HARDENING-1)                                 */
/* -------------------------------------------------------------------------- */

describe('the authorised bytes are re-checked immediately before psql', () => {
  const T1 = CHAIN_WRITE_ORDER[0] as string
  const authorised = resolveGovernedApplyTarget(T1, ROOT)
  const onDisk = readFileSync(path.join(ROOT, authorised.relativePath), 'utf8')

  it('passes when the file is still the file the plan authorised', () => {
    const verdict = verifyArtefactDigest({
      relativePath: authorised.relativePath,
      expectedDigest: authorised.digest,
      readFile: () => onDisk,
    })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) throw new Error(verdict.detail)
    expect(verdict.digest).toBe(authorised.digest)
  })

  it('is insensitive to the checkout line endings, as the pin is', () => {
    const verdict = verifyArtefactDigest({
      relativePath: authorised.relativePath,
      expectedDigest: authorised.digest,
      readFile: () => onDisk.replace(/\n/g, '\r\n'),
    })
    expect(verdict.ok).toBe(true)
  })

  it('fails closed when the file changed between plan and execution', () => {
    const verdict = verifyArtefactDigest({
      relativePath: authorised.relativePath,
      expectedDigest: authorised.digest,
      readFile: () => `${onDisk}\n-- one more line\n`,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('edited bytes verified clean')
    expect(verdict.code).toBe('ARTEFACT_DIGEST_MISMATCH')
  })

  it('fails closed when the file cannot be read', () => {
    const verdict = verifyArtefactDigest({
      relativePath: authorised.relativePath,
      expectedDigest: authorised.digest,
      readFile: () => {
        throw new Error('ENOENT')
      },
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error('unreachable')
    expect(verdict.code).toBe('ARTEFACT_UNREADABLE')
  })

  it('refuses a digest that is not a digest rather than comparing loosely', () => {
    for (const bad of [authorised.digest.slice(0, 32), authorised.digest.toUpperCase(), '', 'PASS']) {
      const verdict = verifyArtefactDigest({
        relativePath: authorised.relativePath,
        expectedDigest: bad,
        readFile: () => onDisk,
      })
      expect(verdict.ok, bad).toBe(false)
      if (verdict.ok) throw new Error('unreachable')
      expect(verdict.code, bad).toBe('ARTEFACT_DIGEST_MALFORMED')
    }
  })

  it('cannot re-derive the expectation it is checking against', () => {
    // The digest comes from the CALLER — the plan. A verifier that resolved the
    // pin itself would agree with itself: it would report PASS for a governed
    // file that had been regenerated after the plan was issued, which is one of
    // the exact situations this exists to catch.
    const otherPackage = resolveGovernedApplyTarget(CHAIN_WRITE_ORDER[1] as string, ROOT)
    const verdict = verifyArtefactDigest({
      relativePath: authorised.relativePath,
      expectedDigest: otherPackage.digest,
      readFile: () => onDisk,
    })
    expect(verdict.ok).toBe(false)
  })

  it('returns bytes and nothing that resembles an authorisation', () => {
    const verdict = verifyArtefactDigest({
      relativePath: authorised.relativePath,
      expectedDigest: authorised.digest,
      readFile: () => onDisk,
    })
    expect(Object.keys(verdict).sort()).toEqual(['digest', 'ok', 'relativePath'])
    expect(JSON.stringify(verdict)).not.toMatch(/psql|AUTHORIS|AUTHORIZ|attempt|CONSUMED/i)
  })

  it('the operator helper connects to nothing and writes no ledger', () => {
    const shell = readFileSync(path.join(ROOT, 'scripts/verify-artefact-digest.ts'), 'utf8')
    expect(shell).toContain('verifyArtefactDigest')
    expect(shell).not.toMatch(/child_process/)
    expect(shell).not.toMatch(/process\.env/)
    expect(shell).not.toMatch(/from 'pg'/)
    expect(shell).not.toMatch(/appendFileSync|writeFileSync/)
    expect(shell).not.toMatch(/ATTEMPT_LEDGER|planChainWriteForOperator|planRemediationWrite/)
    // It must not be able to say "and therefore apply it".
    expect(shell).not.toMatch(/AUTHORISED|AUTHORIZED/)
  })
})

/* -------------------------------------------------------------------------- */
/* No operator surface may name the middle artefact                            */
/* -------------------------------------------------------------------------- */

describe('no operator surface hands out the ungoverned artefact', () => {
  const chainOnlySurfaces = ['db/hosted/chain-operator.ts', 'scripts/chain-attempt.ts']

  it('the chain operator boundary formats no db/prepared/hosted path at all', () => {
    // These two only ever handle T1..T9, so there is no legitimate reason for
    // either to name the middle directory — the resolver does that, fenced.
    for (const rel of chainOnlySurfaces) {
      const src = readFileSync(path.join(ROOT, rel), 'utf8')
      const offending = src
        .split('\n')
        .map((l, i) => ({ l: l.trim(), i: i + 1 }))
        .filter(({ l }) => !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('--'))
        .filter(({ l }) => /db\/prepared\/hosted\/(\$\{|[a-z_0-9]+\.hosted\.sql)/.test(l))
      expect(offending.map((o) => `${rel}:${o.i} ${o.l}`), rel).toEqual([])
    }
  })

  // The provisioning runner's own steps are asserted behaviourally in
  // tests/hosted/hosted-provisioning-runner.test.ts, where the phase fixtures
  // already exist. A third copy of them here would be a third thing to keep
  // in step with the runner.
})

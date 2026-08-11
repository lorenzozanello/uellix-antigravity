// tests/hosted/authority/chain-posture-evidence.test.ts
// F-PI-01 — the JUDGE of a remote posture measurement, exercised against
// measurements that are deliberately wrong.
//
// ---------------------------------------------------------------------------
// WHERE THE PASSING FIXTURE COMES FROM, AND WHY IT IS NOT HAND-WRITTEN
// ---------------------------------------------------------------------------
// `artifacts/remediation-certification/latest.json` carries `finalPosture`: the
// posture PostgreSQL 17.6 actually held after the nine governed packages
// committed, recorded by a run whose verdict was COMPLETE. Using it means the
// PASS case is a real measurement rather than the test author's idea of one — a
// judge that has only ever seen a fixture built to satisfy it is a judge nobody
// has tested.
//
// It also settles a question the design could otherwise only assert. The
// engine's eleven membership rows are, row for row, the EIGHT the staging
// prechain observation measured plus the THREE the chain is expected to add.
// The lab and the managed project agree on the prechain topology, including
// grantors, so the certified posture can be judged directly against the staging
// baseline. Nothing is synthesised to make the delta line up.
//
// ---------------------------------------------------------------------------
// AND THE ONE ROW THAT MAKES A NAIVE CHECK WRONG
// ---------------------------------------------------------------------------
// `uellix_owner<-uellix_migrator (set=true)` is in BOTH. It is a prechain fact
// and a prerequisite of the owner window, and any residual gate phrased as "no
// SET memberships" or "membership_count = 0" fails a perfect run on it. The
// eighth case below exists to pin that.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  POSTURE_ATTEMPT_KIND,
  POSTURE_ATTEMPT_LEDGER,
  PRECHAIN_TOPOLOGY_EVIDENCE,
  PostureEvidenceRefusal,
  assertPostureProbeIsReadOnly,
  buildChainPostureProbeSql,
  computePostureStatus,
  deriveTemporaryCapabilityCreateGrants,
  deriveTemporaryCapabilityMemberships,
  evaluateTemporaryCreateResidual,
  evaluateTemporaryMembershipResidual,
  parseChainPostureEvidence,
  parsePostureAttemptLedger,
  postureAttemptLine,
  resolvePrechainTopologyEvidence,
  serializePostureStatus,
  verifyPostureStatus,
} from '@/db/hosted/authority/certification/chain-posture-evidence'
import {
  CHAIN_POSTURE_SCHEMA,
  EXPECTED_CHAIN_MEMBERSHIP_DELTA,
  buildChainPostureSql,
  type ChainPosture,
} from '@/db/hosted/authority/certification/chain-postconditions'
import { prechainObservationSql } from '@/db/hosted/authority/certification/engine-probes'
import { CAPABILITY_ROLES, HOSTED_INSTALLER } from '@/db/hosted/authority/certification/prechain-authority-gate'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (rel: string): string | null => {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const ATTEMPT = 'att_00112233445566778899aabbccddeeff'
const OTHER_ATTEMPT = 'att_ffeeddccbbaa99887766554433221100'
const AT = '2026-08-11T18:00:00.000Z'

const openLedger = (attemptId = ATTEMPT): string =>
  postureAttemptLine('OPENED', attemptId, KNOWN_STAGING_PROJECT_REF, AT)

/** The certified engine posture, with the attempt echo the probe injects. */
function certifiedPosture(): Record<string, unknown> {
  const raw = read('artifacts/remediation-certification/latest.json')
  expect(raw, 'the remediation certification artefact must be present').not.toBeNull()
  const report = JSON.parse(raw as string) as { verdict: string; finalPosture: ChainPosture }
  expect(report.verdict).toBe('COMPLETE')
  return { ...(report.finalPosture as unknown as Record<string, unknown>), attemptId: ATTEMPT }
}

const document = (posture: Record<string, unknown>): string => JSON.stringify(posture)

/** The status the operator route computes, over a document and the real baseline. */
const statusOf = (raw: string | null, attemptId = ATTEMPT, ledger: string | null = openLedger()) =>
  computePostureStatus({
    expectedAttemptId: attemptId,
    raw,
    attemptLedger: ledger,
    readArtefact: read,
    root: ROOT,
  })

describe('F-PI-01 — the declared prechain baseline', () => {
  it('resolves to a versioned evidence file that exists and describes staging', () => {
    const resolved = resolvePrechainTopologyEvidence()
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    expect(resolved.entry.projectRef).toBe(KNOWN_STAGING_PROJECT_REF)
    expect(KNOWN_PRODUCTION_IDENTIFIERS.projectRefs).not.toContain(resolved.entry.projectRef)
    // Under docs/, not under artifacts/. The whole point of R-H1 is that a
    // working copy is rewritten by the next attempt that runs the same tool.
    expect(resolved.entry.path.startsWith('docs/ops/staging/evidence/')).toBe(true)
    expect(read(resolved.entry.path)).not.toBeNull()
  })

  it('refuses a production ref before it refuses a wrong target', () => {
    const productionRef = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0] as string
    const first = PRECHAIN_TOPOLOGY_EVIDENCE[0]
    expect(first).toBeDefined()
    const poisoned = [{ ...(first as (typeof PRECHAIN_TOPOLOGY_EVIDENCE)[number]), projectRef: productionRef }]
    const resolved = resolvePrechainTopologyEvidence(KNOWN_STAGING_PROJECT_REF, poisoned)
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('POSTURE_BASELINE_PRODUCTION_REF')
  })

  it('refuses an empty ledger rather than treating unmeasured as zero', () => {
    const resolved = resolvePrechainTopologyEvidence(KNOWN_STAGING_PROJECT_REF, [])
    expect(resolved.ok).toBe(false)
    if (resolved.ok) return
    expect(resolved.code).toBe('POSTURE_BASELINE_EMPTY')
  })

  it('measures the same membership set as the posture probe, byte for byte', () => {
    // THE ASSUMPTION THE WHOLE BASELINE RESTS ON, ASSERTED. The prechain
    // observation is usable as a posture baseline only because the two probes
    // scope `pg_auth_members` identically. If either predicate moves, this
    // fails here rather than silently producing a delta against a different set.
    const membershipPredicate = (sql: string): string => {
      const at = sql.indexOf('pg_auth_members')
      expect(at, 'the probe must read pg_auth_members').toBeGreaterThan(-1)
      const line = sql
        .slice(at)
        .split('\n')
        .find((l) => l.includes('WHERE') && l.includes('rolname'))
      expect(line, 'the membership scope must be a WHERE on rolname').toBeDefined()
      return (line as string).trim()
    }
    const posture = buildChainPostureSql(
      [{ packageId: 'X', statementIndex: 1, object: 'public.t', objectClass: 'table', expectedFinalOwner: 'uellix_owner' }],
      [],
    )
    const prechain = prechainObservationSql([
      { object: 'public.organizations', objectType: 'table', privileges: ['SELECT'] },
    ])
    expect(membershipPredicate(posture)).toBe(membershipPredicate(prechain))
  })
})

describe('F-PI-01 — expectations derived from the authority plan', () => {
  it('derives the temporary CREATE pairs, one per capability schema', () => {
    const pairs = deriveTemporaryCapabilityCreateGrants()
    expect(pairs).toEqual([
      'uellix_grounding -> uellix_cap_grounding',
      'uellix_stella -> uellix_cap_stella_quota',
      'uellix_stella_ops -> uellix_cap_stella_ticket',
    ])
    // Not a literal anywhere: every grantee is a declared capability role.
    for (const pair of pairs) expect(CAPABILITY_ROLES).toContain(pair.split(' -> ')[1])
  })

  it('derives the temporary capability memberships and EXCLUDES uellix_owner', () => {
    const roles = deriveTemporaryCapabilityMemberships()
    expect([...roles].sort()).toEqual([...CAPABILITY_ROLES].sort())
    // The chain does temporarily assume uellix_owner. Its membership is a
    // PRECHAIN row that must survive T9, so it is not a residual.
    expect(roles).not.toContain('uellix_owner')
  })
})

describe('F-PI-01 — case 9: the generator emits SELECT-only SQL', () => {
  const sql = buildChainPostureProbeSql(ATTEMPT, ROOT)

  it('is exactly one search_path SET and one SELECT', () => {
    expect(() => assertPostureProbeIsReadOnly(sql)).not.toThrow()
    const statements = sql
      .replace(/'(?:[^']|'')*'/g, "''")
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^SET\s+search_path\b/i)
    expect(statements[1]).toMatch(/^SELECT\b/i)
  })

  it('contains no mutating statement outside a string literal', () => {
    const unquoted = sql.replace(/'(?:[^']|'')*'/g, "''")
    for (const keyword of ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'GRANT', 'REVOKE', 'TRUNCATE', 'DO', 'CALL']) {
      expect(new RegExp(`\\b${keyword}\\b`, 'i').test(unquoted), `${keyword} must not appear`).toBe(false)
    }
    // And the privilege NAME 'CREATE' is still measured — the check above is a
    // statement check, not a substring ban that would forbid the measurement.
    expect(sql).toContain("a.privilege_type = 'CREATE'")
  })

  it('refuses to emit a probe that grew a mutating statement', () => {
    expect(() => assertPostureProbeIsReadOnly(`${sql}\nDROP TABLE public.x;`)).toThrow(PostureEvidenceRefusal)
  })

  it('compiles the attempt in exactly once and refuses a malformed id', () => {
    expect(sql).toContain(`'attemptId', '${ATTEMPT}'`)
    expect(sql.split(ATTEMPT).length - 1).toBe(1)
    expect(() => buildChainPostureProbeSql("att_'; DROP TABLE x; --", ROOT)).toThrow(PostureEvidenceRefusal)
    expect(() => buildChainPostureProbeSql('att_short', ROOT)).toThrow(PostureEvidenceRefusal)
  })

  it('leaves the certified posture body untouched', () => {
    const base = buildChainPostureSql(
      // The real derivation is exercised through the probe; here it is enough
      // that the injection is additive.
      [{ packageId: 'X', statementIndex: 1, object: 'public.t', objectClass: 'table', expectedFinalOwner: 'uellix_owner' }],
      [],
    )
    expect(base).toContain(`'schema', '${CHAIN_POSTURE_SCHEMA}'`)
    expect(sql).toContain(`'schema', '${CHAIN_POSTURE_SCHEMA}'`)
  })
})

describe('F-PI-01 — case 10: the tooling connects to nothing', () => {
  const FILES = [
    'db/hosted/authority/certification/chain-posture-evidence.ts',
    'scripts/posture-observation-sql.ts',
    'scripts/posture-status.ts',
  ]
  // Every one of these would be a way to reach a database, name a target, or
  // run something. The hosted tools declare CONNECTS TO NOTHING and this is what
  // makes the declaration checkable.
  const FORBIDDEN = [
    'child_process',
    'execFileSync',
    'execSync',
    'spawnSync',
    'node:net',
    'node:tls',
    'node:http',
    'node:https',
    'process.env',
    'DATABASE_URL',
    'postgres://',
    'postgresql://',
    'fetch(',
    "from 'pg'",
    'require(\'pg\')',
  ]

  for (const file of FILES) {
    it(`${file} imports nothing that can reach a database`, () => {
      const source = read(file)
      expect(source, `${file} must exist`).not.toBeNull()
      for (const token of FORBIDDEN) {
        expect((source as string).includes(token), `${file} must not contain ${token}`).toBe(false)
      }
    })
  }
})

describe('F-PI-01 — the attempt ledger', () => {
  it('accepts only records declaring the posture kind', () => {
    const mixed =
      openLedger() +
      `${JSON.stringify({ attemptId: OTHER_ATTEMPT, event: 'OPENED', targetProjectRef: KNOWN_STAGING_PROJECT_REF, at: AT })}\n` +
      `${JSON.stringify({ attemptId: OTHER_ATTEMPT, event: 'OPENED', targetProjectRef: KNOWN_STAGING_PROJECT_REF, at: AT, kind: 'hosted-chain' })}\n`
    const parsed = parsePostureAttemptLedger(mixed)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.attemptId).toBe(ATTEMPT)
    expect(parsed[0]?.kind).toBe(POSTURE_ATTEMPT_KIND)
  })

  it('refuses a status for an attempt that was never opened', () => {
    const status = statusOf(document(certifiedPosture()), ATTEMPT, null)
    expect(status.postureVerified).toBe(false)
    expect(status.refusal?.code).toBe('POSTURE_ATTEMPT_NOT_OPEN')
  })

  it('refuses a status for an attempt a later one retired', () => {
    const status = statusOf(document(certifiedPosture()), ATTEMPT, openLedger() + openLedger(OTHER_ATTEMPT))
    expect(status.postureVerified).toBe(false)
    expect(status.refusal?.code).toBe('POSTURE_ATTEMPT_NOT_OPEN')
  })
})

describe('F-PI-01 — the verdict', () => {
  it('case 1: the certified posture PASSES every gate', () => {
    const status = statusOf(document(certifiedPosture()))
    expect(status.refusal).toBeNull()
    expect(status.blockers).toEqual([])
    expect(status.verdicts.TEMP_MEMBERSHIPS).toBe('ZERO')
    expect(status.verdicts.TEMP_CREATE_GRANTS).toBe('ZERO')
    expect(status.verdicts.PERSISTENT_ROLE_TOPOLOGY_REMOTE).toBe('EXPECTED')
    expect(status.verdicts.SD_GATE_REMOTE).toBe('PASS')
    expect(status.verdicts.RLS_POLICY_ENGINE_REMOTE).toBe('PASS')
    expect(status.verdicts.OWNER_TRANSFERS_REMOTE).toMatch(/^\d+_OF_\d+_CORRECT$/)
    expect(status.verdicts.CANONICAL_OWNER_CONTEXT_REMOTE).toMatch(/^\d+_OF_\d+_CORRECT$/)
    expect(status.postureVerified).toBe(true)
  })

  it('case 8: the legitimate baseline memberships do NOT read as leakage', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    // The row a naive check gets wrong, present in the measurement that passes.
    const ownerWindow = posture.memberships.find(
      (m) => m.role === 'uellix_owner' && m.member === HOSTED_INSTALLER && m.setOption,
    )
    expect(ownerWindow, 'the owner-window membership must be present in the passing fixture').toBeDefined()

    const residual = evaluateTemporaryMembershipResidual(posture)
    expect(residual.pass).toBe(true)
    expect(residual.residual).toEqual([])

    // And the delta against the real staging prechain is EXACTLY the three
    // capability rows the plan declares — not "no memberships".
    const status = statusOf(document(certifiedPosture()))
    const topology = (status.measurements as Record<string, { added: string[] }>).persistentRoleTopology
    expect([...topology.added].sort()).toEqual([...EXPECTED_CHAIN_MEMBERSHIP_DELTA].sort())
    expect(posture.memberships.length).toBeGreaterThan(EXPECTED_CHAIN_MEMBERSHIP_DELTA.length)
  })

  it('case 2: one temporary membership leak FAILS', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const leaked = {
      ...posture,
      attemptId: ATTEMPT,
      memberships: [
        ...posture.memberships,
        {
          role: 'uellix_cap_grounding',
          member: HOSTED_INSTALLER,
          grantor: 'postgres',
          adminOption: false,
          inheritOption: false,
          setOption: true,
        },
      ],
      capabilityReachableBy: { ...posture.capabilityReachableBy, uellix_cap_grounding: [HOSTED_INSTALLER] },
    }
    const status = statusOf(document(leaked as unknown as Record<string, unknown>))
    expect(status.verdicts.TEMP_MEMBERSHIPS).toBe('NONZERO')
    expect(status.verdicts.PERSISTENT_ROLE_TOPOLOGY_REMOTE).toBe('DRIFTED')
    expect(status.postureVerified).toBe(false)
    expect(status.blockers.some((b) => b.startsWith('TEMP_MEMBERSHIPS:'))).toBe(true)
  })

  it('case 2b: an UNMEASURED capability role is not a clean one', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const rest = Object.fromEntries(
      Object.entries(posture.capabilityReachableBy).filter(([role]) => role !== 'uellix_cap_grounding'),
    )
    const residual = evaluateTemporaryMembershipResidual({ ...posture, capabilityReachableBy: rest })
    expect(residual.pass).toBe(false)
    expect(residual.unmeasured).toEqual(['uellix_cap_grounding'])
  })

  it('case 3: one temporary CREATE leak FAILS', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const leaked = {
      ...posture,
      attemptId: ATTEMPT,
      schemaCreateGrants: [
        ...posture.schemaCreateGrants,
        { schema: 'uellix_grounding', owner: 'uellix_owner', grantee: 'uellix_cap_grounding' },
      ],
    }
    expect(evaluateTemporaryCreateResidual(leaked as unknown as ChainPosture).residual).toEqual([
      'uellix_grounding -> uellix_cap_grounding',
    ])
    const status = statusOf(document(leaked as unknown as Record<string, unknown>))
    expect(status.verdicts.TEMP_CREATE_GRANTS).toBe('NONZERO')
    expect(status.postureVerified).toBe(false)
  })

  it('case 3b: a legitimate non-owner CREATE grant is NOT a leak', () => {
    // `public -> uellix_owner` is in the certified posture and is exactly the
    // shape a naive absolute check would flag: a grantee that is not the owner.
    const posture = certifiedPosture() as unknown as ChainPosture
    const legitimate = posture.schemaCreateGrants.filter((g) => g.grantee !== g.owner)
    expect(legitimate.length).toBeGreaterThan(0)
    expect(evaluateTemporaryCreateResidual(posture).pass).toBe(true)
  })

  it('case 4: a malformed observation FAILS closed', () => {
    for (const raw of [null, '', 'not json', '[]', '{}', JSON.stringify({ attemptId: ATTEMPT, schema: 'other/1' })]) {
      const status = statusOf(raw)
      expect(status.postureVerified, `raw=${JSON.stringify(raw)}`).toBe(false)
      expect(status.refusal, `raw=${JSON.stringify(raw)}`).not.toBeNull()
      expect(status.verdicts.REMOTE_CHAIN_POSTURE).toBe('PENDING_OPERATOR_EVIDENCE')
    }
  })

  it('case 4b: a posture missing a required array FAILS closed', () => {
    const posture = certifiedPosture()
    delete (posture as Record<string, unknown>).memberships
    const status = statusOf(document(posture))
    expect(status.postureVerified).toBe(false)
    expect(status.refusal?.code).toBe('POSTURE_MALFORMED')
  })

  it('case 5: a document bound to another attempt FAILS', () => {
    const posture = { ...certifiedPosture(), attemptId: OTHER_ATTEMPT }
    expect(() => parseChainPostureEvidence(document(posture), ATTEMPT)).toThrow(PostureEvidenceRefusal)
    const status = statusOf(document(posture))
    expect(status.refusal?.code).toBe('POSTURE_EVIDENCE_ATTEMPT_MISMATCH')
    expect(status.postureVerified).toBe(false)
  })

  it('case 5b: a document with no attempt echo at all FAILS', () => {
    const posture = certifiedPosture()
    delete (posture as Record<string, unknown>).attemptId
    const status = statusOf(document(posture))
    expect(status.refusal?.code).toBe('POSTURE_EVIDENCE_ATTEMPT_MISMATCH')
  })

  it('case 6: an ownership mismatch FAILS', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const owners = { ...posture.transferredOwners }
    const [first] = Object.keys(owners)
    expect(first, 'the certified posture must carry transferred owners').toBeDefined()
    owners[first as string] = HOSTED_INSTALLER
    const status = statusOf(document({ ...posture, attemptId: ATTEMPT, transferredOwners: owners } as unknown as Record<string, unknown>))
    expect(status.verdicts.OWNER_TRANSFERS_REMOTE).toBe('INCOMPLETE')
    expect(status.postureVerified).toBe(false)
    expect(status.blockers.some((b) => b.startsWith('OWNER_TRANSFERS_REMOTE:'))).toBe(true)
  })

  it('case 6b: a canonical owner context mismatch FAILS', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const contexts = { ...posture.canonicalContextOwners }
    const [first] = Object.keys(contexts)
    expect(first).toBeDefined()
    contexts[first as string] = HOSTED_INSTALLER
    const status = statusOf(document({ ...posture, attemptId: ATTEMPT, canonicalContextOwners: contexts } as unknown as Record<string, unknown>))
    expect(status.verdicts.CANONICAL_OWNER_CONTEXT_REMOTE).toBe('INCOMPLETE')
    expect(status.postureVerified).toBe(false)
  })

  it('case 7: a SECURITY DEFINER / search_path regression FAILS', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const target = posture.functions.find((f) => f.securityDefiner && f.schema === 'uellix_stella')
    expect(target, 'the certified posture must carry an in-scope definer').toBeDefined()
    const regressed = posture.functions.map((f) =>
      f === target ? { ...f, proconfig: ['search_path=public'] } : f,
    )
    const status = statusOf(document({ ...posture, attemptId: ATTEMPT, functions: regressed } as unknown as Record<string, unknown>))
    expect(status.verdicts.SD_GATE_REMOTE).toBe('FAIL')
    expect(status.postureVerified).toBe(false)
    expect(status.blockers.some((b) => b.startsWith('SD_GATE_REMOTE:'))).toBe(true)
  })

  it('case 7b: a definer granting EXECUTE to PUBLIC FAILS wherever it lives', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const target = posture.functions.find((f) => f.securityDefiner)
    expect(target).toBeDefined()
    const regressed = posture.functions.map((f) =>
      f === target ? { ...f, executeGrantees: [...f.executeGrantees, 'PUBLIC'] } : f,
    )
    const status = statusOf(document({ ...posture, attemptId: ATTEMPT, functions: regressed } as unknown as Record<string, unknown>))
    expect(status.verdicts.SD_GATE_REMOTE).toBe('FAIL')
  })

  it('case 7c: a policy on a relation with row security DISABLED FAILS', () => {
    const posture = certifiedPosture() as unknown as ChainPosture
    const policy = posture.policies[0]
    expect(policy).toBeDefined()
    const relations = posture.relations.map((r) =>
      r.relation === policy?.relation ? { ...r, rlsEnabled: false } : r,
    )
    const status = statusOf(document({ ...posture, attemptId: ATTEMPT, relations } as unknown as Record<string, unknown>))
    expect(status.verdicts.RLS_POLICY_ENGINE_REMOTE).toBe('FAIL')
  })
})

describe('F-PI-01 — the status artefact', () => {
  it('round-trips and detects an edit', () => {
    const status = statusOf(document(certifiedPosture()))
    const serialized = serializePostureStatus(status)
    expect(verifyPostureStatus(serialized, serialized).ok).toBe(true)
    expect(verifyPostureStatus(null, serialized)).toMatchObject({ ok: true, present: false })
    const edited = serialized.replace('"postureVerified": true', '"postureVerified": false')
    expect(verifyPostureStatus(edited, serialized).ok).toBe(false)
  })

  it('names the ledger it derives freshness from and never the chain ledger', () => {
    expect(POSTURE_ATTEMPT_LEDGER).toBe('artifacts/hosted-chain-posture-attempts.jsonl')
    expect(POSTURE_ATTEMPT_LEDGER).not.toBe('artifacts/hosted-chain-attempts.jsonl')
    const script = read('scripts/posture-status.ts')
    expect((script as string).includes('hosted-chain-attempts.jsonl')).toBe(false)
  })

  it('the probe is ignored, the ledger and the status are not', () => {
    // H-1's rule, made executable for this emitter. An attempt-bound *.sql on
    // disk is a probe someone can re-run tomorrow against a spent attempt; a
    // DERIVED status is a verdict a document quotes and `:verify` recomputes,
    // and ignoring it would leave `:verify` with nothing to compare against.
    const gitignore = read('.gitignore')
    expect(gitignore).not.toBeNull()
    const lines = (gitignore as string).split(/\r?\n/).map((l) => l.trim())
    expect(lines).toContain('artifacts/hosted-chain-posture-probe.sql')
    expect(lines).not.toContain('artifacts/hosted-chain-posture-status.json')
    expect(lines).not.toContain(POSTURE_ATTEMPT_LEDGER)
  })

  it('authorises nothing: no verdict is a permission', () => {
    const status = statusOf(document(certifiedPosture()))
    const spellings = JSON.stringify(status.verdicts)
    for (const word of ['AUTHORIZED', 'AUTHORISED', 'APPLY', 'WRITE_PERMITTED']) {
      expect(spellings.includes(word)).toBe(false)
    }
  })
})

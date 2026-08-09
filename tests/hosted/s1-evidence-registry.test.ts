// tests/hosted/s1-evidence-registry.test.ts
//
// PRE-SENTINEL AND POST-SENTINEL ARE TWO HISTORICAL FACTS, NOT TWO VERSIONS.
//
// The gap this closes: `S1_OBSERVATION_ARTEFACT` was a single fixed path, and
// the script's own remedy told the operator to write there. Recording the
// post-S2 measurement would have overwritten the committed evidence that
// `sentinelRowCount = 0` — the only proof that the bootstrap did not mint its
// own sentinel — and the diff would have read as a routine update.
//
// The repository already had the shape: `CLASS_C_SQL_EDITOR_EVIDENCE`, a
// declared ledger whose own test says "never the newest file on disk". One
// thing here differs deliberately. Class-C resolves `ledger[ledger.length - 1]`
// because a newer measurement SUPERSEDES an older one. These two never
// supersede each other: they answer different, permanent questions. Selection
// is by DECLARED PHASE, and recency is not a signal at all.

import { describe, expect, it } from 'vitest'

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import {
  PHASE_LABEL,
  S1_EVIDENCE_REGISTRY,
  SENTINEL_EXPECTATION,
  evaluateBootstrapPostconditions,
  parseS1Observation,
  resolveS1Evidence,
  type S1EvidenceEntry,
  type S1Observation,
} from '@/db/hosted/bootstrap-postconditions'
import { KNOWN_PRODUCTION_IDENTIFIERS, KNOWN_STAGING_PROJECT_REF } from '@/db/hosted/target-identity'

const PROD = KNOWN_PRODUCTION_IDENTIFIERS.projectRefs[0]!
const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** The two paths committed at 90c2dff. They are load-bearing history. */
const PRE_OBSERVATION = 'artifacts/hosted-s1-observation.json'
const PRE_STATUS = 'artifacts/hosted-s1-status.json'
const POST_OBSERVATION = 'artifacts/hosted-s1-observation-post-sentinel.json'
const POST_STATUS = 'artifacts/hosted-s1-status-post-sentinel.json'

const entry = (patch: Partial<S1EvidenceEntry> = {}): S1EvidenceEntry => ({
  phase: 'pre-sentinel',
  path: PRE_OBSERVATION,
  statusPath: PRE_STATUS,
  measuredOn: '2026-08-09',
  projectRef: KNOWN_STAGING_PROJECT_REF,
  note: 'test fixture',
  ...patch,
})

const post = (patch: Partial<S1EvidenceEntry> = {}): S1EvidenceEntry =>
  entry({ phase: 'post-sentinel', path: POST_OBSERVATION, statusPath: POST_STATUS, ...patch })

// ---------------------------------------------------------------------------
// The registry as declared in the repository
// ---------------------------------------------------------------------------

describe('the declared registry', () => {
  it('declares exactly the two phases, once each', () => {
    expect(S1_EVIDENCE_REGISTRY).toHaveLength(2)
    expect(S1_EVIDENCE_REGISTRY.map((e) => e.phase).sort()).toEqual(['post-sentinel', 'pre-sentinel'])
  })

  it('points pre-sentinel at the paths committed at 90c2dff, unchanged', () => {
    const r = resolveS1Evidence('pre-sentinel')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entry.path).toBe(PRE_OBSERVATION)
      expect(r.entry.statusPath).toBe(PRE_STATUS)
    }
  })

  it('gives post-sentinel its own slot, which may be absent until S3 runs', () => {
    const r = resolveS1Evidence('post-sentinel')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entry.path).toBe(POST_OBSERVATION)
      expect(r.entry.statusPath).toBe(POST_STATUS)
    }
  })

  it('records pre-sentinel as permanent, and DENIES supersession rather than omitting the word', () => {
    // The first version of this test asserted the note did not contain
    // "superseded", and the note failed it by saying "NOT superseded ... and
    // never will be" — the strongest possible statement of the property.
    // Absence of a word is not the property; the claim is.
    const pre = S1_EVIDENCE_REGISTRY.find((e) => e.phase === 'pre-sentinel')!
    expect(pre.note).toMatch(/NOT superseded/)
    expect(pre.note, 'a Class-C style SUPERSEDED marking would be the defect').not.toMatch(
      /\bis superseded\b|^SUPERSEDED/i,
    )
    expect(pre.note).toMatch(/before S2|only be taken once/)
  })

  it('is a DECLARED registry — the module never scans the filesystem', () => {
    // The property that makes "no latest-file authority" structural rather than
    // aspirational. A directory scan would let dropping a file appoint the
    // authority; this module cannot see files at all.
    const src = readFileSync(path.join(ROOT, 'db/hosted/bootstrap-postconditions.ts'), 'utf8')
    for (const forbidden of ['readdirSync', 'readdir', 'statSync', 'mtime', 'glob', 'node:fs']) {
      expect(src, `${forbidden} would make selection depend on the disk`).not.toContain(forbidden)
    }
  })
})

// ---------------------------------------------------------------------------
// THE HISTORICAL INVARIANT
// ---------------------------------------------------------------------------

describe('the historical invariant', () => {
  it('resolves pre-sentinel identically whether or not post exists', () => {
    const withoutPost = resolveS1Evidence('pre-sentinel', [entry()], KNOWN_STAGING_PROJECT_REF)
    const withPost = resolveS1Evidence('pre-sentinel', [entry(), post()], KNOWN_STAGING_PROJECT_REF)
    expect(withoutPost.ok && withoutPost.entry).toEqual(withPost.ok && withPost.entry)
  })

  it('ignores declaration ORDER — phase is the selector, position is not', () => {
    const forward = resolveS1Evidence('pre-sentinel', [entry(), post()], KNOWN_STAGING_PROJECT_REF)
    const reversed = resolveS1Evidence('pre-sentinel', [post(), entry()], KNOWN_STAGING_PROJECT_REF)
    expect(forward.ok && forward.entry).toEqual(reversed.ok && reversed.entry)
    // And the same for the other phase, so neither is "the last one wins".
    const a = resolveS1Evidence('post-sentinel', [entry(), post()], KNOWN_STAGING_PROJECT_REF)
    const b = resolveS1Evidence('post-sentinel', [post(), entry()], KNOWN_STAGING_PROJECT_REF)
    expect(a.ok && a.entry).toEqual(b.ok && b.entry)
  })

  it('ignores a NEWER measuredOn on the other phase', () => {
    const r = resolveS1Evidence(
      'pre-sentinel',
      [entry({ measuredOn: '2026-08-09' }), post({ measuredOn: '2099-12-31' })],
      KNOWN_STAGING_PROJECT_REF,
    )
    expect(r.ok && r.entry.path).toBe(PRE_OBSERVATION)
  })
})

// ---------------------------------------------------------------------------
// Refusals — fail closed on every shape that could cross-wire the two
// ---------------------------------------------------------------------------

describe('registry refusals', () => {
  const code = (registry: readonly S1EvidenceEntry[], phase: 'pre-sentinel' | 'post-sentinel' = 'pre-sentinel', target = KNOWN_STAGING_PROJECT_REF): string => {
    const r = resolveS1Evidence(phase, registry, target)
    return r.ok ? 'OK' : r.code
  }

  it('refuses an empty registry', () => {
    expect(code([])).toBe('S1_REGISTRY_EMPTY')
  })

  it('refuses a phase nobody declared', () => {
    expect(code([entry()], 'post-sentinel')).toBe('S1_PHASE_NOT_DECLARED')
  })

  it('refuses a duplicated phase — two answers to one question', () => {
    expect(code([entry(), entry({ path: 'artifacts/other.json' })])).toBe('S1_PHASE_DUPLICATED')
  })

  it('refuses two phases sharing an observation path — the overwrite this exists to prevent', () => {
    expect(code([entry(), post({ path: PRE_OBSERVATION })])).toBe('S1_PATH_COLLISION')
  })

  it('refuses two phases sharing a status path', () => {
    expect(code([entry(), post({ statusPath: PRE_STATUS })])).toBe('S1_STATUS_PATH_COLLISION')
  })

  it('refuses an entry with no project ref', () => {
    expect(code([entry({ projectRef: '' })])).toBe('S1_ENTRY_PROJECT_REF_MISSING')
  })

  it('refuses a malformed project ref', () => {
    expect(code([entry({ projectRef: 'NOT-A-REF' })])).toBe('S1_ENTRY_PROJECT_REF_MALFORMED')
  })

  it('VETOES production before it checks anything else about the target', () => {
    expect(code([entry({ projectRef: PROD })], 'pre-sentinel', PROD)).toBe('S1_PRODUCTION_REF')
  })

  it('vetoes a production ENTRY even when the target asked about is staging', () => {
    // Found by mutation: the test above passed PROD as both the entry ref and
    // the target, so removing the entry-side half of the veto changed nothing
    // and survived. Each half needs its own control, and the CODE matters —
    // this must be refused as production, not as "the wrong project", because
    // the two call for different responses from whoever reads the refusal.
    expect(code([entry({ projectRef: PROD })], 'pre-sentinel', KNOWN_STAGING_PROJECT_REF)).toBe(
      'S1_PRODUCTION_REF',
    )
  })

  it('vetoes a production TARGET even when the entry describes staging', () => {
    expect(code([entry()], 'pre-sentinel', PROD)).toBe('S1_PRODUCTION_REF')
  })

  it('refuses evidence describing another project', () => {
    expect(code([entry()], 'pre-sentinel', 'aaaaaaaaaaaaaaaaaaaa')).toBe('S1_WRONG_TARGET')
  })
})

// ---------------------------------------------------------------------------
// The expectation lives in ONE place
// ---------------------------------------------------------------------------

describe('the sentinel expectation is derived from the phase, never supplied', () => {
  it('maps each phase to exactly one expectation', () => {
    expect(SENTINEL_EXPECTATION['pre-sentinel']).toBe('absent')
    expect(SENTINEL_EXPECTATION['post-sentinel']).toBe('present')
    expect(Object.keys(SENTINEL_EXPECTATION).sort()).toEqual(['post-sentinel', 'pre-sentinel'])
  })

  it('carries the expectation on the resolution, so a caller cannot pick its own', () => {
    const pre = resolveS1Evidence('pre-sentinel')
    const po = resolveS1Evidence('post-sentinel')
    expect(pre.ok && pre.sentinelExpected).toBe('absent')
    expect(po.ok && po.sentinelExpected).toBe('present')
  })

  it('makes the illegal combinations unrepresentable — evaluate takes a PHASE', () => {
    // `evaluateBootstrapPostconditions(observation, 'pre-sentinel')`. There is
    // no argument through which a caller could ask for phase=pre with
    // sentinel=present, because the expectation is not an argument at all.
    const o = healthy()
    expect(evaluateBootstrapPostconditions(o, 'pre-sentinel').sentinelExpected).toBe('absent')
    expect(evaluateBootstrapPostconditions(o, 'post-sentinel').sentinelExpected).toBe('present')
  })
})

function healthy(): S1Observation {
  return {
    targetProjectRef: KNOWN_STAGING_PROJECT_REF,
    bootstrapSchemaOwner: 'uellix_owner',
    roles: ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor'].map((name) => ({
      name, canLogin: false, isSuper: false, bypassRls: false, createRole: false, createDb: false, replication: false,
    })),
    memberships: [
      { role: 'uellix_owner', member: 'uellix_migrator', inheritOption: false, setOption: true },
      { role: 'uellix_writer', member: 'uellix_app', inheritOption: true, setOption: false },
    ],
    appReachesOwner: false,
    appReachesMigrator: false,
    ledgerOwner: 'uellix_owner',
    functions: [
      { signature: 'public.uellix_auth_uid()', owner: 'postgres', securityDefiner: true, config: ['search_path=""'], executeGrantees: ['postgres', 'uellix_app'] },
      { signature: 'uellix_bootstrap.assert_hosted_capabilities(text)', owner: 'postgres', securityDefiner: false, config: ['search_path=""'], executeGrantees: ['postgres', 'uellix_migrator'] },
      { signature: 'uellix_bootstrap.hosted_capability_report()', owner: 'postgres', securityDefiner: false, config: ['search_path=""'], executeGrantees: ['postgres', 'uellix_auditor', 'uellix_migrator'] },
    ],
    schemaPublicGrants: ['uellix_owner', 'uellix_migrator', 'uellix_app', 'uellix_writer', 'uellix_auditor'].map((g) => ({
      grantee: g, usage: true, create: g === 'uellix_owner',
    })),
    sentinelTablePresent: true,
    sentinelRowCount: 0,
  }
}

describe('the row count means opposite things in the two phases', () => {
  it('PRE with a row is a FAILURE — the bootstrap must not certify itself', () => {
    const v = evaluateBootstrapPostconditions({ ...healthy(), sentinelRowCount: 1 }, 'pre-sentinel')
    expect(v.passed).toBe(false)
    expect(v.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['S1-13'])
  })

  it('POST without a row is a FAILURE — A1 has nothing to corroborate', () => {
    const v = evaluateBootstrapPostconditions({ ...healthy(), sentinelRowCount: 0 }, 'post-sentinel')
    expect(v.passed).toBe(false)
    expect(v.checks.filter((c) => !c.passed).map((c) => c.id)).toEqual(['S1-13'])
  })

  it('and the other twelve checks are IDENTICAL in both — only S1-13 may differ', () => {
    // The property that lets S3 prove S2 changed nothing it should not have.
    const pre = evaluateBootstrapPostconditions(healthy(), 'pre-sentinel')
    const po = evaluateBootstrapPostconditions({ ...healthy(), sentinelRowCount: 1 }, 'post-sentinel')
    const strip = (v: typeof pre) => v.checks.filter((c) => c.id !== 'S1-13').map((c) => `${c.id}:${c.passed}:${c.detail}`)
    expect(strip(pre)).toEqual(strip(po))
    expect(pre.passed && po.passed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// What is actually on disk right now
// ---------------------------------------------------------------------------

describe('the committed PRE evidence at 90c2dff', () => {
  it('is present and still parses as the pre-sentinel fact it was', () => {
    const p = path.join(ROOT, PRE_OBSERVATION)
    expect(existsSync(p)).toBe(true)
    const o = JSON.parse(readFileSync(p, 'utf8')) as S1Observation
    expect(o.targetProjectRef).toBe(KNOWN_STAGING_PROJECT_REF)
    expect(o.sentinelRowCount).toBe(0)
    expect(evaluateBootstrapPostconditions(o, 'pre-sentinel').passed).toBe(true)
  })

  it('would FAIL if asked the post-sentinel question, which is why it is not reused', () => {
    const o = JSON.parse(readFileSync(path.join(ROOT, PRE_OBSERVATION), 'utf8')) as S1Observation
    expect(evaluateBootstrapPostconditions(o, 'post-sentinel').passed).toBe(false)
  })

  it('has a status artefact that records WHICH phase it is', () => {
    const s = JSON.parse(readFileSync(path.join(ROOT, PRE_STATUS), 'utf8')) as Record<string, unknown>
    expect(s.sentinelExpected).toBe('absent')
    expect(s.verdict).toBe('PASS')
  })

  it('does not yet have a POST artefact, and that is the correct state before S3', () => {
    expect(existsSync(path.join(ROOT, POST_OBSERVATION))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cross-wiring: why a status cannot be moved between slots and survive
// ---------------------------------------------------------------------------

describe('a status derived from the other phase cannot pass verification', () => {
  it('the two verdicts differ in fields the serialization carries', () => {
    // `:verify` recomputes the status for the requested phase and compares
    // bytes. That comparison only bites if the two phases produce DIFFERENT
    // bytes for the same database — otherwise a pre-sentinel verdict copied
    // into the post-sentinel slot would match and be believed.
    const pre = evaluateBootstrapPostconditions(healthy(), 'pre-sentinel')
    const po = evaluateBootstrapPostconditions({ ...healthy(), sentinelRowCount: 1 }, 'post-sentinel')

    expect(pre.sentinelExpected).not.toBe(po.sentinelExpected)
    expect(PHASE_LABEL['pre-sentinel']).not.toBe(PHASE_LABEL['post-sentinel'])
    // And S1-13's detail differs, so even the checks array cannot be shared.
    const detail = (v: typeof pre) => v.checks.find((c) => c.id === 'S1-13')!.detail
    expect(detail(pre)).not.toBe(detail(po))
  })

  it('an absent artefact refuses for its own phase, no matter what the other holds', () => {
    // Test N: deleting the pre-sentinel evidence must REFUSE the pre-sentinel
    // question. The existence of a post-sentinel measurement does not
    // retroactively make the earlier fact available — it was only observable
    // once, before S2.
    const pre = resolveS1Evidence('pre-sentinel')
    expect(pre.ok).toBe(true)
    if (pre.ok) {
      const r = parseS1Observation(null, KNOWN_STAGING_PROJECT_REF, pre.entry.path)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('S1_OBSERVATION_ABSENT')
    }
  })

  it('names the phase-correct path in its remedy, never the other one', () => {
    // Test 8 of the instruction: S3 must never be told to overwrite PRE.
    const po = resolveS1Evidence('post-sentinel')
    expect(po.ok).toBe(true)
    if (po.ok) {
      const r = parseS1Observation(null, KNOWN_STAGING_PROJECT_REF, po.entry.path)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.detail).toContain('artifacts/hosted-s1-observation-post-sentinel.json')
        expect(r.detail).not.toMatch(/hosted-s1-observation\.json/)
      }
    }
  })
})

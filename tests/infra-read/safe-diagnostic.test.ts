// @vitest-environment node
// tests/infra-read/safe-diagnostic.test.ts
//
// v1.0.6: a post-projection secret-detector refusal names the FIELD CLASS that
// fired (authority path + type + character-class counts) and NOTHING about the
// datum. The decision itself is unchanged: STOP stays STOP. No network: the
// provider is the fake world.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { SafeReadExecutor } from '../../scripts/infra-read/executor'
import { REGISTRY, Refusal, getOp, type OpDef } from '../../scripts/infra-read/ops'
import { scanText } from '../../scripts/infra-read/evidence-scan'
import {
  MAX_DIAGNOSTICS, SAFE_DIAGNOSTIC_KEYS, SecretDetectedRefusal, localizeFindings, schemaPathFor, type SafeDiagnostic,
} from '../../scripts/infra-read/safe-diagnostic'
import { CTX, TEAM, fakeRunner, world } from './fixtures'
import { VR2S2_FIELDS, expectedPathFor, projectsListWith, syntheticSecret } from './diag-fixtures'

const ctx = { ...CTX, xcc1Env: {}, xcc1Cwd: '/tmp/unused' }

function runVr2s2(w: ReturnType<typeof world>): { error?: unknown; ex: InstanceType<typeof SafeReadExecutor> } {
  const ex = new SafeReadExecutor(fakeRunner(w), ctx)
  ex.run('G-R1')
  ex.run('G-R3')
  ex.run('V-R2.S1')
  try { ex.run('V-R2.S2', { teamId: TEAM }) } catch (error) { return { error, ex } }
  return { ex }
}

/**
 * Every form of a value that must never appear in any output channel: the raw
 * value, its JSON-escaped form, EVERY 6-character window of either (so any
 * prefix, suffix or substring is caught), base64, and SHA-256 / MD5 digests
 * (whole and 8-character prefixes).
 */
function forbiddenForms(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1)
  const windows = (s: string) => Array.from({ length: Math.max(0, s.length - 5) }, (_, i) => s.slice(i, i + 6))
  const digests = ['sha256', 'md5'].flatMap((a) => { const h = createHash(a).update(value).digest('hex'); return [h, h.slice(0, 8)] })
  return [value, escaped, ...windows(value), ...windows(escaped), Buffer.from(value).toString('base64'), ...digests]
}

describe('V-R2.S2: every allowlisted location, synthetic entropy value (fake provider)', () => {
  for (const field of VR2S2_FIELDS) {
    it(`STOP names ${expectedPathFor(field)} and nothing about the value`, () => {
      const secret = syntheticSecret(field)
      const { error } = runVr2s2(world(projectsListWith(field, secret)))
      expect(error).toBeInstanceOf(SecretDetectedRefusal)
      const r = error as SecretDetectedRefusal
      expect(r.token).toBe('STOP_SECRET_BEARING_FIELD_RETURNED')
      expect(r.diagnostics.length).toBeGreaterThan(0)
      const d = r.diagnostics.find((x) => x.detector_id === 'OPAQUE_HIGH_ENTROPY')!
      expect(d).toBeDefined()
      expect(d.normalized_schema_path).toBe(expectedPathFor(field))
      expect(d.operation_id).toBe('V-R2.S2')
      expect(d.primitive_type).toBe('string')
      expect(d.string_length).toBe(secret.length)
      expect(d.uppercase_count).toBe((secret.match(/[A-Z]/g) ?? []).length)
      expect(d.digit_count).toBe((secret.match(/[0-9]/g) ?? []).length)
      for (const x of r.diagnostics) expect(Object.keys(x).sort()).toEqual([...SAFE_DIAGNOSTIC_KEYS].sort())
      const channels = [r.message, JSON.stringify(r), String(r), r.stack ?? '', JSON.stringify(r.diagnostics)]
      for (const c of channels) for (const f of forbiddenForms(secret)) expect(c.includes(f)).toBe(false)
    })
  }
})

describe('captured PROCESS output (child process, the entry point\'s own print path)', () => {
  for (const field of ['link.repo', 'id', 'pagination.next'] as const) {
    it(`stdout + stderr carry the path and never the value (${field})`, () => {
      const r = spawnSync('npx tsx tests/infra-read/diag-harness.ts ' + field, { encoding: 'utf8', shell: true, timeout: 120_000 })
      const out = `${r.stdout}\n${r.stderr}`
      expect(r.stderr).toContain('STOP_SECRET_BEARING_FIELD_RETURNED')
      expect(r.stderr).toContain(`"normalized_schema_path":"${expectedPathFor(field)}"`)
      for (const f of forbiddenForms(syntheticSecret(field))) expect(out.includes(f)).toBe(false)
    }, 130_000)
  }
})

describe('PASS / FAIL semantics are unchanged', () => {
  it('H: a normal V-R2.S2 passes, and its record carries no diagnostic payload', () => {
    const { error, ex } = runVr2s2(world())
    expect(error).toBeUndefined()
    const rec = ex.run('V-R3', { teamId: TEAM }) // any later op still works
    expect(JSON.stringify(rec)).not.toContain('normalized_schema_path')
  })
  it('A: detector fires -> STOP (never PASS), for every detector class the serialized scan sees', () => {
    const op = getOp('V-R2.S2')
    const j = (...p: string[]) => p.join('')
    const texts = [j('ab"', 'Qw7'.repeat(15)), j('vc', 'p_', 'a1B2c3D4e5F6g7H8i9J0'), j('https://', 'someone', '@h/x')]
    for (const t of texts) {
      const projection = { projects: [{ name: t }] }
      const hits = scanText(JSON.stringify(projection))
      expect(hits.length).toBeGreaterThan(0)
      const d = localizeFindings(op, projection, JSON.stringify(projection), hits)
      expect(d.length).toBeGreaterThan(0)
      expect(d.every((x) => x.normalized_schema_path === 'projects[*].name')).toBe(true)
    }
  })
  it('the refusal is the same class and token callers already handle', () => {
    const { error } = runVr2s2(world(projectsListWith('name', syntheticSecret('name'))))
    expect(error).toBeInstanceOf(Refusal)
    expect((error as Refusal).message.startsWith('STOP_SECRET_BEARING_FIELD_RETURNED: detectors OPAQUE_HIGH_ENTROPY fired on V-R2.S2; safe_diagnostics=')).toBe(true)
  })
})

describe('localization is structural and authority-derived', () => {
  const fakeOp = (allowlist: string[], presenceOnly?: string[]): OpDef => ({ ...getOp('V-R2.S2'), id: 'T', allowlist, presenceOnly })

  it('a provider key under a .** subtree is NEVER echoed: the path is the allowlist entry', () => {
    const op = fakeOp(['rules[].parameters.**'])
    const providerKey = ['Kz', '9'.repeat(4), 'Ab'.repeat(20)].join('')
    const projection = { rules: [{ parameters: { [providerKey]: 'x' } }] }
    const s = JSON.stringify(projection)
    const d = localizeFindings(op, projection, s, scanText(s))
    expect(d.length).toBeGreaterThan(0)
    expect(d[0].normalized_schema_path).toBe('rules[*].parameters.**')
    expect(JSON.stringify(d)).not.toContain(providerKey.slice(0, 8))
  })
  it('a key-context detector localizes to its member (a per-leaf rescan could not see it)', () => {
    const op = fakeOp(['meta.token'])
    const projection = { meta: { token: ['abc', 'def', 'ghi'].join('') } }
    const s = JSON.stringify(projection)
    const hits = scanText(s)
    expect(hits.map((h) => h.detector)).toContain('SECRET_KEYED_FIELD')
    const d = localizeFindings(op, projection, s, hits).find((x) => x.detector_id === 'SECRET_KEYED_FIELD')!
    expect(d.normalized_schema_path).toBe('meta.token')
    expect(d.primitive_type).toBe('string')
  })
  it('an unfaithful serialization reports UNLOCALIZED instead of a guessed path', () => {
    const op = getOp('V-R2.S2')
    const projection = { projects: [{ name: 'a' }] }
    const d = localizeFindings(op, projection, `${JSON.stringify(projection)} `, [{ detector: 'X', offset: 3 }])
    expect(d[0].normalized_schema_path).toBe('UNLOCALIZED')
  })
  it('schemaPathFor returns only authority text', () => {
    const op = fakeOp(['projects[].link.repo', 'a.**'], ['passwordProtection'])
    expect(schemaPathFor(op, 'projects[].link.repo')).toBe('projects[*].link.repo')
    expect(schemaPathFor(op, 'projects[].link')).toBe('projects[*].link')
    expect(schemaPathFor(op, 'a.anything.deep')).toBe('a.**')
    expect(schemaPathFor(op, '__presence.passwordProtection')).toBe('__presence.passwordProtection')
    expect(schemaPathFor(op, '__presence.other')).toBe('UNLOCALIZED')
    expect(schemaPathFor(op, 'not.allowlisted')).toBe('UNLOCALIZED')
  })
  it('the rebuilt serialization equals JSON.stringify on assorted shapes', () => {
    const op = fakeOp(['**'])
    for (const p of [{}, [], { a: [1, 'x', null, true, { b: -0.5 }] }, { 'we"ird': 'q"uote\\n ', n: 1e21, e: [] }]) {
      const s = JSON.stringify(p)
      // Every offset of the text maps to some span when the rebuild is faithful.
      const d = localizeFindings(op, p, s, [{ detector: 'X', offset: 0 }])
      expect(d[0].normalized_schema_path).not.toBe('UNLOCALIZED')
    }
  })
  it('diagnostics are bounded and de-duplicated', () => {
    const op = getOp('V-R2.S2')
    const v = syntheticSecret('name')
    const projection = { projects: Array.from({ length: 40 }, (_, i) => ({ name: `${v}${i}` })) }
    const s = JSON.stringify(projection)
    expect(localizeFindings(op, projection, s, scanText(s)).length).toBeLessThanOrEqual(MAX_DIAGNOSTICS)
  })
  it('the diagnostic schema is exactly the permitted key set', () => {
    expect([...SAFE_DIAGNOSTIC_KEYS]).toEqual([
      'operation_id', 'detector_id', 'normalized_schema_path', 'primitive_type', 'string_length',
      'uppercase_count', 'lowercase_count', 'digit_count', 'underscore_count', 'hyphen_count', 'dot_count', 'slash_count',
    ])
    const d: SafeDiagnostic = localizeFindings(getOp('V-R2.S2'), { projects: [{ name: syntheticSecret('x') }] }, JSON.stringify({ projects: [{ name: syntheticSecret('x') }] }), scanText(JSON.stringify({ projects: [{ name: syntheticSecret('x') }] })))[0]
    for (const v of Object.values(d)) expect(['string', 'number']).toContain(typeof v)
  })
})

describe('I: registry and read set (v1.0.7: exactly one read class added)', () => {
  it('the registry is exactly these ops (25), and EXECUTE_NOW is exactly the nine read classes (v1.0.7 adds G-R5 only)', () => {
    expect([...REGISTRY.keys()]).toEqual([
      'G-R1', 'G-R3', 'G-R2.WITNESS', 'G-R2.A', 'G-R2.B', 'G-R2.B.DETAIL', 'G-R2.C', 'G-R4.RUNS', 'G-R4.STATUS', 'G-R5',
      'V-R2.S1', 'V-R2.S2', 'V-R2.S3', 'V-R2.L1', 'V-R2.L3', 'V-R2.L5', 'V-R2.L7', 'V-R1', 'V-R3', 'V-R4.DEPLOYMENTS',
      'X-R1', 'PACMI-G1', 'PACMI-V1', 'PACMI-V2', 'PACMI-V3',
    ])
    const reads = [...new Set([...REGISTRY.values()].filter((o) => o.cls === 'GOVERNED_READ' && o.freshness === 'EXECUTE_NOW').map((o) => o.read))].sort()
    expect(reads).toEqual(['G-R1', 'G-R2', 'G-R3', 'G-R4', 'G-R5', 'V-R1', 'V-R2', 'V-R3', 'X-R1'])
    expect(REGISTRY.size).toBe(25)
    expect(getOp('V-R4.DEPLOYMENTS').freshness).toBe('F_IMMEDIATE_ONLY_BEFORE_MUTATION')
  })
})

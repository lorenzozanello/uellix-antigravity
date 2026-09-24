// @vitest-environment node
// tests/infra-read/envelope.test.ts
//
// The ENVELOPE allowlist (v1.0.5, remediating IC I08). Separate from the
// per-op projection allowlist: it governs the record that carries a
// projection. Every injected key below carries a value that trips NO secret
// detector, so a refusal here can only come from the envelope control itself.

import { describe, it, expect, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { SafeReadExecutor, assertEnvelopeConforms } from '../../scripts/infra-read/executor'
import { assertBundleEnvelopeConforms } from '../../scripts/infra-read/protocol'
import { scanText } from '../../scripts/infra-read/evidence-scan'
import { Refusal } from '../../scripts/infra-read/ops'
import { buildXcc1Env, createXcc1Context } from '../../scripts/infra-read/xcc1'
import { CTX, fakeRunner } from './fixtures'

const x = createXcc1Context()
const ctx = { ...CTX, xcc1Env: buildXcc1Env(x, process.env), xcc1Cwd: x.cwd }
afterAll(() => rmSync(x.root, { recursive: true, force: true }))

function token(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof Refusal) return e.token; throw e }
  return 'NO_REFUSAL'
}

const harmless = { id: 'r_1', note: 'plain' }

describe('evidence record envelope', () => {
  const rec = () => JSON.parse(JSON.stringify(new SafeReadExecutor(fakeRunner(), ctx).run('G-R1'))) as Record<string, unknown>

  it('POSITIVE: a real executor record conforms, and the injected values are invisible to the scanner', () => {
    expect(token(() => assertEnvelopeConforms(rec()))).toBe('NO_REFUSAL')
    expect(scanText(JSON.stringify(harmless))).toEqual([])
  })
  const cases: [string, (r: Record<string, unknown>) => void][] = [
    ['raw provider object at the top level', (r) => { r.raw = harmless }],
    ['stdout at the top level', (r) => { r.stdout = 'plain' }],
    ['a key inside operation', (r) => { (r.operation as Record<string, unknown>).headers = 'plain' }],
    ['a non-allowlisted assertion', (r) => { (r.assertions as Record<string, unknown>).provider_payload = 'plain' }],
    ['a non-scalar assertion value', (r) => { (r.assertions as Record<string, unknown>).name_matches = harmless }],
    ['a key inside absent_fields[]', (r) => { r.absent_fields = [{ path: 'a', kind: 'b', value: 'plain' }] }],
    ['a required key removed', (r) => { delete r.op_id }],
    ['node_ids not strings', (r) => { r.node_ids = [harmless] }],
  ]
  for (const [name, mut] of cases) {
    it(`REFUSED (STOP_ENVELOPE_NONCONFORMANT): ${name}`, () => {
      const r = rec()
      mut(r)
      expect(token(() => assertEnvelopeConforms(r))).toBe('STOP_ENVELOPE_NONCONFORMANT')
    })
  }
})

describe('bundle summary envelope', () => {
  const summary = () => ({
    protocol: 'p', rc9a: { measured_utc: 't', planes: {}, all_planes_satisfied: true, records: [], refresh_side_effect_disclosure: 'd' },
    dn0: {}, ac1: {}, records: ['G-R1'], limb_d: {}, unresolved: [], not_executed_by_design: [],
  })
  it('POSITIVE', () => { expect(token(() => assertBundleEnvelopeConforms(summary()))).toBe('NO_REFUSAL') })
  it('REFUSED: an extra top-level key', () => { expect(token(() => assertBundleEnvelopeConforms({ ...summary(), raw: harmless }))).toBe('STOP_ENVELOPE_NONCONFORMANT') })
  it('REFUSED: an extra rc9a key', () => { expect(token(() => assertBundleEnvelopeConforms({ ...summary(), rc9a: { ...summary().rc9a, stdout: 'plain' } }))).toBe('STOP_ENVELOPE_NONCONFORMANT') })
  it('REFUSED: full records instead of op ids', () => { expect(token(() => assertBundleEnvelopeConforms({ ...summary(), records: [harmless] }))).toBe('STOP_ENVELOPE_NONCONFORMANT') })
})

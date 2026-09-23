// @vitest-environment node
// tests/infra-read/entrypoint.test.ts
//
// Entry-point tests for run-governed-reads.ts (v1.0.5, remediating IC B-1).
//
// B-1 survived every test in the hardening lane because no test ever loaded
// the REAL dn0ConfigFor(): the protocol tests used a hand-written config whose
// verdict pattern matched a hand-written fixture. The entry point therefore
// demanded a verdict name nobody had agreed with the certifier. These tests
// drive the real config against the real materialized events, and against a
// synthesized executor-recertification event carrying the certifier's
// CANONICAL verdict names, so that reintroducing any name coupling goes RED.
// NO NETWORK and NO GOVERNED READ: git is a fake; main() is exercised only on
// its refusal paths.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { EXECUTOR_DIAGNOSTIC_RECERT_EVENT, EXECUTOR_RECERT_EVENT, assertExecutionRequested, dn0ConfigFor, main, parseArgs } from '../../scripts/infra-read/run-governed-reads'
import { assessCertificationEvent, terminalClassOf } from '../../scripts/infra-read/certification'
import { measureDn0, type LocalGit } from '../../scripts/infra-read/protocol'
import { Refusal } from '../../scripts/infra-read/ops'

const CANDIDATE = 'd3e4a55bfca3d32511ced78c09fd2e1a7a133270'
const cfg = dn0ConfigFor(CANDIDATE)
// v1.0.6: events[2] is the 81b56ed4 base recert (fixed); events[3] is the diagnostic recert bound to the supplied candidate.
const recertReq = cfg.certificationEvents[3]

function recert(over: Record<string, unknown> = {}, verdictOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    authority_class: 'INDEPENDENT_CERTIFICATION_EVENT_RECORD__NOT_AN_AUTHORITY__NOT_AN_ARMING_ACT',
    package_id: EXECUTOR_DIAGNOSTIC_RECERT_EVENT.packageId,
    CERTIFIED_CANDIDATE: { candidate_head: CANDIDATE },
    ...over,
    VERDICT: { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_PASS', blocking_findings: 0, nonblocking_findings: 0, ...verdictOver },
  })
}

function refusalToken(fn: () => unknown): string {
  try { fn() } catch (e) { if (e instanceof Refusal) return e.token; throw e }
  return 'NO_REFUSAL'
}

describe('dn0ConfigFor (the real entry-point configuration)', () => {
  it('binds four events, each to an EXACT candidate, and configures NO verdict name', () => {
    expect(cfg.certificationEvents).toHaveLength(4)
    for (const ev of cfg.certificationEvents) {
      expect(Object.keys(ev).sort()).toEqual(['certifiedCandidate', 'packageId', 'path'])
      expect(ev.certifiedCandidate).toMatch(/^[0-9a-f]{40}$/)
    }
    expect(cfg.certificationEvents[2]).toEqual({ path: 'docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_RECERT_IC_v1.0.0.json', packageId: 'CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_RECERT_IC', certifiedCandidate: '81b56ed44e9f6744c3949eff7ab9ad1b7137a5b5' })
    expect(recertReq).toEqual({ path: 'docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DIAGNOSTIC_RECERT_IC_v1.0.0.json', packageId: 'CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_DIAGNOSTIC_RECERT_IC', certifiedCandidate: CANDIDATE })
  })

  it('the entry-point source carries no verdict-name literal or verdict regex (B-1 cannot be reintroduced silently)', () => {
    // Code only: the comments deliberately QUOTE the retired name to explain B-1.
    const code = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n')
    const src = code('scripts/infra-read/run-governed-reads.ts')
    expect(src).not.toMatch(/_IC_PASS/)
    expect(src).not.toMatch(/verdict\s*:/)
    expect(code('scripts/infra-read/certification.ts')).not.toMatch(/[A-Z]+_IC_PASS|_HARDENING_|EXECUTOR_/)
    expect(code('scripts/infra-read/protocol.ts')).not.toMatch(/_IC_PASS/)
  })

  it('the three MATERIALIZED events on disk (incl. the 81b56ed4 base recert) satisfy the predicate exactly as configured', () => {
    for (const ev of cfg.certificationEvents.slice(0, 3)) {
      expect(assessCertificationEvent(readFileSync(ev.path, 'utf8'), ev)).toEqual({ ok: true, terminal: 'PASS_WITH_NONBLOCKING_FINDINGS' })
    }
  })

  it('the 81b56ed4 base recert can never stand in for the diagnostic recert of a later candidate (v1.0.6)', () => {
    const base = readFileSync(EXECUTOR_RECERT_EVENT.path, 'utf8')
    expect(assessCertificationEvent(base, recertReq).ok).toBe(false)
    expect(assessCertificationEvent(base, { ...recertReq, packageId: EXECUTOR_RECERT_EVENT.packageId }).ok).toBe(false) // another candidate
  })

  it('the MATERIALIZED hardening FAIL can never satisfy any event requirement', () => {
    const raw = readFileSync('docs/ops/release/CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_v1.0.0.json', 'utf8')
    for (const ev of cfg.certificationEvents) expect(assessCertificationEvent(raw, ev).ok).toBe(false)
    // Even addressed as itself and for its own candidate, it is a FAIL.
    expect(assessCertificationEvent(raw, { path: 'x', packageId: 'CV1_INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC', certifiedCandidate: CANDIDATE })).toEqual({ ok: false, reason: 'blocking findings are not exactly zero' })
  })
})

describe('LIMB_1 certification predicate (B-1)', () => {
  const accepted: [string, string][] = [
    ['canonical reviewer verdict ..._IC_PASS', recert()],
    ['canonical reviewer verdict ..._IC_PASS_WITH_NONBLOCKING_FINDINGS', recert({}, { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_PASS_WITH_NONBLOCKING_FINDINGS', nonblocking_findings: 4 })],
    ['a recert namespace the author never guessed', recert({}, { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_REMEDIATION_SHORT_FINAL_RECERT_PASS' })],
    ['the OLD guessed name is judged only semantically, never required', recert({}, { verdict: 'INFRA_EXECUTOR_HARDENING_IC_PASS' })],
  ]
  for (const [name, raw] of accepted) {
    it(`ACCEPTED: ${name}`, () => { expect(assessCertificationEvent(raw, recertReq).ok).toBe(true) })
  }

  const refused: [string, string, string][] = [
    ['PASS for a DIFFERENT candidate', recert({ CERTIFIED_CANDIDATE: { candidate_head: '3dc12909bb5b584ebc2266900659ab6f158d9eef' } }), 'event certifies a different candidate'],
    ['FAIL verdict', recert({}, { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_FAIL', blocking_findings: 1 }), 'blocking findings are not exactly zero'],
    ['FAIL verdict reported with blocking 0', recert({}, { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_FAIL' }), 'verdict is a failure'],
    ['FAIL containing the word PASS', recert({}, { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_FAIL_PASS' }), 'verdict is a failure'],
    ['negated PASS (NOT_PASS)', recert({}, { verdict: 'INFRA_EXECUTOR_RECERT_NOT_PASS' }), 'verdict is a failure'],
    ['PASS with blocking > 0', recert({}, { blocking_findings: 2 }), 'blocking findings are not exactly zero'],
    ['blocking count missing', recert({}, { blocking_findings: undefined }), 'blocking findings are not exactly zero'],
    ['blocking count as a string', recert({}, { blocking_findings: '0' }), 'blocking findings are not exactly zero'],
    ['wrong document class (an authority, not a certification event)', recert({ authority_class: 'READ_AUTHORITY_AMENDMENT' }), 'document class is not an independent-certification event record'],
    ['a PASS for ANOTHER artifact class (another package_id)', recert({ package_id: 'CV1_INFRA_RC9_ARMING_PACKAGE_IC' }), 'event is not the required certification event'],
    ['certified candidate missing', recert({ CERTIFIED_CANDIDATE: {} }), 'certified candidate missing or malformed'],
    ['certified candidate abbreviated', recert({ CERTIFIED_CANDIDATE: { candidate_head: 'd3e4a55b' } }), 'certified candidate missing or malformed'],
    ['prose containing PASS', recert({}, { verdict: 'The executor would PASS after remediation' }), 'verdict is not a recognisable verdict token'],
    ['lower-case pass', recert({}, { verdict: 'infra_executor_ic_pass' }), 'verdict is not a recognisable verdict token'],
    ['PASS only as a prefix', recert({}, { verdict: 'PASS_PENDING_REVIEW' }), 'verdict is not a recognisable verdict token'],
  ]
  for (const [name, raw, reason] of refused) {
    it(`REFUSED: ${name}`, () => { expect(assessCertificationEvent(raw, recertReq)).toEqual({ ok: false, reason }) })
  }

  it('REFUSED: not JSON / not an object / VERDICT missing', () => {
    expect(assessCertificationEvent('PASS', recertReq).ok).toBe(false)
    expect(assessCertificationEvent('["PASS"]', recertReq).ok).toBe(false)
    const noVerdict = JSON.parse(recert()) as Record<string, unknown>
    delete noVerdict.VERDICT
    expect(assessCertificationEvent(JSON.stringify(noVerdict), recertReq)).toEqual({ ok: false, reason: 'VERDICT block missing' })
  })

  it('terminal classes', () => {
    expect(terminalClassOf('X_IC_PASS')).toBe('PASS')
    expect(terminalClassOf('X_IC_PASS_WITH_NONBLOCKING_FINDINGS')).toBe('PASS_WITH_NONBLOCKING_FINDINGS')
    expect(terminalClassOf('X_IC_FAIL')).toBe('FAIL')
    expect(terminalClassOf('X_FAILED_IC_PASS')).toBe('FAIL')
    expect(terminalClassOf('X_IC_PASS_WITH_BLOCKING_FINDINGS')).toBeUndefined()
    expect(terminalClassOf('X IC PASS')).toBeUndefined()
  })
})

// ------------------------------------------------------------- measureDn0 with the REAL config

function fakeRepo(recertRaw: string | undefined): LocalGit {
  const pinBlob = new Map(cfg.pins.map((p) => [p.path, p.blob]))
  return {
    run: (args) => {
      const a = args.join(' ')
      const out = (stdout: string) => ({ status: 0, stdout, stderr: '' })
      if (a === 'status --porcelain --untracked-files=all') return out('')
      if (a === 'rev-parse --abbrev-ref HEAD') return out(`${cfg.expectedBranch}\n`)
      if (a === 'rev-parse HEAD') return out(`${'c'.repeat(40)}\n`)
      if (a === 'rev-parse HEAD^{tree}') return out('e'.repeat(40))
      if (a.startsWith('merge-base --is-ancestor ')) return out('')
      if (a.startsWith('diff --name-status ')) return out(`A\t${EXECUTOR_DIAGNOSTIC_RECERT_EVENT.path}\n`)
      if (a.startsWith('config --name-only --get-regexp ^remote')) return out('remote.origin.url\n')
      if (a.startsWith('config --name-only --get-regexp ')) return { status: 1, stdout: '', stderr: '' }
      if (args.includes('fetch')) return out('')
      if (a.startsWith(`rev-parse ${cfg.integrationRef}`)) return out('f'.repeat(40))
      if (a.startsWith('rev-parse HEAD:')) return out(pinBlob.get(a.slice('rev-parse HEAD:'.length)) ?? '')
      if (a.startsWith('show HEAD:')) {
        const p = a.slice('show HEAD:'.length)
        if (p === EXECUTOR_DIAGNOSTIC_RECERT_EVENT.path) return recertRaw === undefined ? { status: 128, stdout: '', stderr: 'absent' } : out(recertRaw)
        return out(readFileSync(p, 'utf8'))
      }
      return { status: 1, stdout: '', stderr: `unexpected git ${a}` }
    },
  }
}

describe('measureDn0 driven by dn0ConfigFor (entry-point integration, fake git)', () => {
  it('POSITIVE: the real config + materialized events + a canonical-name recert of the exact candidate -> all 3 events verified', () => {
    const r = measureDn0(fakeRepo(recert()), cfg)
    expect(r.certification_events_verified).toBe(4)
    expect(r.post_certification_additions).toEqual([EXECUTOR_DIAGNOSTIC_RECERT_EVENT.path])
    expect(r.pins_matched).toBe(cfg.pins.length)
  })
  it('POSITIVE: the canonical PASS_WITH_NONBLOCKING_FINDINGS form', () => {
    const raw = recert({}, { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_PASS_WITH_NONBLOCKING_FINDINGS', nonblocking_findings: 3 })
    expect(measureDn0(fakeRepo(raw), cfg).certification_events_verified).toBe(4)
  })
  const refused: [string, string | undefined][] = [
    ['recert absent', undefined],
    ['recert of another candidate', recert({ CERTIFIED_CANDIDATE: { candidate_head: '3dc12909bb5b584ebc2266900659ab6f158d9eef' } })],
    ['recert FAIL', recert({}, { verdict: 'INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_FAIL', blocking_findings: 1 })],
    ['recert with blocking > 0', recert({}, { blocking_findings: 1 })],
    ['recert of the wrong document class', recert({ authority_class: 'SOMETHING_ELSE' })],
  ]
  for (const [name, raw] of refused) {
    it(`REFUSED (STOP_ARMING_LIMB1_UNSATISFIED): ${name}`, () => {
      expect(refusalToken(() => measureDn0(fakeRepo(raw), cfg))).toBe('STOP_ARMING_LIMB1_UNSATISFIED')
    })
  }
})

describe('main() refuses anything short of an explicit, fully specified execution request', () => {
  it('refuses with exit 2 and runs nothing', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      expect(main([])).toBe(2)
      expect(main(['--execute'])).toBe(2)
      expect(main(['--execute', '--certified-candidate', 'd3e4a55b', '--out', 'x'])).toBe(2)
      expect(main(['--certified-candidate', CANDIDATE, '--out', 'x'])).toBe(2)
      expect(err.mock.calls.every((c) => String(c[0]).startsWith('STOP_EXECUTION_NOT_REQUESTED'))).toBe(true)
      expect(log).not.toHaveBeenCalled()
    } finally { err.mockRestore(); log.mockRestore() }
  })
  it('parseArgs / assertExecutionRequested accept only the complete form', () => {
    expect(() => assertExecutionRequested(parseArgs(['--execute', '--certified-candidate', CANDIDATE, '--out', 'o']))).not.toThrow()
  })
})

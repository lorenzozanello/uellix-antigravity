// scripts/infra-read/certification.ts
//
// LIMB_1 certification predicate (v1.0.5, remediating IC B-1).
//
// B-1: the runtime required the executor-hardening certification's VERDICT to
// match `^INFRA_EXECUTOR_HARDENING_IC_PASS...`, a name the AUTHOR guessed. The
// certifier emitted `INFRA_CONTROL_PLANE_READ_EXECUTOR_HARDENING_IC_*`, so a
// faithful materialization could never satisfy LIMB_1. The verdict NAMESPACE
// is the reviewer's choice; binding code to it makes it an accidental ABI.
//
// This predicate binds to what certification MEANS instead:
//   * the file is an independent-certification event record (document class),
//   * it is the event the materializer was told to write (package_id — chosen
//     by the materializer, never by the reviewer),
//   * it certifies EXACTLY the candidate the protocol is executing,
//   * it reports ZERO blocking findings, and
//   * its verdict's TERMINAL class is PASS or PASS_WITH_NONBLOCKING_FINDINGS.
// The namespace in front of the terminal class is ignored, except that it may
// not contain a failure or negation token: a FAIL that happens to contain the
// word PASS never satisfies it, and neither does prose.

export interface CertificationEventRequirement {
  readonly path: string
  /** Identity of the event FILE, chosen by whoever materializes it — not the reviewer's verdict token. */
  readonly packageId: string
  /** The exact 40-hex candidate the event must certify. */
  readonly certifiedCandidate: string
}

export type TerminalClass = 'PASS' | 'PASS_WITH_NONBLOCKING_FINDINGS' | 'FAIL'

export const CERTIFICATION_DOCUMENT_CLASS_PREFIX = 'INDEPENDENT_CERTIFICATION_EVENT_RECORD'

/** Namespace tokens that negate or fail a verdict, whatever its terminal suffix says. */
const NEGATING_TOKENS = new Set([
  'FAIL', 'FAILED', 'FAILURE', 'FAILS', 'NOT', 'NO', 'NON', 'BLOCKED', 'INSUFFICIENT', 'INCOMPLETE',
  'REJECTED', 'WITHDRAWN', 'INVALID', 'VOID', 'REVOKED', 'SUPERSEDED',
])

/**
 * Terminal class of a verdict TOKEN. Returns undefined for anything that is
 * not a single upper-case token (prose), or whose terminal is not a pass form.
 */
export function terminalClassOf(verdict: string): TerminalClass | undefined {
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(verdict)) return undefined
  const tokens = verdict.split('_')
  if (tokens.some((t) => t.startsWith('FAIL'))) return 'FAIL'
  let terminal: TerminalClass | undefined
  let namespace: string[]
  const nb = ['PASS', 'WITH', 'NONBLOCKING', 'FINDINGS']
  if (tokens.length >= 4 && nb.every((t, i) => tokens[tokens.length - 4 + i] === t)) {
    terminal = 'PASS_WITH_NONBLOCKING_FINDINGS'
    namespace = tokens.slice(0, -4)
  } else if (tokens[tokens.length - 1] === 'PASS') {
    terminal = 'PASS'
    namespace = tokens.slice(0, -1)
  } else {
    return undefined
  }
  if (namespace.some((t) => NEGATING_TOKENS.has(t))) return 'FAIL'
  return terminal
}

export type Assessment = { readonly ok: true; readonly terminal: TerminalClass } | { readonly ok: false; readonly reason: string }

export function assessCertificationEvent(raw: string, req: CertificationEventRequirement): Assessment {
  let doc: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'event is not a JSON object' }
    doc = parsed as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'event is not JSON' }
  }
  const cls = doc.authority_class
  if (typeof cls !== 'string' || !cls.startsWith(CERTIFICATION_DOCUMENT_CLASS_PREFIX)) {
    return { ok: false, reason: 'document class is not an independent-certification event record' }
  }
  if (doc.package_id !== req.packageId) return { ok: false, reason: 'event is not the required certification event' }
  const cand = (doc.CERTIFIED_CANDIDATE as Record<string, unknown> | undefined)?.candidate_head
  if (typeof cand !== 'string' || !/^[0-9a-f]{40}$/.test(cand)) return { ok: false, reason: 'certified candidate missing or malformed' }
  if (cand !== req.certifiedCandidate) return { ok: false, reason: 'event certifies a different candidate' }
  const verdict = doc.VERDICT as Record<string, unknown> | undefined
  if (typeof verdict !== 'object' || verdict === null) return { ok: false, reason: 'VERDICT block missing' }
  if (verdict.blocking_findings !== 0) return { ok: false, reason: 'blocking findings are not exactly zero' }
  const v = verdict.verdict
  const terminal = typeof v === 'string' ? terminalClassOf(v) : undefined
  if (terminal === undefined) return { ok: false, reason: 'verdict is not a recognisable verdict token' }
  if (terminal === 'FAIL') return { ok: false, reason: 'verdict is a failure' }
  return { ok: true, terminal }
}

// scripts/infra-read/safe-diagnostic.ts
//
// Safe structural diagnostic for a post-projection secret-detector refusal
// (v1.0.6, lane CV1-INFRA-VR2-ENTROPY-SAFE-DIAGNOSTIC-R1).
//
// MEASURED: the first governed execution stopped with
// STOP_SECRET_BEARING_FIELD_RETURNED (OPAQUE_HIGH_ENTROPY on V-R2.S2) and the
// refusal named only the detector and the op, so nobody could tell WHICH
// allowlisted field class fired without reading the value. This module names
// the field class and nothing about the datum.
//
// Rules:
//   * OBSERVATIONAL ONLY. The executor's decision is unchanged: the same
//     detectors, over the same JSON.stringify(projection) text, decide STOP.
//     This module runs only after that decision and cannot turn it into PASS.
//   * LOCALIZATION WITHOUT LOSING STRUCTURE. The projection is walked in
//     memory and re-serialized piece by piece, recording the [start, end) span
//     of every member and value. The rebuilt text must equal JSON.stringify
//     byte for byte (else every hit is UNLOCALIZED), so each detector offset
//     maps to the leaf that produced it. Key-context detectors (e.g. a
//     "token":"..." pair) localize to their member, which a per-leaf rescan
//     could not see.
//   * THE PATH IS AUTHORITY TEXT, NEVER PROVIDER TEXT. The reported path is the
//     op's own allowlist entry (arrays as [*]), a declared presence name, or a
//     container prefix of an allowlist entry. Provider keys under a `.**`
//     subtree are never echoed: such a hit reports the `base.**` entry only.
//   * ONLY COUNTS ABOUT THE VALUE: type, length and character-class counts.
//     Never the value, a substring, prefix, suffix, first/last character,
//     hash, digest or any encoding of it.

import { Refusal, type OpDef } from './ops'
import type { Finding } from './evidence-scan'

export const SAFE_DIAGNOSTIC_KEYS = [
  'operation_id', 'detector_id', 'normalized_schema_path', 'primitive_type', 'string_length',
  'uppercase_count', 'lowercase_count', 'digit_count', 'underscore_count', 'hyphen_count', 'dot_count', 'slash_count',
] as const

export interface SafeDiagnostic {
  readonly operation_id: string
  readonly detector_id: string
  readonly normalized_schema_path: string
  readonly primitive_type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'unknown'
  readonly string_length: number
  readonly uppercase_count: number
  readonly lowercase_count: number
  readonly digit_count: number
  readonly underscore_count: number
  readonly hyphen_count: number
  readonly dot_count: number
  readonly slash_count: number
}

/** Bound on diagnostics per refusal; identical entries are reported once. */
export const MAX_DIAGNOSTICS = 16

interface Span {
  readonly start: number
  readonly end: number
  readonly generic: string
  readonly value: unknown
}

function typeOf(v: unknown): SafeDiagnostic['primitive_type'] {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'object' ? t : 'unknown'
}

/** Re-serializes exactly as JSON.stringify(v) (no indentation), recording spans. */
function serialize(v: unknown, generic: string, parts: string[], pos: { n: number }, spans: Span[]): void {
  const start = pos.n
  const emit = (s: string) => { parts.push(s); pos.n += s.length }
  if (Array.isArray(v)) {
    emit('[')
    v.forEach((el, i) => {
      if (i > 0) emit(',')
      if (el === undefined || typeof el === 'function' || typeof el === 'symbol') emit('null')
      else serialize(el, `${generic}[]`, parts, pos, spans)
    })
    emit(']')
  } else if (v !== null && typeof v === 'object') {
    emit('{')
    let first = true
    for (const [k, el] of Object.entries(v as Record<string, unknown>)) {
      if (el === undefined || typeof el === 'function' || typeof el === 'symbol') continue
      if (!first) emit(',')
      first = false
      const memberStart = pos.n
      const childGeneric = generic === '' ? k : `${generic}.${k}`
      emit(`${JSON.stringify(k)}:`)
      serialize(el, childGeneric, parts, pos, spans)
      // The member span (key through value) localizes key-context detectors.
      spans.push({ start: memberStart, end: pos.n, generic: childGeneric, value: el })
    }
    emit('}')
  } else {
    emit(JSON.stringify(v) ?? 'null')
  }
  spans.push({ start, end: pos.n, generic, value: v })
}

const star = (p: string) => p.split('[]').join('[*]')

/** Maps a generic path to AUTHORITY text: an allowlist entry, a declared presence name, or a container prefix of an entry. */
export function schemaPathFor(op: OpDef, generic: string): string {
  if (generic === '') return '$'
  if (generic === '__presence') return '__presence'
  if (generic.startsWith('__presence.')) {
    const name = generic.slice('__presence.'.length)
    return op.presenceOnly?.includes(name) ? `__presence.${name}` : 'UNLOCALIZED'
  }
  for (const p of op.allowlist) {
    if (p === generic) return star(p)
    if (p.endsWith('.**')) {
      const base = p.slice(0, -3)
      if (generic === base || generic.startsWith(`${base}.`) || generic.startsWith(`${base}[]`)) return star(p)
    }
  }
  for (const p of op.allowlist) {
    if (p.startsWith(`${generic}.`) || p.startsWith(`${generic}[]`)) return star(generic)
  }
  return 'UNLOCALIZED'
}

function count(s: string, re: RegExp): number {
  const m = s.match(re)
  return m ? m.length : 0
}

function describe(op: OpDef, detector: string, span: Span | undefined): SafeDiagnostic {
  const zero = { string_length: 0, uppercase_count: 0, lowercase_count: 0, digit_count: 0, underscore_count: 0, hyphen_count: 0, dot_count: 0, slash_count: 0 }
  if (!span) return { operation_id: op.id, detector_id: detector, normalized_schema_path: 'UNLOCALIZED', primitive_type: 'unknown', ...zero }
  const t = typeOf(span.value)
  // Counts are over the decoded value for a primitive; over the serialized container otherwise.
  const text = t === 'string' ? (span.value as string) : t === 'object' || t === 'array' ? JSON.stringify(span.value) : String(span.value)
  return {
    operation_id: op.id,
    detector_id: detector,
    normalized_schema_path: schemaPathFor(op, span.generic),
    primitive_type: t,
    string_length: text.length,
    uppercase_count: count(text, /[A-Z]/g),
    lowercase_count: count(text, /[a-z]/g),
    digit_count: count(text, /[0-9]/g),
    underscore_count: count(text, /_/g),
    hyphen_count: count(text, /-/g),
    dot_count: count(text, /\./g),
    slash_count: count(text, /\//g),
  }
}

/**
 * Localizes each finding over `serialized` (which MUST be JSON.stringify(projection),
 * the text the decision was taken on) to the innermost member or value that contains it.
 */
export function localizeFindings(op: OpDef, projection: unknown, serialized: string, findings: readonly Finding[]): SafeDiagnostic[] {
  const parts: string[] = []
  const spans: Span[] = []
  serialize(projection, '', parts, { n: 0 }, spans)
  const faithful = parts.join('') === serialized
  const out: SafeDiagnostic[] = []
  const seen = new Set<string>()
  for (const f of findings) {
    let best: Span | undefined
    if (faithful) {
      for (const s of spans) {
        if (s.start <= f.offset && f.offset < s.end && (!best || s.end - s.start < best.end - best.start)) best = s
      }
    }
    const d = describe(op, f.detector, best)
    const k = JSON.stringify(d)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(d)
    if (out.length >= MAX_DIAGNOSTICS) break
  }
  return out
}

/** The same refusal token as before, carrying only safe structural metadata. */
export class SecretDetectedRefusal extends Refusal {
  readonly diagnostics: readonly SafeDiagnostic[]
  constructor(op: OpDef, detectors: readonly string[], diagnostics: readonly SafeDiagnostic[]) {
    super('STOP_SECRET_BEARING_FIELD_RETURNED', `detectors ${detectors.join(',')} fired on ${op.id}; safe_diagnostics=${JSON.stringify(diagnostics)}`)
    this.diagnostics = Object.freeze(diagnostics.map((d) => Object.freeze({ ...d })))
  }
}

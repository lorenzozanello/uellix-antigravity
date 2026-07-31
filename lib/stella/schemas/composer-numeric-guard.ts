// lib/stella/schemas/composer-numeric-guard.ts
// U4 (WS4) — pure numeric-integrity guard for Stella Composer output.
//
// The Composer drafts narrative from persisted run numbers. A hallucinated
// figure in that narrative is an audit-integrity failure: every numeric token
// in the model's free text must be traceable to a value the caller explicitly
// authorized (run totals, the SROI ratio, the funder breakdown, and any extra
// values the caller passes). This module is PURE and is NOT wired anywhere —
// the coordinator wires it into app/actions/stella/composer.ts (see WIRING.md
// in this directory).
//
// ── Allowlist (tokens never flagged) ─────────────────────────────────────────
// 1. Calendar years: a plain 4-digit integer in 1900–2100 (no separators, no
//    decimals). Covers "en 2026", period labels, etc.
// 2. Small integers / list ordinals: plain integers 0–20. Covers "3 outcomes",
//    "step 2", the "1" in "3.2:1".
// 3. Section numbers: a short dotted token (e.g. "2.1", "3.4.1", 1–2 digit
//    components) that either starts a line and is followed by whitespace and a
//    letter ("2.1 Metodología"), or is immediately preceded by the word
//    "section"/"sección". A dotted token followed by ':' or '%' is NEVER
//    treated as a section number.
// 4. Identifier fragments: digits directly attached to a letter/underscore
//    (or via '-', '/', '#' after an alphanumeric), e.g. "ev-123", "SDG8",
//    "v2.3". These are references, not numeric claims. (validateComposer-
//    References covers the structured id fields.)
//
// ── Formatting tolerance (how a token can match an authorized value) ─────────
// - Thousands separators: "1,600,000.50" and "1.600.000,50" both normalize to
//   1600000.50; ambiguous forms ("1,600" / "1.600") are tried BOTH as
//   thousands-grouped and as decimal — matching either authorized value passes.
// - Decimal truncation/rounding: a token with 0–6 decimal places matches if it
//   equals the authorized value truncated OR half-up-rounded to that many
//   places ("2.01" and "2.02" both match an authorized 2.015082; "1600000"
//   matches "1600000.0000").
// - Percentages: a token immediately followed by '%' (or "percent" /
//   "por ciento") additionally matches when token/100 equals an authorized
//   value ("20%" matches an authorized 0.2), on top of the plain comparison
//   ("20%" also matches an authorized 20).

// Pin the shared Decimal configuration — determinism guard (WS4 U1).
import '@/lib/pipeline/decimal-config'
import Decimal from 'decimal.js'
import type { ComposerOutput } from './composer-output'

// ── Public types ─────────────────────────────────────────────────────────────

export interface AuthorizedTotals {
  totalInvestment: string | number
  grossSocialValue: string | number
  netSocialValue: string | number
}

export interface AuthorizedFunderRow {
  investmentUsd: string | number
  attributedNsvUsd: string | number
  sroiRatio: string | number
}

export interface AuthorizedNumbers {
  totals: AuthorizedTotals
  ratio: string | number
  funderBreakdown?: readonly AuthorizedFunderRow[]
  /**
   * Any other values the Composer legitimately saw in its context: filter
   * percentages, unattributed NSV, line-item count, run version, quantities…
   * The guard is only as good as this set — pass everything the context held.
   */
  additional?: readonly (string | number)[]
}

export interface NumericViolation {
  /** The raw token as it appeared in the text. */
  token: string
  /** Where it appeared, e.g. 'draft_content', 'assumptions[2]'. */
  field: string
}

export interface NumericGuardResult {
  ok: boolean
  violations: NumericViolation[]
}

export interface ReferenceViolation {
  id: string
  field: string
}

export interface ReferenceGuardResult {
  ok: boolean
  violations: ReferenceViolation[]
}

/** Structural subset of StellaProjectContext the reference check needs. */
export interface ComposerReferenceContext {
  evidenceMetadata?: readonly { id: string }[]
  proxySummary?: readonly { id: string }[]
}

// ── Internals ────────────────────────────────────────────────────────────────

const YEAR_MIN = 1900
const YEAR_MAX = 2100
const MAX_ALLOWED_ORDINAL = 20
const MAX_TOLERATED_DP = 6

// Digit runs with optional '.'/',' groups: 12 · 3.2 · 1,600,000.50 · 2.1.3
const NUMBER_TOKEN_RE = /\d+(?:[.,]\d+)*/g

function toDecimal(v: string | number): Decimal | null {
  try {
    const d = new Decimal(v)
    return d.isFinite() ? d : null
  } catch {
    return null
  }
}

function collectAuthorized(authorized: AuthorizedNumbers): Decimal[] {
  const raw: (string | number)[] = [
    authorized.totals.totalInvestment,
    authorized.totals.grossSocialValue,
    authorized.totals.netSocialValue,
    authorized.ratio,
  ]
  for (const row of authorized.funderBreakdown ?? []) {
    raw.push(row.investmentUsd, row.attributedNsvUsd, row.sroiRatio)
  }
  raw.push(...(authorized.additional ?? []))
  const out: Decimal[] = []
  for (const v of raw) {
    const d = toDecimal(v)
    if (d) out.push(d.abs())
  }
  return out
}

/**
 * Interpret a raw token under every plausible thousands/decimal-separator
 * convention. Returns normalized numeric strings (dot-decimal, no grouping).
 */
function normalizationCandidates(token: string): string[] {
  const candidates = new Set<string>()
  const hasDot = token.includes('.')
  const hasComma = token.includes(',')

  if (hasDot && hasComma) {
    // The LAST separator that appears is the decimal separator.
    const lastDot = token.lastIndexOf('.')
    const lastComma = token.lastIndexOf(',')
    const decimalSep = lastDot > lastComma ? '.' : ','
    const groupSep = decimalSep === '.' ? ',' : '.'
    const cleaned = token.split(groupSep).join('')
    candidates.add(decimalSep === '.' ? cleaned : cleaned.replace(',', '.'))
  } else if (hasComma) {
    if (/^\d{1,3}(,\d{3})+$/.test(token)) candidates.add(token.split(',').join('')) // thousands
    if ((token.match(/,/g) ?? []).length === 1) candidates.add(token.replace(',', '.')) // decimal comma
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(token)) candidates.add(token.split('.').join('')) // es-LA thousands
    if ((token.match(/\./g) ?? []).length === 1) candidates.add(token) // plain decimal
    // Multi-dot non-grouped tokens ("2.1.3") have no numeric interpretation.
  } else {
    candidates.add(token)
  }
  return [...candidates]
}

function decimalPlaces(normalized: string): number {
  const i = normalized.indexOf('.')
  return i === -1 ? 0 : normalized.length - i - 1
}

function matchesAuthorizedValue(candidate: Decimal, dp: number, authorized: Decimal): boolean {
  if (candidate.eq(authorized)) return true
  if (dp > MAX_TOLERATED_DP) return false
  return (
    candidate.eq(authorized.toDecimalPlaces(dp, Decimal.ROUND_DOWN)) ||
    candidate.eq(authorized.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP))
  )
}

function tokenMatchesAuthorized(
  token: string,
  isPercentContext: boolean,
  authorizedValues: Decimal[],
): boolean {
  for (const normalized of normalizationCandidates(token)) {
    const value = toDecimal(normalized)
    if (!value) continue
    const dp = decimalPlaces(normalized)
    for (const authorized of authorizedValues) {
      if (matchesAuthorizedValue(value.abs(), dp, authorized)) return true
      if (isPercentContext && matchesAuthorizedValue(value.abs().div(100), dp + 2, authorized)) return true
    }
  }
  return false
}

const SECTION_TOKEN_RE = /^\d{1,2}(\.\d{1,2}){1,2}$/
const SECTION_KEYWORD_RE = /(?:secci[oó]n|section)\s*$/i

interface TokenSite {
  token: string
  isPercent: boolean
  allowlisted: boolean
}

function extractTokens(text: string): TokenSite[] {
  const sites: TokenSite[] = []
  for (const match of text.matchAll(NUMBER_TOKEN_RE)) {
    const token = match[0]
    const start = match.index ?? 0
    const end = start + token.length
    const prev = start > 0 ? text[start - 1] : ''
    const prevPrev = start > 1 ? text[start - 2] : ''
    const next = end < text.length ? text[end] : ''
    const after = text.slice(end)
    const before = text.slice(0, start)

    const isPercent = /^\s{0,2}(%|percent\b|por\s+ciento\b)/i.test(after)

    // (4) identifier fragment: "ev-123", "SDG8", "v2.3", "#4", "out/7"
    const identifierAttached =
      /[A-Za-z_]/.test(prev) ||
      (['-', '/', '#'].includes(prev) && /[A-Za-z0-9_]/.test(prevPrev))

    // (1) calendar year / (2) small integer — plain integers only
    const isPlainInt = /^\d+$/.test(token)
    const intVal = isPlainInt ? parseInt(token, 10) : NaN
    const isYear = isPlainInt && token.length === 4 && intVal >= YEAR_MIN && intVal <= YEAR_MAX
    const isOrdinal = isPlainInt && intVal <= MAX_ALLOWED_ORDINAL

    // (3) section number
    const atLineStart = /(?:^|\n)\s*$/.test(before)
    const headingFollows = /^\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(after)
    const isSectionNumber =
      SECTION_TOKEN_RE.test(token) &&
      next !== ':' &&
      !isPercent &&
      ((atLineStart && headingFollows) || SECTION_KEYWORD_RE.test(before))

    sites.push({
      token,
      isPercent,
      allowlisted: identifierAttached || isYear || isOrdinal || isSectionNumber,
    })
  }
  return sites
}

function freeTextFields(output: ComposerOutput): { field: string; text: string }[] {
  const fields: { field: string; text: string }[] = [
    { field: 'draft_title', text: output.draft_title },
    { field: 'draft_content', text: output.draft_content },
  ]
  output.assumptions.forEach((text, i) => fields.push({ field: `assumptions[${i}]`, text }))
  output.limitations.forEach((text, i) => fields.push({ field: `limitations[${i}]`, text }))
  output.evidence_references.forEach((ref, i) => {
    fields.push({ field: `evidence_references[${i}].title`, text: ref.title })
    fields.push({ field: `evidence_references[${i}].context`, text: ref.context })
  })
  output.proxy_references.forEach((ref, i) => {
    fields.push({ field: `proxy_references[${i}].name`, text: ref.name })
    fields.push({ field: `proxy_references[${i}].context`, text: ref.context })
  })
  return fields
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Flags every numeric token in the Composer's free text that is neither
 * allowlisted (years, ordinals ≤ 20, section numbers, identifier fragments)
 * nor traceable — under the documented formatting tolerance — to a value in
 * the authorized set. `ok === false` means the draft contains at least one
 * number the persisted run never produced.
 */
export function validateComposerNumbers(
  output: ComposerOutput,
  authorized: AuthorizedNumbers,
): NumericGuardResult {
  const authorizedValues = collectAuthorized(authorized)
  const violations: NumericViolation[] = []

  for (const { field, text } of freeTextFields(output)) {
    if (!text) continue
    for (const site of extractTokens(text)) {
      if (site.allowlisted) continue
      if (tokenMatchesAuthorized(site.token, site.isPercent, authorizedValues)) continue
      violations.push({ token: site.token, field })
    }
  }

  return { ok: violations.length === 0, violations }
}

/**
 * Cross-checks the structured reference ids in the Composer output against
 * the id sets that were actually present in the context sent to the model.
 * A reference to an id the context never contained is a fabricated citation.
 */
export function validateComposerReferences(
  output: ComposerOutput,
  context: ComposerReferenceContext,
): ReferenceGuardResult {
  const evidenceIds = new Set((context.evidenceMetadata ?? []).map((e) => e.id))
  const proxyIds = new Set((context.proxySummary ?? []).map((p) => p.id))
  const violations: ReferenceViolation[] = []

  output.evidence_references.forEach((ref, i) => {
    if (!evidenceIds.has(ref.evidenceId)) {
      violations.push({ id: ref.evidenceId, field: `evidence_references[${i}].evidenceId` })
    }
  })
  output.proxy_references.forEach((ref, i) => {
    if (!proxyIds.has(ref.proxyId)) {
      violations.push({ id: ref.proxyId, field: `proxy_references[${i}].proxyId` })
    }
  })

  return { ok: violations.length === 0, violations }
}

/** Structural subset of CalculationSnapshot (lib/stella/context/types.ts). */
export interface CalculationSnapshotLike {
  totalInvestment: number
  grossSocialValue: number
  netSocialValue: number
  sroiRatio: number
  lineItemCount?: number
  version?: number
  fundersBreakdown?: readonly {
    investmentUsd: number
    attributedNsvUsd: number
    sroiRatio: number
  }[]
  unattributedNsvUsd?: number
}

/**
 * Convenience builder: derives an AuthorizedNumbers set from the calculation
 * snapshot the Composer context carries. Callers should extend `additional`
 * with any other numeric context they included (filter percentages, counts…).
 */
export function authorizedNumbersFromSnapshot(
  snapshot: CalculationSnapshotLike,
  additional: readonly (string | number)[] = [],
): AuthorizedNumbers {
  const extra: (string | number)[] = [...additional]
  if (snapshot.lineItemCount !== undefined) extra.push(snapshot.lineItemCount)
  if (snapshot.version !== undefined) extra.push(snapshot.version)
  if (snapshot.unattributedNsvUsd !== undefined) extra.push(snapshot.unattributedNsvUsd)
  return {
    totals: {
      totalInvestment: snapshot.totalInvestment,
      grossSocialValue: snapshot.grossSocialValue,
      netSocialValue: snapshot.netSocialValue,
    },
    ratio: snapshot.sroiRatio,
    funderBreakdown: snapshot.fundersBreakdown?.map((row) => ({
      investmentUsd: row.investmentUsd,
      attributedNsvUsd: row.attributedNsvUsd,
      sroiRatio: row.sroiRatio,
    })),
    additional: extra,
  }
}

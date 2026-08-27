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
// NONE of the year/ordinal/section exemptions apply when the token sits in a
// VALUE-CLAIMING context — preceded by a ratio/value keyword (SROI, ratio,
// razón, retorno, valor, total, inversión) or a currency word/symbol (USD,
// COP, EUR, $, €, £), followed by a value marker (":1", "x", "veces", a
// currency word, "dólares", "pesos", "millones", "adicionales"), or carrying
// a '%' suffix. A number participating in a quantitative claim must ALWAYS
// trace to the authorized set, however small or year-like it looks:
// "el SROI es 7", "$2050" and "recibió 2019 adicionales" are validated, not
// exempted.
// 1. Calendar years: a plain 4-digit integer in 1900–2100 (no separators, no
//    decimals) outside value-claiming context. Covers "en 2026", "2025-2026".
// 2. Small integers / list ordinals: plain integers 0–20 outside
//    value-claiming context. Covers "3 outcomes", "paso 2", the "1" in
//    "3.2:1".
// 3. Section numbers: a short dotted token (e.g. "2.1", "3.4.1", 1–2 digit
//    components) that either starts a line and is followed by whitespace and
//    an UPPERCASE letter with no value marker after it ("2.1 Metodología" is
//    a heading; "3.2 veces la inversión" is NOT), or is immediately preceded
//    by the word "section"/"sección". A dotted token followed by ':' or '%'
//    or in value-claiming context is NEVER treated as a section number.
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

/**
 * `report-strict` is deliberately narrower than the Composer drafting mode:
 * persisted report prose must not turn an otherwise ordinary year or ordinal
 * into an untraceable outcome claim. It retains only deterministic structural
 * tokens (technical identifiers, headings, and an explicit SROI `:1`).
 */
export type NumericGuardMode = 'composer' | 'report-strict'

export interface NumericGuardOptions {
  mode?: NumericGuardMode
}

export interface ReferenceViolation {
  id: string
  field: string
}

export interface ReferenceGuardResult {
  ok: boolean
  violations: ReferenceViolation[]
}

/** Server-derived ids that a persisted report is allowed to cite. */
export interface NarrativeReferenceAuthority {
  evidenceIds: readonly string[]
  proxyIds: readonly string[]
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

// Signed digit runs with optional '.'/',' groups: -12 · 3.2 ·
// 1,600,000.50 · 2.1.3. The lookbehind keeps the numeric suffix of a
// technical identifier such as `ev-123` out of the claim scanner.
const NUMBER_TOKEN_RE = /(?<![A-Za-z0-9_+/-])[+-]?\d+(?:[.,]\d+)*/g

function toDecimal(v: string | number): Decimal | null {
  try {
    const d = new Decimal(v)
    return d.isFinite() ? d : null
  } catch {
    return null
  }
}

function collectAuthorized(authorized: AuthorizedNumbers | null): Decimal[] {
  if (!authorized) return []
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
    if (d) out.push(d)
  }
  return out
}

/**
 * Interpret a raw token under every plausible thousands/decimal-separator
 * convention. Returns normalized numeric strings (dot-decimal, no grouping).
 */
function normalizationCandidates(token: string): string[] {
  const candidates = new Set<string>()
  const sign = token.startsWith('-') || token.startsWith('+') ? token[0] : ''
  const unsignedToken = sign ? token.slice(1) : token
  const withSign = (value: string) => `${sign}${value}`
  const hasDot = unsignedToken.includes('.')
  const hasComma = unsignedToken.includes(',')

  if (hasDot && hasComma) {
    // The LAST separator that appears is the decimal separator.
    const lastDot = unsignedToken.lastIndexOf('.')
    const lastComma = unsignedToken.lastIndexOf(',')
    const decimalSep = lastDot > lastComma ? '.' : ','
    const groupSep = decimalSep === '.' ? ',' : '.'
    const cleaned = unsignedToken.split(groupSep).join('')
    candidates.add(withSign(decimalSep === '.' ? cleaned : cleaned.replace(',', '.')))
  } else if (hasComma) {
    if (/^\d{1,3}(,\d{3})+$/.test(unsignedToken)) candidates.add(withSign(unsignedToken.split(',').join(''))) // thousands
    if ((unsignedToken.match(/,/g) ?? []).length === 1) candidates.add(withSign(unsignedToken.replace(',', '.'))) // decimal comma
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(unsignedToken)) candidates.add(withSign(unsignedToken.split('.').join(''))) // es-LA thousands
    if ((unsignedToken.match(/\./g) ?? []).length === 1) candidates.add(withSign(unsignedToken)) // plain decimal
    // Multi-dot non-grouped tokens ("2.1.3") have no numeric interpretation.
  } else {
    candidates.add(withSign(unsignedToken))
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
      if (matchesAuthorizedValue(value, dp, authorized)) return true
      if (isPercentContext && matchesAuthorizedValue(value.div(100), dp + 2, authorized)) return true
    }
  }
  return false
}

const SECTION_TOKEN_RE = /^\d{1,2}(\.\d{1,2}){1,2}$/
const SECTION_KEYWORD_RE = /(?:secci[oó]n|section)\s*$/i

// Value-claiming context (audit FIX 1/2/3): a ratio/value keyword or currency
// marker just before the token, or a value marker just after it. Tokens in
// this context are NEVER exempted as years/ordinals/section numbers.
const VALUE_CLAIM_BEFORE_RE =
  /(?:\bSROI|\bratios?|\braz[oó]n|\bretornos?|\bvalor|\btotal|\binversi[oó]n|\bUSD|\bCOP|\bEUR|[$€£])\s*(?:de|del|es|era|fue|:|=)?\s*$/i
const VALUE_CLAIM_AFTER_RE =
  /^\s*(?::1\b|x\b|veces\b|USD\b|COP\b|EUR\b|d[oó]lares\b|pesos\b|millones\b|adicionales\b)/i

interface TokenSite {
  token: string
  isPercent: boolean
  allowlisted: boolean
}

function isExplicitSroiRatioDenominator(before: string, token: string): boolean {
  if (token !== '1') return false
  return /\b(?:sroi|ratios?|raz[oó]n|retornos?)\b[^\n]{0,80}[+-]?\d+(?:[.,]\d+)*:\s*$/i.test(before)
}

function extractTokens(text: string, mode: NumericGuardMode): TokenSite[] {
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

    // Value-claiming context — disables the year/ordinal/section exemptions.
    const inValueClaim =
      isPercent || VALUE_CLAIM_BEFORE_RE.test(before) || VALUE_CLAIM_AFTER_RE.test(after)

    // (4) identifier fragment: "ev-123", "SDG8", "v2.3", "#4", "out/7"
    const identifierAttached =
      /[A-Za-z_]/.test(prev) ||
      (['-', '/', '#'].includes(prev) && /[A-Za-z0-9_]/.test(prevPrev))

    // (1) calendar year / (2) small integer — plain integers only, and never
    // inside a value-claiming context ("$2050", "el SROI es 7").
    const isPlainInt = /^\d+$/.test(token)
    const intVal = isPlainInt ? parseInt(token, 10) : NaN
    const isYear =
      isPlainInt && !inValueClaim &&
      token.length === 4 && intVal >= YEAR_MIN && intVal <= YEAR_MAX
    const isOrdinal = isPlainInt && !inValueClaim && intVal <= MAX_ALLOWED_ORDINAL

    // (3) section number — heading must start with an UPPERCASE letter and
    // carry no value marker ("2.1 Metodología" yes, "3.2 veces" no).
    const atLineStart = /(?:^|\n)\s*$/.test(before)
    const headingFollows =
      /^\s+[A-ZÁÉÍÓÚÑÜ]/.test(after) && !VALUE_CLAIM_AFTER_RE.test(after)
    const isSectionNumber =
      SECTION_TOKEN_RE.test(token) &&
      next !== ':' &&
      !inValueClaim &&
      ((atLineStart && headingFollows) || SECTION_KEYWORD_RE.test(before))

    const strictStructuralToken =
      identifierAttached || isSectionNumber || isExplicitSroiRatioDenominator(before, token)

    sites.push({
      token,
      isPercent,
      allowlisted:
        mode === 'report-strict'
          ? strictStructuralToken
          : identifierAttached || isYear || isOrdinal || isSectionNumber,
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
  authorized: AuthorizedNumbers | null,
  options: NumericGuardOptions = {},
): NumericGuardResult {
  const mode = options.mode ?? 'composer'
  const authorizedValues = collectAuthorized(authorized)
  const violations: NumericViolation[] = []

  for (const { field, text } of freeTextFields(output)) {
    if (!text) continue
    for (const site of extractTokens(text, mode)) {
      if (site.allowlisted) continue
      if (tokenMatchesAuthorized(site.token, site.isPercent, authorizedValues)) continue
      violations.push({ token: site.token, field })
    }
  }

  return { ok: violations.length === 0, violations }
}

const NARRATIVE_REFERENCE_LABEL_RE =
  /\b(evidence|evidencia|proxy)\s*(?:id|identificador)?\s*[:=#]\s*([A-Za-z0-9][A-Za-z0-9_-]*)\b/gi
const NARRATIVE_REFERENCE_PREFIX_RE = /\b(ev|px)-([A-Za-z0-9][A-Za-z0-9_-]*)\b/gi

/**
 * Validates only the explicit citation forms Uellix actually exposes in its
 * Composer output/context: `ev-…` / `px-…`, or a labelled
 * `Evidence|Evidencia|Proxy ID: …`. This is intentionally not a generic
 * language parser: prose that merely mentions evidence or a proxy is not a
 * citation and is left to human review.
 */
export function validateNarrativeReferences(
  fields: readonly { field: string; text: string }[],
  authority: NarrativeReferenceAuthority,
): ReferenceGuardResult {
  const evidenceIds = new Set(authority.evidenceIds)
  const proxyIds = new Set(authority.proxyIds)
  const violations: ReferenceViolation[] = []
  const seen = new Set<string>()

  const validate = (id: string, type: 'evidence' | 'proxy', field: string) => {
    const key = `${field}:${type}:${id}`
    if (seen.has(key)) return
    seen.add(key)
    if (!(type === 'evidence' ? evidenceIds : proxyIds).has(id)) {
      violations.push({ id, field })
    }
  }

  for (const { field, text } of fields) {
    for (const match of text.matchAll(NARRATIVE_REFERENCE_LABEL_RE)) {
      const type = /^(evidence|evidencia)$/i.test(match[1]) ? 'evidence' : 'proxy'
      validate(match[2], type, field)
    }
    for (const match of text.matchAll(NARRATIVE_REFERENCE_PREFIX_RE)) {
      const type = match[1].toLowerCase() === 'ev' ? 'evidence' : 'proxy'
      validate(match[0], type, field)
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

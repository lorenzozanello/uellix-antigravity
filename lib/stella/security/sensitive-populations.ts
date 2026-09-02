// lib/stella/security/sensitive-populations.ts
// WS3c U1 (RK-08): pure, deterministic sensitive-populations detector.
//
// Scans already-queried project metadata (stakeholder group types/names,
// narrative text, outcome titles) for indicators that the project works with
// populations requiring heightened care. The result is a boolean flag plus
// the matched category ids — it is used ONLY to (a) activate a fixed
// heightened-care notice in the TRUSTED prompt tier and (b) annotate audit
// metadata. It never blocks a request and never reaches the untrusted
// envelope as instructions.
//
// Matching rules:
// - Case-insensitive.
// - Accent-insensitive for combining accents (á/é/í/ó/ú/ü → a/e/i/o/u), but
//   'ñ' is preserved as a distinct letter: 'niñ' must match 'niños'/'niñez'
//   while NEVER matching common words like 'ninguna' or 'campaña'.
// - Word-boundary-aware at the keyword start: keywords are stems that must
//   begin a word ('menor' matches 'menores'; 'child' matches 'children').
// - Multi-word phrases match across collapsed whitespace.
//
// Pure module: no imports from db/, no env access, no I/O.

export const SENSITIVE_POPULATION_CATEGORIES = [
  'minors',
  'refugees_displaced',
  'violence_victims',
  'health_conditions',
  'extreme_poverty',
] as const

export type SensitivePopulationCategory = (typeof SENSITIVE_POPULATION_CATEGORIES)[number]

export interface SensitivePopulationSignals {
  /** stakeholder_groups.type values (already queried by the builders). */
  stakeholderTypes: string[]
  /** Free-text metadata already in scope: names, narrative, outcome titles. */
  texts: (string | null | undefined)[]
}

export interface SensitivePopulationsResult {
  detected: boolean
  categories: string[]
}

// ES + EN keyword stems per category. Stems are matched at word starts only.
const CATEGORY_KEYWORDS: Record<SensitivePopulationCategory, readonly string[]> = {
  minors: ['menor', 'niñ', 'adolescen', 'infancia', 'child'],
  refugees_displaced: ['refugiad', 'desplazad', 'migrant'],
  violence_victims: ['víctima', 'violencia', 'abuso', 'gbv'],
  health_conditions: ['salud mental', 'vih', 'discapacidad', 'enfermedad'],
  extreme_poverty: ['pobreza extrema', 'habitante de calle'],
}

// Placeholder that survives NFD + combining-mark stripping so 'ñ' stays a
// distinct letter (see module header). U+0001 never appears in normal text
// (the context sanitizers strip control characters anyway).
const ENYE_PLACEHOLDER = String.fromCharCode(1)
const ENYE_PLACEHOLDER_PATTERN = new RegExp(ENYE_PLACEHOLDER, 'g')

/**
 * Normalize text for matching: lowercase, strip combining accents while
 * preserving 'ñ', collapse all whitespace runs to single spaces.
 */
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/ñ/g, ENYE_PLACEHOLDER)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(ENYE_PLACEHOLDER_PATTERN, 'ñ')
    .replace(/\s+/g, ' ')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Precompiled matchers: keyword stem anchored at a word start. Letters and
// digits (Unicode-aware, so 'ñ' and accented letters count) block the
// boundary; anything else (start, space, punctuation) opens it.
const CATEGORY_MATCHERS: ReadonlyArray<{ category: SensitivePopulationCategory; patterns: RegExp[] }> =
  SENSITIVE_POPULATION_CATEGORIES.map((category) => ({
    category,
    patterns: CATEGORY_KEYWORDS[category].map(
      (keyword) => new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(normalizeForMatch(keyword))}`, 'u'),
    ),
  }))

/**
 * Detect sensitive-population indicators in already-available project
 * metadata. Deterministic and side-effect free. Categories are returned in
 * fixed taxonomy order, deduplicated.
 */
export function detectSensitivePopulations(
  signals: SensitivePopulationSignals,
): SensitivePopulationsResult {
  const corpus: string[] = []
  for (const value of [...signals.stakeholderTypes, ...signals.texts]) {
    if (typeof value === 'string' && value.length > 0) {
      corpus.push(normalizeForMatch(value))
    }
  }

  if (corpus.length === 0) return { detected: false, categories: [] }

  const categories: string[] = []
  for (const { category, patterns } of CATEGORY_MATCHERS) {
    const hit = corpus.some((text) => patterns.some((pattern) => pattern.test(text)))
    if (hit) categories.push(category)
  }

  return { detected: categories.length > 0, categories }
}

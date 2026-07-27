// lib/stella/context/sensitive-population.ts
// Etapa A2.3 (STL-A23-002 a 005, DR-002/DR-003 aprobados 2026-07-26). Capa
// determinista que decide si texto relacionado con MENORES o SALUD puede
// enviarse a Stella: solo si es agregado, con un tamaño de grupo explícito y
// confiable (>= MINIMUM_SENSITIVE_GROUP_SIZE), sin identificadores directos
// y sin una combinación de cuasi-identificadores que permita razonablemente
// aislar a una persona.
//
// LIMITACIÓN DOCUMENTADA (no oculta): el modelo de datos de Uellix hoy NO
// tiene ningún campo estructurado y confiable de "tamaño de grupo" — ni en
// `stakeholder_groups` (solo name/description/type, sin conteo de
// personas), ni en `indicators`/`outcomes` (baseline/target/actualValue son
// varchar libre). Confirmado por inventario exhaustivo antes de escribir
// este archivo (ver STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md#3-4). Por
// tanto, NINGÚN context builder de hoy puede producir una
// `AggregateDataDeclaration` válida — la única fuente sería una función de
// autorización futura, humana, conectada a datos reales (Etapa A2.3 diseña
// esa migración pero deliberadamente NO la aplica — STL-A23-009/010 —
// porque no existe ningún productor real de esa información hoy). El efecto
// práctico HOY es: cualquier mención de datos agregados de menores/salud sin
// una declaración (que nunca existe) se bloquea con `aggregate_unknown_size`
// — exactamente el comportamiento fail-closed que la decisión aprobada
// exige mientras no exista un mecanismo verificado.
//
// Esta es una defensa INICIAL y CONSERVADORA, no una garantía matemática de
// anonimización — documentado explícitamente, nunca presentado como
// cumplimiento legal.
//
// Calibración deliberada: el clasificador NO se dispara con lenguaje
// temático normal de SROI (p. ej. un outcome llamado "Mejora en salud
// mental de jóvenes" NO es sensible por sí solo — es la etiqueta de un
// programa, no un dato sobre personas). Se dispara cuando el texto declara
// una MENCIÓN DE DATOS (un número, en dígitos o en palabras, junto a un
// sustantivo poblacional: "50 niños", "cincuenta pacientes") o cuando ya
// existe una señal individual (reutiliza detectHighRiskPii de DR-001, sin
// duplicar su lógica).

import { detectHighRiskPii } from './pii-detection'
import { MINIMUM_SENSITIVE_GROUP_SIZE } from '../aggregation/policy'

// Re-exported for backward compatibility — lib/stella/aggregation/policy.ts
// is now the single source of truth (Etapa A2.3.1, STL-A231-007); this file
// no longer redeclares the literal.
export { MINIMUM_SENSITIVE_GROUP_SIZE }

export type SensitivePopulationCategory = 'none' | 'minors' | 'health' | 'minors_and_health'

export type AggregationStatus =
  | 'not_applicable'
  | 'individual'
  | 'aggregate_valid'
  | 'aggregate_below_threshold'
  | 'aggregate_unknown_size'
  | 'free_text_prohibited'
  | 'reidentification_risk'

/** Taxonomía fija de cuasi-identificadores — no una lista de palabras desestructurada. */
export const QUASI_IDENTIFIER_CATEGORIES = {
  exactAge: 'exact_age',
  exactDate: 'exact_date',
  gradeOrCourse: 'grade_or_course',
  specificInstitution: 'specific_institution',
  smallLocality: 'small_locality',
  rareHealthCondition: 'rare_health_condition',
  genderMention: 'gender_mention',
  narrowTimePeriod: 'narrow_time_period',
  individualNarrative: 'individual_narrative',
  familyRoleOrPosition: 'family_role_or_position',
  stableInternalId: 'stable_internal_id',
} as const

export interface AggregateDataDeclaration {
  sensitiveCategory: 'minors' | 'health' | 'minors_and_health'
  aggregationLevel: 'aggregate'
  /** Entero positivo. Debe provenir de una fuente del sistema — nunca de una afirmación en texto libre o del modelo. */
  groupSize: number
  dimensions: string[]
  sourceEntityType: string
  sourceEntityId: string
}

export interface SensitiveDataAssessment {
  category: SensitivePopulationCategory
  aggregationStatus: AggregationStatus
  groupSize?: number
  minimumGroupSize: number
  directIdentifierCategories: string[]
  quasiIdentifierCategories: string[]
  allowed: boolean
  reasonCode: string
}

// ---------------------------------------------------------------------------
// Códigos de razón fijos — única fuente de verdad, reutilizada por
// context-guardrails.ts (vía StellaContextGuardrailError.code) y por los 4
// server actions de Stella para mapear a un StellaXErrorCode distinto y a un
// mensaje no filtrante, sin volver a analizar el mensaje de error como texto.
export const SENSITIVE_DATA_REASON_CODES = {
  individualBlocked: 'SENSITIVE_INDIVIDUAL_DATA_BLOCKED',
  groupSizeRequired: 'SENSITIVE_GROUP_SIZE_REQUIRED',
  groupTooSmall: 'SENSITIVE_GROUP_TOO_SMALL',
  reidentificationRisk: 'SENSITIVE_REIDENTIFICATION_RISK',
  freeTextBlocked: 'SENSITIVE_FREE_TEXT_BLOCKED',
} as const

export type SensitiveDataBlockingReasonCode =
  (typeof SENSITIVE_DATA_REASON_CODES)[keyof typeof SENSITIVE_DATA_REASON_CODES]

/** Non-leaky, user-facing messages — never reference the matched text, only the fixed category. */
// Etapa A2.3.2 (STL-A232-015): mensajes reescritos como INSTRUCCIÓN
// accionable para quien ve el bloqueo, no solo como descripción del
// problema — nunca exponen el texto detectado, una edad, una institución,
// un diagnóstico ni ningún otro dato del contenido bloqueado.
//
// Limitación documentada, no oculta: `groupSizeRequired` cubre varias
// causas de fondo distintas a nivel de base de datos (nunca se declaró
// nada, la declaración sigue `pending`, fue `revoked`, o quedó
// `outdated_policy`) bajo un único código — assessSensitiveData() (el
// clasificador de TEXTO puro) solo sabe "hay o no hay una declaración
// VERIFICADA y vigente ahora mismo", no la razón exacta por la que no la
// hay. Distinguir esas causas en el mensaje requeriría propagar el estado
// exacto de declaration-query.ts hasta este módulo de texto — un cambio de
// arquitectura mayor, no justificado solo para una mejora de redacción.
// Documentado aquí en vez de fingir una distinción que el código no hace.
export const SENSITIVE_DATA_BLOCK_MESSAGES: Record<SensitiveDataBlockingReasonCode, string> = {
  [SENSITIVE_DATA_REASON_CODES.individualBlocked]:
    'Este contenido identifica a una persona individual dentro de una población de menores o de salud. Elimina el dato individual o redáctalo como un agregado antes de usar Stella.',
  [SENSITIVE_DATA_REASON_CODES.groupSizeRequired]:
    'Este contenido hace referencia a menores o a información de salud y no tiene una declaración de agregación verificada y vigente. Un administrador de la organización debe registrar y verificar el tamaño y las dimensiones del grupo antes de continuar.',
  [SENSITIVE_DATA_REASON_CODES.groupTooSmall]:
    `El grupo mencionado no alcanza el tamaño mínimo de agregación (${MINIMUM_SENSITIVE_GROUP_SIZE}). Agrupa categorías, amplía el período, o excluye este dato hasta contar con un grupo más grande.`,
  [SENSITIVE_DATA_REASON_CODES.reidentificationRisk]:
    'La combinación de datos en este contenido podría permitir identificar a una persona específica. Reduce el nivel de detalle (por ejemplo, quita una de las dimensiones combinadas) antes de continuar.',
  [SENSITIVE_DATA_REASON_CODES.freeTextBlocked]:
    'Este contenido incluye una narrativa o testimonio individual sobre una población de menores o de salud. Sustitúyelo por una descripción agregada, sin relatos de una persona específica.',
}

// ---------------------------------------------------------------------------
// Evasion hardening (STL-A23-014, adversarial): zero-width and other
// invisible Unicode characters can be inserted between a number and a
// population noun, or between other tokens, to defeat a \s-based regex
// boundary (e.g. "50<ZWSP>niños"). All detection below runs against a
// normalized copy of the input; the ORIGINAL text is never stored by this
// module either way (see the no-storage invariant in the header comment).
// ---------------------------------------------------------------------------

const INVISIBLE_CHARS_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u200B-\\u200D\\uFEFF\\u00AD]',
  'g',
)

function normalizeForDetection(text: string): string {
  // Replaced with a SPACE, not deleted: deleting would merge adjacent tokens
  // that were only ever separated by the invisible character (e.g. "5<ZWSP>0"
  // must not become the digit sequence "50"), while a space safely restores
  // the word boundary the evasion attempt tried to hide (e.g.
  // "50<ZWSP>niños" becomes "50 niños", which the existing \s-based patterns
  // already handle correctly).
  return text.replace(INVISIBLE_CHARS_RE, ' ')
}

// ---------------------------------------------------------------------------
// Detección de mención agregada (número + sustantivo poblacional). Incluye
// números escritos en palabras (caso adversarial explícito) — lista
// deliberadamente acotada a los términos más comunes en es/en, no
// exhaustiva; documentado como límite conocido, no oculto.
// ---------------------------------------------------------------------------

const NUMBER_WORD =
  '(?:uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)'

/** Resolves a number token (digits or spelled-out, es/en) to its integer value for the declared-vs-mentioned cross-check below. */
const NUMBER_WORD_VALUES: Record<string, number> = {
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
}

function parseNumberToken(token: string): number | null {
  const asDigits = Number(token)
  if (!Number.isNaN(asDigits)) return asDigits
  const asWord = NUMBER_WORD_VALUES[token.toLowerCase()]
  return asWord ?? null
}

const MINORS_POPULATION_NOUN =
  '(?:ni[ñn][oa]s?|menores(?:\\s+de\\s+edad)?|estudiantes?|alumn[oa]s?|j[oó]venes|children|minors?|students?|pupils?|youths?)'

const HEALTH_POPULATION_NOUN = '(?:pacientes?|casos(?:\\s+cl[ií]nicos)?|diagn[oó]sticos?|patients?|cases|diagnoses)'

const MINORS_AGGREGATE_MENTION_RE = new RegExp(`\\b(\\d+|${NUMBER_WORD})\\s+${MINORS_POPULATION_NOUN}\\b`, 'i')
const HEALTH_AGGREGATE_MENTION_RE = new RegExp(`\\b(\\d+|${NUMBER_WORD})\\s+${HEALTH_POPULATION_NOUN}\\b`, 'i')

/** Returns the integer the FIRST aggregate-mention match names, or null if the pattern didn't match or the token couldn't be parsed. */
function extractMentionedCount(text: string, re: RegExp): number | null {
  const match = re.exec(text)
  if (!match) return null
  return parseNumberToken(match[1])
}

// Sin exigir un número — deliberadamente MÁS AMPLIO que las menciones
// agregadas de arriba. Nunca se usa por sí solo para bloquear (bloquearía
// lenguaje temático normal de SROI); solo sirve para nombrar la categoría
// cuando YA se detectó un marcador de narrativa individual (ver
// INDIVIDUAL_NARRATIVE_RE / QUASI_IDENTIFIER_CATEGORIES.individualNarrative
// más abajo) — un testimonio en primera persona sobre salud/menores es
// sensible aunque no incluya una edad exacta o un verbo de diagnóstico.
const MINORS_THEMATIC_RE = new RegExp(`\\b${MINORS_POPULATION_NOUN}\\b`, 'i')
const HEALTH_THEMATIC_RE = new RegExp(`\\b${HEALTH_POPULATION_NOUN}\\b`, 'i')

function detectAggregateMention(text: string): { minors: boolean; health: boolean } {
  return {
    minors: MINORS_AGGREGATE_MENTION_RE.test(text),
    health: HEALTH_AGGREGATE_MENTION_RE.test(text),
  }
}

function detectThematicMention(text: string): { minors: boolean; health: boolean } {
  return {
    minors: MINORS_THEMATIC_RE.test(text),
    health: HEALTH_THEMATIC_RE.test(text),
  }
}

function detectIndividualSignals(text: string): { minors: boolean; health: boolean } {
  const matches = detectHighRiskPii(text)
  return {
    minors: matches.some((m) => m.category === 'minorIdentifiable'),
    health: matches.some((m) => m.category === 'individualHealth'),
  }
}

// ---------------------------------------------------------------------------
// Cuasi-identificadores — regla conservadora inicial, explicable, NO una
// resolución matemática de anonimización.
// ---------------------------------------------------------------------------

const EXACT_AGE_RE = /\b\d{1,3}\s*(años|years?\s*old)\b/i
const EXACT_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/
const GRADE_OR_COURSE_RE = /\b(grado|grade|curso|course)\s*\d+\b/i
const SPECIFIC_INSTITUTION_RE = /\b(escuela|colegio|instituci[oó]n|hospital|cl[ií]nica|school|institution|clinic)\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ'-]+/i
const SMALL_LOCALITY_RE = /\b(barrio|vereda|corregimiento|neighbou?rhood)\s+[A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ'-]+/i
const RARE_HEALTH_CONDITION_RE = /\b(VIH|SIDA|c[aá]ncer|leucemia|s[ií]ndrome|trastorno\s+\w+|enfermedad\s+rara|cancer|leukemia|syndrome|rare\s+disease)\b/i
const GENDER_MENTION_RE = /\b(ni[ñn]as|ni[ñn]os|mujeres|hombres|girls?|boys?|women|men)\b/i
const NARROW_TIME_PERIOD_RE =
  /\b(entre\s+el\s+\d{1,2}\s+y\s+\d{1,2}\s+de\s+\w+|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}|en\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+\d{4})\b/i
const INDIVIDUAL_NARRATIVE_RE = /["“][^"”]{15,}["”]|\b(yo\s+(?:soy|tengo|fui)|mi\s+\w+|i\s+am|my\s+\w+)\b/i
const FAMILY_ROLE_RE = /\b(madre\s+de|padre\s+de|hij[oa]\s+de|mother\s+of|father\s+of|son\s+of|daughter\s+of)\b/i
const STABLE_INTERNAL_ID_RE = /\b\d{6,12}\b/

function detectQuasiIdentifiers(text: string): string[] {
  const found: string[] = []
  if (EXACT_AGE_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.exactAge)
  if (EXACT_DATE_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.exactDate)
  if (GRADE_OR_COURSE_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.gradeOrCourse)
  if (SPECIFIC_INSTITUTION_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.specificInstitution)
  if (SMALL_LOCALITY_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.smallLocality)
  if (RARE_HEALTH_CONDITION_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.rareHealthCondition)
  if (GENDER_MENTION_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.genderMention)
  if (NARROW_TIME_PERIOD_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.narrowTimePeriod)
  if (INDIVIDUAL_NARRATIVE_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.individualNarrative)
  if (FAMILY_ROLE_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.familyRoleOrPosition)
  if (STABLE_INTERNAL_ID_RE.test(text)) found.push(QUASI_IDENTIFIER_CATEGORIES.stableInternalId)
  return found
}

// ---------------------------------------------------------------------------
// Contrato de datos agregados — validación estructural estricta. Verifica
// FORMA, no verdad semántica: confirmar que `groupSize` corresponde
// realmente a `sourceEntityId` es responsabilidad de quien construye la
// declaración (un flujo humano futuro, no implementado hoy — ver limitación
// de cabecera), nunca de esta función pura. Un objeto con campos extra (por
// ejemplo un intento de "campo señuelo" como `bypassGuardrail: true`) no
// otorga ningún privilegio: solo los campos listados aquí se leen.
// ---------------------------------------------------------------------------

export function isValidAggregateDeclaration(value: unknown): value is AggregateDataDeclaration {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.aggregationLevel !== 'aggregate') return false
  if (v.sensitiveCategory !== 'minors' && v.sensitiveCategory !== 'health' && v.sensitiveCategory !== 'minors_and_health') {
    return false
  }
  if (typeof v.groupSize !== 'number' || !Number.isInteger(v.groupSize) || v.groupSize <= 0) return false
  if (!Array.isArray(v.dimensions)) return false
  if (typeof v.sourceEntityType !== 'string' || v.sourceEntityType.trim().length === 0) return false
  if (typeof v.sourceEntityId !== 'string' || v.sourceEntityId.trim().length === 0) return false
  return true
}

function declarationCoversCategory(declaration: AggregateDataDeclaration, category: SensitivePopulationCategory): boolean {
  if (category === 'minors_and_health') return declaration.sensitiveCategory === 'minors_and_health'
  return declaration.sensitiveCategory === category || declaration.sensitiveCategory === 'minors_and_health'
}

// ---------------------------------------------------------------------------
// Evaluación principal — pura, fail-closed, nunca llama al modelo, nunca
// persiste el valor detectado (solo categorías/estados en el resultado).
// ---------------------------------------------------------------------------

export function assessSensitiveData(text: string, declaration?: unknown): SensitiveDataAssessment {
  const normalized = normalizeForDetection(text)

  const individual = detectIndividualSignals(normalized)
  const aggregateMention = detectAggregateMention(normalized)
  const quasiIdentifiers = detectQuasiIdentifiers(normalized)
  const hasNarrativeMarker = quasiIdentifiers.includes(QUASI_IDENTIFIER_CATEGORIES.individualNarrative)
  const thematic = hasNarrativeMarker ? detectThematicMention(normalized) : { minors: false, health: false }

  const hasMinors = individual.minors || aggregateMention.minors || thematic.minors
  const hasHealth = individual.health || aggregateMention.health || thematic.health

  const category: SensitivePopulationCategory = hasMinors && hasHealth
    ? 'minors_and_health'
    : hasMinors
      ? 'minors'
      : hasHealth
        ? 'health'
        : 'none'

  if (category === 'none') {
    return {
      category: 'none',
      aggregationStatus: 'not_applicable',
      minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
      directIdentifierCategories: [],
      quasiIdentifierCategories: [],
      allowed: true,
      reasonCode: 'NO_SENSITIVE_POPULATION_DETECTED',
    }
  }

  // Señales individuales (reutilizadas de DR-001) siempre bloquean, sin
  // importar ninguna declaración de agregación.
  if (individual.minors || individual.health) {
    return {
      category,
      aggregationStatus: 'individual',
      minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
      directIdentifierCategories: [
        ...(individual.minors ? ['minor_identifiable'] : []),
        ...(individual.health ? ['individual_health'] : []),
      ],
      quasiIdentifierCategories: [],
      allowed: false,
      reasonCode: SENSITIVE_DATA_REASON_CODES.individualBlocked,
    }
  }

  // Una narrativa/testimonio individual sobre una población sensible se
  // prohíbe aunque no contenga una edad o diagnóstico exacto detectable.
  if (hasNarrativeMarker) {
    return {
      category,
      aggregationStatus: 'free_text_prohibited',
      minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
      directIdentifierCategories: [],
      quasiIdentifierCategories: quasiIdentifiers,
      allowed: false,
      reasonCode: SENSITIVE_DATA_REASON_CODES.freeTextBlocked,
    }
  }

  // 2+ dimensiones de cuasi-identificador co-ocurrentes bloquean incluso con
  // un tamaño de grupo válido — regla conservadora, no matemáticamente
  // exhaustiva.
  if (quasiIdentifiers.length >= 2) {
    return {
      category,
      aggregationStatus: 'reidentification_risk',
      minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
      directIdentifierCategories: [],
      quasiIdentifierCategories: quasiIdentifiers,
      allowed: false,
      reasonCode: SENSITIVE_DATA_REASON_CODES.reidentificationRisk,
    }
  }

  // Mención agregada detectada — nunca se confía en el texto libre para el
  // tamaño del grupo. Se exige una declaración estructural válida,
  // consistente con la categoría detectada.
  if (!isValidAggregateDeclaration(declaration) || !declarationCoversCategory(declaration, category)) {
    return {
      category,
      aggregationStatus: 'aggregate_unknown_size',
      minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
      directIdentifierCategories: [],
      quasiIdentifierCategories: quasiIdentifiers,
      allowed: false,
      reasonCode: SENSITIVE_DATA_REASON_CODES.groupSizeRequired,
    }
  }

  // Declared-vs-mentioned cross-check (STL-A23-014, adversarial): a
  // declaration is only trustworthy if it agrees with whatever count the
  // text itself names. Without this, an attacker could pair a small real
  // mention ("5 niños") with a large declared groupSize (or vice versa) to
  // smuggle an unverifiable claim past the threshold check below.
  const mentionedCount =
    extractMentionedCount(normalized, MINORS_AGGREGATE_MENTION_RE) ??
    extractMentionedCount(normalized, HEALTH_AGGREGATE_MENTION_RE)
  if (mentionedCount !== null && mentionedCount !== declaration.groupSize) {
    return {
      category,
      aggregationStatus: 'aggregate_unknown_size',
      minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
      directIdentifierCategories: [],
      quasiIdentifierCategories: quasiIdentifiers,
      allowed: false,
      reasonCode: SENSITIVE_DATA_REASON_CODES.groupSizeRequired,
    }
  }

  if (declaration.groupSize < MINIMUM_SENSITIVE_GROUP_SIZE) {
    return {
      category,
      aggregationStatus: 'aggregate_below_threshold',
      groupSize: declaration.groupSize,
      minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
      directIdentifierCategories: [],
      quasiIdentifierCategories: quasiIdentifiers,
      allowed: false,
      reasonCode: SENSITIVE_DATA_REASON_CODES.groupTooSmall,
    }
  }

  return {
    category,
    aggregationStatus: 'aggregate_valid',
    groupSize: declaration.groupSize,
    minimumGroupSize: MINIMUM_SENSITIVE_GROUP_SIZE,
    directIdentifierCategories: [],
    quasiIdentifierCategories: quasiIdentifiers,
    allowed: true,
    reasonCode: 'SENSITIVE_AGGREGATE_ALLOWED',
  }
}

// tests/eval/stella-release/matrix.ts
// RELEASE line — versioned evaluation matrix
// (STELLA_RELEASE_EVALUATION_FOUNDATION_TRAIN_1, Fase 2).
//
// One entry per required case category (see docs/ops/workstreams/RELEASE.md
// §Matriz de evaluación for the narrative version). harness.ts implements
// exactly one check function per `checkId` below; harness.test.ts and
// scripts/eval-release-offline.ts both run the full matrix and assert it
// stays in sync via `validateReleaseEvalMatrix`.
//
// No metric here is a fabricated number: entries whose measurement needs a
// real provider call are marked `offlineMeasurable: false` with the reason
// in `offlineLimitation`, per the instruction not to invent final metrics
// without a baseline.

export const RELEASE_EVAL_MATRIX_VERSION = '1.0.0'

export type ReleaseEvalMetric =
  | 'citation-precision'
  | 'citation-coverage'
  | 'unsupported-claim-rate'
  | 'abstention-correctness'
  | 'isolation-violations'
  | 'latency'
  | 'token-usage'
  | 'estimated-provider-cost'
  | 'structural-regression'

export type ReleaseEvalCategory =
  | 'evidencia-suficiente'
  | 'evidencia-insuficiente'
  | 'contradiccion'
  | 'cita-correcta'
  | 'cita-incorrecta'
  | 'documento-malicioso'
  | 'aislamiento-cross-organization'
  | 'aislamiento-cross-project'
  | 'abstencion'
  | 'provider-unavailable'
  | 'cuota-agotada'
  | 'reintento'
  | 'decision-humana'
  | 'regresion-cap-01-a-cap-05'

export interface ReleaseEvalMatrixEntry {
  checkId: string
  category: ReleaseEvalCategory
  description: string
  /** Metric(s) this check feeds — see harness.ts computeReleaseMetrics(). */
  metrics: readonly ReleaseEvalMetric[]
  /** Measurable fully offline today, vs. requires gate G1 (real provider). */
  offlineMeasurable: boolean
  /** Required and validated when offlineMeasurable is false. */
  offlineLimitation?: string
}

export const RELEASE_EVAL_MATRIX: readonly ReleaseEvalMatrixEntry[] = [
  {
    checkId: 'sufficient-evidence-citation-resolves',
    category: 'evidencia-suficiente',
    description:
      'Con evidencia real en el contexto (organization-alpha, paso "evidence"), una respuesta que cita un sourceRefIndexes válido decodifica y resuelve a una ruta real del catálogo de esa solicitud.',
    metrics: ['citation-precision', 'citation-coverage'],
    offlineMeasurable: true,
  },
  {
    checkId: 'insufficient-evidence-empty-sentinel',
    category: 'evidencia-insuficiente',
    description:
      'Con contexto sin evidencia/resultados, el catálogo de citas de esa solicitud sólo contiene sentinelas ".empty"; una respuesta que igual inventa un finding sin evidencia real (cita fuera de rango) es rechazada.',
    metrics: ['unsupported-claim-rate', 'abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'contradiction-acknowledgment-heuristic',
    category: 'contradiccion',
    description:
      'Con evidencia contradictoria (una aprobada, una rechazada, sin narrativa que lo reconozca), un detector heurístico de palabras clave mide si el texto libre de una respuesta reconoce la tensión.',
    metrics: ['unsupported-claim-rate'],
    offlineMeasurable: false,
    offlineLimitation:
      'Sin proveedor real no hay generación de texto que evaluar más allá de fixtures pre-escritos; el detector heurístico sólo mide presencia de palabras clave, no comprensión semántica de la contradicción. Grading real requiere gate G1.',
  },
  {
    checkId: 'citation-correct-decodes',
    category: 'cita-correcta',
    description:
      'sourceRefIndexes en rango, sin exceder MAX_SOURCE_REFS_PER_ITEM → decodeProviderSourceRefIndexes acepta y produce sourceFields resueltos correctamente.',
    metrics: ['citation-precision'],
    offlineMeasurable: true,
  },
  {
    checkId: 'citation-incorrect-rejected',
    category: 'cita-incorrecta',
    description:
      'Tres variantes deben ser rechazadas: índice fuera de rango (ProviderSourceRefIndexesError), token de índice desnudo filtrado en texto libre (ContextualIndexTokenLeakError), y exceso de referencias distintas por ítem.',
    metrics: ['citation-precision', 'unsupported-claim-rate'],
    offlineMeasurable: true,
  },
  {
    checkId: 'malicious-document-envelope-holds',
    category: 'documento-malicioso',
    description:
      'Un título de evidencia con payload de inyección de prompt se serializa dentro del envelope UNTRUSTED_PROJECT_DATA como JSON de una sola línea (no puede romper el envelope ni falsificar el marcador), y el detector de patrones prohibidos existente lo marca.',
    metrics: ['isolation-violations'],
    offlineMeasurable: true,
  },
  {
    checkId: 'cross-organization-no-leak',
    category: 'aislamiento-cross-organization',
    description:
      'Una solicitud construida para organization-alpha nunca contiene el marcador único de organization-beta (ni viceversa) en systemPrompt, contexto serializado o catálogo de rutas citables. Chequeo estructural de capa de aplicación.',
    metrics: ['isolation-violations'],
    offlineMeasurable: true,
    offlineLimitation:
      'Verifica higiene de los context builders de aplicación, no las policies RLS reales de Postgres — eso es gate G3 (tests/integration/rls.test.ts, propiedad de CAPABILITIES), fuera del alcance de esta línea. No se marca offlineMeasurable=false porque el chequeo estructural sí corre offline; la limitación es de alcance, no de ejecutabilidad.',
  },
  {
    checkId: 'cross-project-no-leak',
    category: 'aislamiento-cross-project',
    description:
      'Dos proyectos de la misma organización nunca comparten contexto en una única solicitud: el projectId de la solicitud siempre coincide con el del contexto de entrada, y el marcador exclusivo del segundo proyecto nunca aparece en la solicitud del primero.',
    metrics: ['isolation-violations'],
    offlineMeasurable: true,
  },
  {
    checkId: 'abstention-schema-enforced',
    category: 'abstencion',
    description:
      'requiresHumanReview/requires_human_review es z.literal(true) en los contratos de rol con enforcement de esquema (validator, reviewer, advisor contextual); una respuesta con valor false es rechazada por el esquema — no por heurística — y una respuesta de abstención genuina (sin findings/suggestions, con clarifyingQuestions) sí es aceptada.',
    metrics: ['abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'provider-unavailable-presentation',
    category: 'provider-unavailable',
    description:
      'GEMINI_ERROR y TIMEOUT se presentan como retryable=true, tono "error"/"warning", sin fragmentos de secretos en la descripción (stellaErrorPresentation, components/stella/error-messages.ts).',
    metrics: ['latency'],
    offlineMeasurable: true,
  },
  {
    checkId: 'quota-exhausted-non-retryable',
    category: 'cuota-agotada',
    description:
      'QUOTA_EXCEEDED se presenta como retryable=false, tono "warning", con el mensaje del servidor mostrado verbatim (incluye cuota, uso y fecha de reset).',
    metrics: ['abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'retryable-code-set-pinned',
    category: 'reintento',
    description:
      'El conjunto exacto de códigos reintentables (RATE_LIMIT_UNAVAILABLE, TIMEOUT, PARSE_ERROR, GEMINI_ERROR) y no reintentables (los 8 restantes de los 12 códigos documentados) queda fijado como regresión: un cambio de semántica de reintento en components/stella/error-messages.ts rompe este check.',
    metrics: ['latency'],
    offlineMeasurable: true,
  },
  {
    checkId: 'human-decision-literal-true',
    category: 'decision-humana',
    description:
      'ValidatorOutputSchema y ReviewerOutputSchema rechazan requires_human_review=false; ninguna combinación de otros campos válidos lo compensa (probado con canaries reales, no con una aserción de forma).',
    metrics: ['abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'cap-01-05-regression-surface-present',
    category: 'regresion-cap-01-a-cap-05',
    description:
      'Presencia estructural (offline, sin ejecutar el gate pesado de CAPABILITIES): los 5 paquetes db/prepared/stella_00XX_*.sql de CAP-01..CAP-05 y su rollback existen en disco; los archivos de test de regresión de CAPABILITIES (capability-mutation.test.ts, capability-isolation.test.ts, capability-policy-contract.test.ts) existen y están fuera del glob de integración, por lo que pnpm test:unit ya los ejercita en cada corrida. Esta línea NO ejecuta esos tests aquí — son gate de CAPABILITIES — sólo confirma que la superficie de regresión sigue presente.',
    metrics: ['structural-regression'],
    offlineMeasurable: true,
  },
] as const

const REQUIRED_CATEGORIES: readonly ReleaseEvalCategory[] = [
  'evidencia-suficiente',
  'evidencia-insuficiente',
  'contradiccion',
  'cita-correcta',
  'cita-incorrecta',
  'documento-malicioso',
  'aislamiento-cross-organization',
  'aislamiento-cross-project',
  'abstencion',
  'provider-unavailable',
  'cuota-agotada',
  'reintento',
  'decision-humana',
  'regresion-cap-01-a-cap-05',
]

export class ReleaseEvalMatrixError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ReleaseEvalMatrixError'
  }
}

/** Fails closed on duplicate/missing checkIds, undeclared limitations, or missing categories. */
export function validateReleaseEvalMatrix(matrix: readonly ReleaseEvalMatrixEntry[]): void {
  const seen = new Set<string>()
  for (const entry of matrix) {
    if (!entry.checkId || seen.has(entry.checkId)) {
      throw new ReleaseEvalMatrixError(`duplicated or missing checkId: "${entry.checkId}"`)
    }
    seen.add(entry.checkId)
    if (!entry.offlineMeasurable && !entry.offlineLimitation) {
      throw new ReleaseEvalMatrixError(`${entry.checkId}: offlineMeasurable=false requires offlineLimitation`)
    }
  }
  const covered = new Set(matrix.map((e) => e.category))
  for (const category of REQUIRED_CATEGORIES) {
    if (!covered.has(category)) {
      throw new ReleaseEvalMatrixError(`matrix is missing required category "${category}"`)
    }
  }
}

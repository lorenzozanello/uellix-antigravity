// tests/eval/stella-release/matrix.ts
// RELEASE line — versioned evaluation matrix
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fase 2).
//
// One entry per required case category. harness.ts implements exactly one
// check function per `checkId` below; harness.test.ts and
// scripts/eval-release-offline.ts both run the full matrix and assert it stays
// in sync via `validateReleaseEvalMatrix`.
//
// Train 2 rewrote the DESCRIPTIONS as well as the checks: each one now names
// the negative control that keeps it honest, because a description that only
// states what a check asserts cannot tell a reader whether the check is
// capable of failing.

export const RELEASE_EVAL_MATRIX_VERSION = '1.1.0'

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
  /** Required and validated when offlineMeasurable is false; allowed otherwise. */
  offlineLimitation?: string
}

export const RELEASE_EVAL_MATRIX: readonly ReleaseEvalMatrixEntry[] = [
  {
    checkId: 'sufficient-evidence-citation-resolves',
    category: 'evidencia-suficiente',
    description:
      'Con evidencia real en el contexto (organization-alpha, paso "evidence"), una respuesta que cita un sourceRefIndexes válido decodifica y resuelve a una ruta real del catálogo de esa solicitud. Control negativo: un índice fuera del catálogo debe ser rechazado por el mismo decodificador.',
    metrics: ['citation-precision', 'citation-coverage'],
    offlineMeasurable: true,
  },
  {
    checkId: 'insufficient-evidence-empty-sentinel',
    category: 'evidencia-insuficiente',
    description:
      'Con contexto sin evidencia/resultados, el catálogo de citas sólo contiene sentinelas ".empty"; una respuesta que inventa un finding sin evidencia real es rechazada. Controles negativos: un fixture CON evidencia debe exponer rutas indexadas, y un fallo de sistema (TypeError) no puede clasificarse como abstención.',
    metrics: ['unsupported-claim-rate', 'abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'contradiction-acknowledgment-heuristic',
    category: 'contradiccion',
    description:
      'Con evidencia contradictoria, ambos lados deben ser alcanzables desde el catálogo de citas de la solicitud, y un detector heurístico de palabras clave debe separar el texto de reconocimiento del texto silencioso — ambos tomados de fixtures, no de literales escritos dentro del check.',
    metrics: ['unsupported-claim-rate'],
    offlineMeasurable: false,
    offlineLimitation:
      'La parte ESTRUCTURAL (que ambos lados lleguen al contexto) sí se mide offline y tiene control negativo. Lo que no se puede medir sin proveedor es la calificación semántica de prosa GENERADA: el detector mide presencia de palabras clave sobre texto de fixture, no comprensión. Grading real requiere gate G1.',
  },
  {
    checkId: 'citation-correct-decodes',
    category: 'cita-correcta',
    description:
      'sourceRefIndexes en rango, sin exceder MAX_SOURCE_REFS_PER_ITEM → decodeProviderSourceRefIndexes acepta y produce sourceFields resueltos. Control negativo: un índice negativo debe rechazarse, no truncarse.',
    metrics: ['citation-precision'],
    offlineMeasurable: true,
  },
  {
    checkId: 'citation-incorrect-rejected',
    category: 'cita-incorrecta',
    description:
      'Tres variantes rechazadas: índice fuera de rango, token de índice desnudo filtrado en texto libre, y exceso de referencias por ítem. Control negativo: el rechazador debe seguir ACEPTANDO una cita válida — uno que rechace todo satisface las tres variantes y no sirve.',
    metrics: ['citation-precision', 'unsupported-claim-rate'],
    offlineMeasurable: true,
  },
  {
    checkId: 'malicious-document-envelope-holds',
    category: 'documento-malicioso',
    description:
      'Un título de evidencia con payload de inyección se serializa dentro del envelope UNTRUSTED_PROJECT_DATA como JSON de una sola línea y el detector de patrones prohibidos lo marca. Control negativo: un documento benigno NO debe marcarse — un detector que responde true a todo dejaría este check verde para siempre.',
    metrics: ['isolation-violations'],
    offlineMeasurable: true,
  },
  {
    checkId: 'cross-organization-no-leak',
    category: 'aislamiento-cross-organization',
    description:
      'Una solicitud construida para organization-alpha nunca contiene el marcador único de organization-beta (ni viceversa) en systemPrompt, contexto serializado o catálogo citable. Control negativo: un fixture con el marcador ajeno plantado debe reportarse como fuga por el mismo evaluador.',
    metrics: ['isolation-violations'],
    offlineMeasurable: true,
    offlineLimitation:
      'Verifica higiene de los context builders de aplicación, no las policies RLS reales de Postgres — eso es gate G3 (tests/integration/rls.test.ts, propiedad de CAPABILITIES). No se marca offlineMeasurable=false porque el chequeo estructural sí corre offline; la limitación es de alcance, no de ejecutabilidad.',
  },
  {
    checkId: 'cross-project-no-leak',
    category: 'aislamiento-cross-project',
    description:
      'Dos proyectos de la misma organización nunca comparten contexto: el projectId de la solicitud coincide con el del contexto y el marcador exclusivo del segundo proyecto nunca aparece en la solicitud del primero. Control negativo: evidencia del proyecto dos plantada en el proyecto uno debe reportarse.',
    metrics: ['isolation-violations'],
    offlineMeasurable: true,
  },
  {
    checkId: 'abstention-schema-enforced',
    category: 'abstencion',
    description:
      'requiresHumanReview/requires_human_review es z.literal(true) en los contratos con enforcement de esquema; una abstención genuina es aceptada. Controles negativos: requires_human_review=false y un campo requerido ausente deben ser rechazados por el esquema, no por heurística.',
    metrics: ['abstention-correctness'],
    offlineMeasurable: true,
    offlineLimitation:
      'A-F10 (tren 1): esta entrada evalúa fixtures escritos a mano contra un esquema Zod, no salida real de un proveedor. Lo que mide es que el CONTRATO rechaza lo que debe rechazar — no que un modelo real se abstenga cuando debe. Esto último requiere gate G1.',
  },
  {
    checkId: 'provider-unavailable-presentation',
    category: 'provider-unavailable',
    description:
      'GEMINI_ERROR y TIMEOUT se presentan como retryable=true, sin fragmentos de secretos en la descripción. Control negativo: la capa de presentación NO puede reportar todo como reintentable.',
    metrics: ['latency'],
    offlineMeasurable: true,
  },
  {
    checkId: 'quota-exhausted-non-retryable',
    category: 'cuota-agotada',
    description:
      'QUOTA_EXCEEDED se presenta como retryable=false con el mensaje del servidor verbatim. Control negativo: el eco verbatim debe ser específico de ese código, no universal.',
    metrics: ['abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'retryable-code-set-pinned',
    category: 'reintento',
    description:
      'El conjunto exacto de códigos reintentables y no reintentables queda fijado como regresión. Controles negativos: invertir una expectativa debe producir un mismatch, y el conjunto fijado debe contener ambas clases.',
    metrics: ['latency'],
    offlineMeasurable: true,
  },
  {
    checkId: 'human-decision-literal-true',
    category: 'decision-humana',
    description:
      'ValidatorOutputSchema y ReviewerOutputSchema rechazan requires_human_review=false. Control negativo: ninguna combinación de otros campos válidos (bajo riesgo, sin hallazgos) lo rescata.',
    metrics: ['abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'cap-01-05-regression-surface-present',
    category: 'regresion-cap-01-a-cap-05',
    description:
      'Los 5 paquetes db/prepared de CAP-01..CAP-05 y sus rollback existen, superan un piso de tamaño y conservan su marcador estructural; los tests de regresión de CAPABILITIES existen y NO están cubiertos por ninguna glob de exclusión real de vitest.shared.ts. Controles negativos: paquetes de cero bytes y un test de regresión excluido deben reportarse. Esta línea NO ejecuta esos tests — son gate de CAPABILITIES.',
    metrics: ['structural-regression'],
    offlineMeasurable: true,
    offlineLimitation:
      'B-M4 (tren 1): la versión anterior era existsSync más una tautología y pasaba con los 13 archivos truncados a cero bytes. Sigue siendo presencia estructural, no ejecución: confirma que la superficie de regresión está y es sustantiva, nunca que las policies funcionan — eso es el gate pesado de CAPABILITIES.',
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

/**
 * Fails closed on duplicate/missing checkIds, undeclared limitations, missing
 * categories, or a check that declares no metric at all.
 */
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
    if (entry.metrics.length === 0) {
      throw new ReleaseEvalMatrixError(`${entry.checkId}: declares no metric — a check that feeds nothing cannot move a release criterion`)
    }
  }
  const covered = new Set(matrix.map((e) => e.category))
  for (const category of REQUIRED_CATEGORIES) {
    if (!covered.has(category)) {
      throw new ReleaseEvalMatrixError(`matrix is missing required category "${category}"`)
    }
  }
}

// tests/eval/stella-release/matrix.ts
// RELEASE line — versioned evaluation matrix
// (STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2, Fases 2-3).
//
// One entry per case category. harness.ts implements exactly one check
// function per `checkId` below; harness.test.ts and
// scripts/eval-release-offline.ts both run the full matrix and assert it stays
// in sync via `validateReleaseEvalMatrix` + the harness's own
// assertChecksMatchMatrix / assertMetricsMatchMatrix.
//
// No metric here is a fabricated number: metrics whose measurement needs a
// real provider call are NOT attached to any check. They are declared once, in
// PROVIDER_DEPENDENT_METRICS, and always emitted with `value: null` plus a
// structured reason. Train 1 attached `latency` to two checks that could not
// measure it (finding B-M6) — declaring a metric a check cannot produce is how
// a dashboard ends up showing a number nobody computed.

export const RELEASE_EVAL_MATRIX_VERSION = '2.0.0'

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

/**
 * Metrics the release criteria require and NO offline check can feed. They are
 * emitted on every run with `value: null` and a structured reason naming the
 * gate that would unblock them. Attaching one of these to a matrix entry is a
 * validation error, not a style preference — see `validateReleaseEvalMatrix`.
 */
export const PROVIDER_DEPENDENT_METRICS: readonly ReleaseEvalMetric[] = [
  'latency',
  'token-usage',
  'estimated-provider-cost',
]

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
  | 'grounding-project-scope'
  | 'grounding-provenance'
  | 'grounding-retrieval-score'
  | 'grounding-contradiccion-marcada'
  | 'grounding-product-adapter'

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
    metrics: ['structural-regression'],
    offlineMeasurable: true,
    offlineLimitation:
      'B-M6 (tren 1): esta entrada declaraba `latency` y nada la leía. Fija la SEMÁNTICA de presentación de un proveedor caído, no su latencia — medir latencia requiere gate G1 y se reporta como métrica nula con razón estructurada, no atada a este check.',
  },
  {
    checkId: 'quota-exhausted-non-retryable',
    category: 'cuota-agotada',
    description:
      'QUOTA_EXCEEDED se presenta como retryable=false con el mensaje del servidor verbatim. Control negativo: el eco verbatim debe ser específico de ese código, no universal.',
    metrics: ['structural-regression'],
    offlineMeasurable: true,
    offlineLimitation:
      'A-F10 (tren 1): esta entrada alimentaba `abstention-correctness` e inflaba esa métrica. Agotar la cuota no es que el pipeline decida abstenerse — es que no llegó a ejecutarse. Reasignada a structural-regression.',
  },
  {
    checkId: 'retryable-code-set-pinned',
    category: 'reintento',
    description:
      'El conjunto exacto de códigos reintentables y no reintentables queda fijado como regresión. Controles negativos: invertir una expectativa debe producir un mismatch, y el conjunto fijado debe contener ambas clases.',
    metrics: ['structural-regression'],
    offlineMeasurable: true,
    offlineLimitation:
      'B-M6 (tren 1): declaraba `latency` sin medirla. Fija semántica de reintento, que es estructural.',
  },
  {
    checkId: 'human-decision-literal-true',
    category: 'decision-humana',
    description:
      'ValidatorOutputSchema y ReviewerOutputSchema rechazan requires_human_review=false. Control negativo: ninguna combinación de otros campos válidos (bajo riesgo, sin hallazgos) lo rescata.',
    metrics: ['structural-regression'],
    offlineMeasurable: true,
    offlineLimitation:
      'A-F10 (tren 1): contaba como abstención. Es un literal de contrato que el esquema impone siempre, no una decisión de abstenerse ante evidencia insuficiente. Reasignada a structural-regression.',
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
  {
    checkId: 'grounding-project-scope-enforced',
    category: 'grounding-project-scope',
    description:
      'Sobre el contrato publicado de GROUNDING: toda cita de una respuesta debe resolver a un chunk cuyo scope esté contenido en el scope del lector (scopeContains). Controles negativos: cita a un proyecto hermano de la misma organización, cita a otra organización, y cita a un chunk nunca recuperado.',
    metrics: ['isolation-violations', 'unsupported-claim-rate'],
    offlineMeasurable: true,
    offlineLimitation:
      'Mide el contrato, no una capa de retrieval real (no existe todavía) ni RLS (gate G3). Registrado además: validateAnswerCitations por sí sola NO detecta el caso proyecto-hermano porque su mapa de chunks no puede llevar projectId — es el hallazgo A-F1 del tren 1, propiedad de GROUNDING. Este check no depende de esa función.',
  },
  {
    checkId: 'grounding-provenance-canonical',
    category: 'grounding-provenance',
    description:
      'La cadena de verificación de un chunk cierra: el texto re-hashea a contentHash, chunkId se re-deriva de (versionId, chunkIndex, contentHash), coordinateSpace es el hash del texto normalizado que el span indexa, y las versiones de pipeline son las constantes vigentes. Controles negativos: texto alterado, versión de pipeline obsoleta, y sourceLabel ausente.',
    metrics: ['citation-coverage'],
    offlineMeasurable: true,
  },
  {
    checkId: 'grounding-retrieval-score-ordering',
    category: 'grounding-retrieval-score',
    description:
      'Un RetrievalResult es un ranking real: puntajes finitos, rank coincidente con la posición, orden monótono descendente, y ningún candidato por debajo del minScore de la consulta. Controles negativos: ranking invertido, candidato bajo umbral admitido, y puntaje NaN.',
    metrics: ['structural-regression'],
    offlineMeasurable: true,
    offlineLimitation:
      'Los puntajes son literales de fixture, no salida de un motor de retrieval — no existe uno. Mide las invariantes que un motor tendrá que satisfacer, de modo que el criterio exista antes que la implementación y no se escriba después para encajar con ella.',
  },
  {
    checkId: 'grounding-contradiction-marked',
    category: 'grounding-contradiccion-marcada',
    description:
      'Cuando ambos lados de una contradicción conocida están citados, la respuesta debe llevar un ContradictionMarker o abstenerse con contradictory_evidence; y una respuesta sin contradicción no debe marcarse falsamente. Controles negativos: contradicción ignorada presentada como hecho, y un marcador que afirma resolución automática.',
    metrics: ['abstention-correctness'],
    offlineMeasurable: true,
  },
  {
    checkId: 'grounding-product-adapter-input-complete',
    category: 'grounding-product-adapter',
    description:
      'Toda cita debe llevar lo que el adaptador de PRODUCT (INTEGRATION-001) necesita para renderar una EvidenceReference: evidenceId, un chunk recuperado, sourceLabel, un quotedTextHash que coincide, y un rango de líneas coherente. Controles negativos: cita con hash desviado, chunk fantasma, y sourceLabel ausente.',
    metrics: ['citation-precision'],
    offlineMeasurable: true,
    offlineLimitation:
      'Mide COMPLETITUD DE ENTRADA, no el adaptador: components/stella/grounding-adapter.ts no existe (INTEGRATION-001 sigue `solicitado`, propietaria PRODUCT). RELEASE no importa código de otra línea ni lo implementa; fija el criterio de aceptación que ese adaptador tendrá que cumplir.',
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
  'grounding-project-scope',
  'grounding-provenance',
  'grounding-retrieval-score',
  'grounding-contradiccion-marcada',
  'grounding-product-adapter',
]

export class ReleaseEvalMatrixError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'ReleaseEvalMatrixError'
  }
}

/**
 * Fails closed on duplicate/missing checkIds, undeclared limitations, missing
 * categories, a check that declares no metric at all, or — the B-M6 guard — a
 * check that claims to feed a metric no offline check can produce.
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
    for (const metric of entry.metrics) {
      if (PROVIDER_DEPENDENT_METRICS.includes(metric)) {
        throw new ReleaseEvalMatrixError(
          `${entry.checkId}: declares provider-dependent metric "${metric}", which no offline check can produce. Provider-dependent metrics are declared once in PROVIDER_DEPENDENT_METRICS and always emitted null with a reason.`,
        )
      }
    }
  }
  const covered = new Set(matrix.map((e) => e.category))
  for (const category of REQUIRED_CATEGORIES) {
    if (!covered.has(category)) {
      throw new ReleaseEvalMatrixError(`matrix is missing required category "${category}"`)
    }
  }
}

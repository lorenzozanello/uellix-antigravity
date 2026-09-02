# STELLA FABLE MOONSHOT — Mapa de Dependencias

> **PLAN DE ARRANQUE / HISTÓRICO — CAMPAÑA CERRADA.** Este documento fue
> escrito en el bootstrap (2026-07-31, sobre `dd36a4e`) como el plan de
> arranque de los 7 workstreams. La campaña cerró en el checkpoint `15af6bb`
> con los 9 merges de workstream integrados (ver `STELLA_FABLE_STATUS.md`).
> **No es una lista de tareas pendientes** — es la traza de qué se planeó y,
> con la anotación de estado añadida en la reconciliación documental
> 2026-07-31, de qué se completó, qué quedó como gate externo, qué depende
> de una decisión de producto y qué es residual opcional. Para el estado
> actual verificado por componente, ver `STELLA_FABLE_STATUS.md` §"Estado
> final verificado por componente" — ese es el documento autoritativo; este
> mapa es la traza histórica de planificación.

## Leyenda — tipo de dependencia (histórica, al momento de planificar)

- `[I]` inmediata (sin dependencias, arrancable ya)
- `[C]` depende de contexto (WS1)
- `[S]` depende de seguridad (WS3)
- `[DB]` depende de paquete DB (preparación local; la APLICACIÓN es gate G2)
- `[P]` depende de proveedor real (gate G1 — nunca en esta campaña)
- `[D]` depende de decisión de producto (gates G5/G6/DP-xx)

## Leyenda — estado final (añadida en la reconciliación 2026-07-31)

- `COMPLETED_OFFLINE` — implementado y verificado en código/tests dentro del alcance offline de la campaña; no depende de ningún gate externo para estar "hecho" en ese alcance.
- `EXTERNAL_GATE` — el trabajo offline está preparado (código, SQL, script, paquete); lo que falta es acción humana o acceso remoto autorizado (gate G1–G10), no más código.
- `DECISION_REQUIRED` — implementado hasta el máximo seguro; el paso siguiente requiere una decisión de producto de Lorenzo (DP-xx) antes de que más código tenga sentido.
- `OPTIONAL_RESIDUAL` — no bloquea `STELLA_OFFLINE_RELEASE_CANDIDATE_READY`; queda como trabajo offline opcional para una futura unidad, sin gate ni decisión bloqueante.

## Grafo por workstream

### WS1 — Production Context & Reference Quality — `COMPLETED_OFFLINE` (integrado en `24b122c`)
- `[I]` T1.1 Test de paridad `buildAdvisorContext` ↔ `ContextualAdvisorContext` — **`COMPLETED_OFFLINE`** (`build-advisor-context.parity.test.ts`, verificado en la auditoría independiente)
- `[I→T1.1]` T1.2 Poblar contexto real: `projectName`, `stakeholdersSnapshot`, `activitiesSummary`, `calculationReadiness`, `filterSetsSummary`, `calculationSnapshot`, `reportSections`, `proxySummary.value/currency`, linkage en `evidenceMetadata` — **`COMPLETED_OFFLINE`** (18/18 campos poblados, RK-01 mitigado)
- `[I]` T1.3 R1: sentinela citable para colecciones vacías — **`COMPLETED_OFFLINE`**
- `[I]` T1.4 R4: regla de prompt + validación post-proceso contra fuga de índices — **`COMPLETED_OFFLINE`**
- `[T1.2]` T1.5 R3: catálogo filtrado por step — **`COMPLETED_OFFLINE`**
- `[I]` T1.6 R6: prohibición categórica de certificación en prompt + test — **`COMPLETED_OFFLINE`**
- `[T1.2]` T1.7 R5: fixtures `complete` realmente completos (28 casos) — **`COMPLETED_OFFLINE`**
- `[T1.4]` T1.8 R2: heurística de pertinencia de referencias — **`COMPLETED_OFFLINE`** como heurística; la validación semántica plena es **`EXTERNAL_GATE`** (G1)
- `[I]` T1.9 Dedup + tope de cardinalidad — **`COMPLETED_OFFLINE`**
- `[I]` T1.10 Fallback contextual — **`COMPLETED_OFFLINE`**
- `[T1.1..T1.10]` T1.11 Gate automatizable de calidad de referencias — **`COMPLETED_OFFLINE`** (`pnpm eval:offline`, reproducido 6/6)
- `[T1.11]` T1.12 `[P]` Paquete G1: harness real parametrizado + criterios — **`EXTERNAL_GATE`** (paquete preparado en `gates/G1_PACKAGE.md`, ejecución = Lorenzo)
- `[I]` T1.13 Arreglar harness: scores hardcodeados → medición real — **`COMPLETED_OFFLINE`** (verificado: `scoreFromViolations` computa sobre violaciones reales, no constantes)

### WS2 — Advisor Product Experience — `COMPLETED_OFFLINE` (integrado en `0d0791a`)
- `[C:T1.2]` T2.1 Componente contextual: findings, suggestions, incertidumbre/limitations — **`COMPLETED_OFFLINE`**
- `[T2.1]` T2.2 Acciones: aceptar/rechazar/editar/preview/aplicar (estado React controlado, sin DOM imperativo) — **`COMPLETED_OFFLINE`** (invariante sin-escritura-automática verificado en código)
- `[T2.2]` T2.3 Historial + deshacer — **`COMPLETED_OFFLINE`** (undo LIFO global con staleness-confirm)
- `[I]` T2.4 Taxonomía de errores completa en paneles; DISABLED como prop inicial — **`COMPLETED_OFFLINE`**
- `[I]` T2.5 Accesibilidad — **`COMPLETED_OFFLINE`**
- `[I]` T2.6 Tests de `StellaReviewerPanel` (hoy cero) — **`OPTIONAL_RESIDUAL`** — el diff de campaña no añadió un archivo `StellaReviewerPanel.test.tsx` (sí se añadieron tests para Advisor/Composer/ComposerSectionEditor/Contextual/Validator); no bloquea el RC offline pero sigue siendo un hueco de cobertura real
- `[T2.1..T2.5]` T2.7 Tests de integración: panel montado en página real — **`COMPLETED_OFFLINE`** (`NarrativePage.contextual.integration.test.tsx`)
- `[D:DP-03]` T2.8 Convivencia/reemplazo del panel legacy — **`DECISION_REQUIRED`** (DP-03, pendiente de Lorenzo)

### WS3 — Security, Privacy & Audit — `COMPLETED_OFFLINE` (integrado en `2ecd766`, `3e967d0`, `c28c135`)
- `[I]` T3.1 Suite adversarial prompt injection offline — **`COMPLETED_OFFLINE`** (30 payloads × builders)
- `[I]` T3.2 PII/minimización + poblaciones sensibles — **`COMPLETED_OFFLINE`**
- `[I]` T3.3 Reemplazar placeholders de anti-regression por asserts reales — **`COMPLETED_OFFLINE`**
- `[DB]` T3.4 Migración preparada: trigger append-only + reconciliación de grants/CHECK — **`EXTERNAL_GATE`** (SQL preparado con rollback en `db/prepared/stella_0002_*.sql`; aplicación = G2)
- `[DB]` T3.5 Tests RLS offline para `stella_interactions` — **`COMPLETED_OFFLINE`** como preparación (casos editados y listos); ejecución real contra stack = **`EXTERNAL_GATE`** (G3)
- `[DB]` T3.6 Persistencia de decisiones (tabla + acciones + registro de denegaciones) — **`EXTERNAL_GATE`** (acción y tabla preparadas, dormante hasta que G2 aplique `stella_0003` + flag)
- `[I]` T3.7 Auditoría en `audit_logs` de invocaciones Stella — **`COMPLETED_OFFLINE`** (4 acciones nuevas, metadata-only)
- `[I]` T3.8 Versionado de prompts + hash en interacción — **`COMPLETED_OFFLINE`** (`context_hash` persistido; schemas de rol versionados con `schema-versions.test.ts`)
- `[I]` T3.9 Contadores de tokens/costo/latencia por llamada — **`COMPLETED_OFFLINE`** (estructura offline; calibración real = G9)
- `[T3.4..T3.6]` T3.10 `[DB]` Paquete G2 y G3 — **`EXTERNAL_GATE`** (ambos paquetes preparados: `gates/G2_PACKAGE.md`, `gates/G3_PACKAGE.md`)
- `[I]` T3.11 Envolver los 4 builders legacy en `UNTRUSTED_PROJECT_DATA` — **`COMPLETED_OFFLINE`**
- `[I]` T3.12 `canUseStella(role)` + enforcement — **`COMPLETED_OFFLINE`** (verificado en las 5 acciones: advisor ×2, composer, validator, reviewer, decisions)
- `[I]` T3.13 Redacción PII sobre narrativas y campos libres — **`COMPLETED_OFFLINE`**
- `[I]` T3.14 Gate de poblaciones sensibles — **`COMPLETED_OFFLINE`**
- `[I]` T3.15 Caps en adapter (`maxOutputTokens`, temperature, tope de prompt) — **`COMPLETED_OFFLINE`**

### WS4 — Deterministic Composer & Numeric Integrity — `COMPLETED_OFFLINE` (integrado en `5ffbf52`)
- `[I]` T4.1 Tests de propiedad del motor — **`COMPLETED_OFFLINE`** (goldens exactos re-derivados por auditor)
- `[I]` T4.2 Contrato del composer: ninguna cifra nueva en texto generado — **`COMPLETED_OFFLINE`** (guard cableado fail-closed en `composer.ts:162-205`, verificado en código — el wiring que quedaba pendiente en el bootstrap se resolvió en `ea892ca`)
- `[I]` T4.3 Bloqueo por datos incompletos — **`COMPLETED_OFFLINE`**
- `[T4.2]` T4.4 Trazabilidad: cada cifra del texto mapeada a línea del run — **`OPTIONAL_RESIDUAL`** — el guard numérico valida que las cifras provengan de números autorizados del contexto, pero no se verificó en esta reconciliación un mapeo explícito cifra→línea del run más allá de eso; no bloquea el RC offline

### WS5 — Document Grounding (greenfield confirmado por auditoría) — `COMPLETED_OFFLINE` hasta el límite seguro (integrado en `61988e8`)
- `[I]` T5.1 Spec de arquitectura documental — **`COMPLETED_OFFLINE`** (`docs/19_DOCUMENT_GROUNDING_SPEC.md`)
- `[I]` T5.2 Capa de extracción pura — **`COMPLETED_OFFLINE`** para CSV/TXT (extractores reales); PDF/XLSX bloqueados explícitamente en código citando G5 (`G5_GATED_FORMATS`) — **`DECISION_REQUIRED`** para esos dos formatos
- `[T5.2]` T5.3 Chunking + anclas de cita deterministas — **`COMPLETED_OFFLINE`**
- `[T5.3]` T5.4 `EmbeddingProvider` interface + stub determinista local — **`COMPLETED_OFFLINE`** (`DeterministicHashEmbeddingProvider`, sin red)
- `[T5.4]` T5.5 Retrieval + ensamblaje en `StellaProjectContext.evidenceExcerpts` tras flag nuevo — **`DECISION_REQUIRED`** — el módulo de retrieval está completo y testeado de forma aislada; el hook de ingesta que lo conecta al contexto de producción queda pendiente de la decisión G5 (ver RK-14)
- `[S:T3.1]` T5.6 Prompt injection documental (texto extraído = desconfiado) — **`OPTIONAL_RESIDUAL`** — no se verificó en esta reconciliación evidencia específica de una suite adversarial sobre texto extraído de documentos (distinta de la suite de contexto/prompt de T3.1); revisar antes de habilitar grounding con G5
- `[DB]` T5.7 Paquete pgvector: migración + RLS espejo — **`EXTERNAL_GATE`** (SQL preparado en `db/prepared/grounding_0001_*.sql`, no aplicado; aplicación = G2 + decisión G5 sobre embeddings)
- `[I]` T5.8 Quick wins independientes (signed URL de descarga, hash inmutable de `content_hash`) — **`OPTIONAL_RESIDUAL`** (listado explícitamente como pendiente en `STATUS.md` §4, futuro `stella_0004`)

### WS6 — Roles & Evaluation — `COMPLETED_OFFLINE` (integrado en `8f39d2a`)
- `[I]` T6.1 Inventario y contrato formal por rol + schemas versionados — **`COMPLETED_OFFLINE`**
- `[C:T1.2]` T6.2 Reformulation: prompt propio, trigger, schema, flag, tests — **`DECISION_REQUIRED`** (fuera de alcance por decisión de producto explícita, RK-30/P2; no es un olvido)
- `[T1.13]` T6.3 Suites goldens/adversariales/canaries unificadas con scoring real — **`COMPLETED_OFFLINE`** (`pnpm eval:roles`, 5/5 canaries rechazados, reproducido)
- `[T6.3]` T6.4 Gate ejecutable offline — **`COMPLETED_OFFLINE`**
- `[T6.4]` T6.5 `[P]` Paquete G1 completo + `[D]` plan rollout por rol (G4) — **`EXTERNAL_GATE`** (ambos paquetes preparados: `gates/G1_PACKAGE.md`, `gates/G4_PACKAGE.md`)

### WS7 — Operations & Commercial Readiness — `COMPLETED_OFFLINE` (integrado en `de860ca`)
- `[I]` T7.1 Runbook de incidentes + rollback — **`COMPLETED_OFFLINE`**
- `[T3.9]` T7.2 Costos por organización + topes + modelo de costos — **`COMPLETED_OFFLINE`** (visibilidad + modelo con supuestos explícitos); el tope duro de gasto por org queda **`EXTERNAL_GATE`** (calibración G9 primero, RK-22 parcial)
- `[I]` T7.3 Circuit breaker + fallback + timeouts revisados en adapter — **`COMPLETED_OFFLINE`**
- `[I]` T7.4 Dashboard operativo admin — **`COMPLETED_OFFLINE`**
- `[D:G7]` T7.5 Borradores términos/privacidad Stella — **`EXTERNAL_GATE`** (borradores ES/EN completos; revisión legal externa = G7, paquete creado en la reconciliación 2026-07-31)
- `[D:G4/G8]` T7.6 Plan cohortes + smoke test script — **`EXTERNAL_GATE`** (paquetes preparados: `gates/G4_PACKAGE.md`, `gates/G8_PACKAGE.md`)
- `[I]` T7.7 `Sentry.captureException` + contexto estructurado — **`COMPLETED_OFFLINE`**
- `[T3.9]` T7.8 Agregación de `tokens_used` + columna de costo + vista admin — **`COMPLETED_OFFLINE`**
- `[I]` T7.9 Corregir contradicción de billing (`\|\| 10` vs cuota 0) — **`COMPLETED_OFFLINE`**
- `[I]` T7.10 Script pnpm para el runner real (`eval:real`) + conectar fixture agua-segura al harness — **PARCIAL**: la conexión de la fixture está **`COMPLETED_OFFLINE`** (RK-27 mitigado vía `eval:roles`); el script pnpm dedicado para el runner de proveedor real sigue **`OPTIONAL_RESIDUAL`** (RK-29 permanece ABIERTO: sin script pnpm para `tests/eval/stella-contextual-real/`)

## Frentes paralelos sin colisión de archivos (arranque — histórico)

> Esta tabla describe cómo se planeó paralelizar el arranque (Lote A–D). Los
> 4 lotes se ejecutaron y los 7 workstreams (+WS3b, WS3c) están integrados —
> ver la tabla de merges en `STATUS.md`. Se conserva sin cambios como
> registro de la estrategia de paralelización real usada.

| Lote paralelo | Workstreams | Archivos |
|---------------|-------------|----------|
| A | WS1 (contexto/schemas/advisor) | `lib/stella/context/**`, `lib/stella/advisor/**`, `tests/eval/**` |
| B | WS3 (suites adversariales, audit, migraciones preparadas) | `lib/audit/**`, `db/migrations/(nuevas)`, `tests/(nuevos security)` |
| C | WS4 (motor/composer numérico) | `lib/` cálculo, `lib/stella/schemas/composer-*` |
| D | WS5 (extracción pura + spec) | `lib/(nuevo módulo grounding)`, `docs/` spec |

Zonas calientes (un solo dueño por ciclo): `lib/stella/config.ts`, `lib/stella/index.ts`,
`db/schema.ts`, `lib/stella/prompts/**`. WS2 arrancó cuando T1.2 quedó integrado
(su UI consume el contexto real).

## Reglas (histórico — vigentes durante la ejecución de la campaña)

1. Un gate externo bloqueado congela sólo su entregable, nunca otro workstream.
2. Nada `[P]` se ejecuta: sólo se preparan paquetes.
3. Nada `[DB]` se aplica: sólo se genera, prueba en local/pglite y documenta.
4. `[D]` sin decisión → se implementa hasta el máximo seguro con la opción recomendada marcada como reversible.

Estas 4 reglas se cumplieron durante toda la campaña — verificado en la
auditoría independiente: cero migraciones aplicadas, cero llamadas a
proveedor real, y cada `[D]` sin decisión (grounding PDF/XLSX, reformulation,
convivencia de paneles) quedó implementado hasta el máximo seguro con la
opción marcada como reversible, nunca bloqueado.

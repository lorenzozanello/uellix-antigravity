# Línea de trabajo: PRODUCT

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-product`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-product`
- **HEAD base:** `INTEGRATION_ROOT_HEAD` (commit de gobernanza sobre
  `c7c9736` en `codex/stella-integration` — ver §1 y §4 del documento de
  gobernanza; el hash exacto queda registrado en el informe de entrega de
  esta unidad de bootstrap)
- **Propietario:** sin asignar

## Rutas autorizadas

- Composer y experiencia Stella (`lib/stella/advisor/**` en lo que sea
  presentación/orquestación de UI, no esquema).
- `components/**` salvo los componentes marcados `INTEGRATION-OWNED`
  (`components/marketing/Navbar.tsx`, `components/layout/MobileNav.tsx`).
- Formularios; estados de carga, error, vacío y abstención.
- UI de decisiones sobre sugerencias, evidencias, proxies.
- UI de reportes e historial (`app/**` bajo las rutas de reporte, no el
  esquema que las alimenta).
- Presentación de cuotas visibles (lectura de la cuota, no su definición
  en base de datos — eso es CAPABILITIES).

## Rutas prohibidas

- `db/**`, `supabase/**`, `db/prepared/**` y cualquier migración, SQL
  preparado, policy, rol o función SQL — propiedad exclusiva de CAPABILITIES.
- Todo lo marcado `INTEGRATION-OWNED` en el documento de gobernanza §7,
  incluyendo `app/layout.tsx` (shell de navegación raíz).
- Extracción, normalización, retrieval, ranking, provenance de grounding
  (propiedad de GROUNDING) — PRODUCT consume sus contratos TypeScript, no
  reimplementa esa lógica.
- E2E, CI, observabilidad, scripts de release (propiedad de RELEASE).

## Dependencias

- Depende de los contratos TypeScript publicados por GROUNDING para
  retrieval/citas/abstención en la UI.
- Depende de los contratos TypeScript publicados por CAPABILITIES para
  cuotas visibles y estado de decisiones.

## Contratos requeridos

- **PRODUCT-001** (solicitado a GROUNDING, 2026-08-04): provenance de citas a
  nivel documento/chunk (`documentId`/`excerpt`/`location`/`relevance`) y una
  señal explícita de contradicción entre dos evidencias. Ver
  [`docs/ops/contracts/PRODUCT-001_grounded-citation-provenance.md`](../contracts/PRODUCT-001_grounded-citation-provenance.md).
  Hasta que se resuelva, `EvidenceSupportLevel: 'contradictory_evidence'`
  queda modelado en el tipo pero ningún mapper de
  `components/stella/grounding-model.ts` lo produce.

## Unidad actual

**STELLA_PRODUCT_GROUNDED_EXPERIENCE_TRAIN_1** — modelo de presentación
tipado para respuestas fundamentadas de Stella (grounded / partially
grounded / insufficient evidence / contradictory evidence / unavailable /
permission denied / quota reached / provider failure / user approval
required), construido enteramente sobre señales reales ya existentes
(`AdvisorContextualOutput.findings[].sourceFields`,
`.suggestions[].sourceFields`/`missingInformation`/`proposedText`,
`StellaPanelErrorCode`, `SuggestionDecisionAction`). Sin datos simulados como
estado normal del producto, sin cálculo SROI en cliente, sin tocar
`db/**`/SQL. Unidad completada — lista para integración.

## Últimos commits

- `21468ca` — `feat(stella): model grounded response states`
- (siguiente commit de esta unidad) — `feat(stella): render evidence and
  human decision workflow`

## Pruebas ejecutadas

- `node_modules/.bin/vitest run components/stella/__tests__/grounding-model.test.ts`
  — 30/30 verde.
- `node_modules/.bin/vitest run components/stella/__tests__/StellaGroundingBadge.test.tsx
  components/stella/__tests__/StellaEvidencePanel.test.tsx
  components/stella/__tests__/StellaAvailabilityNotice.test.tsx` — 15/15 verde.
- `node_modules/.bin/vitest run components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx`
  — 43/43 verde (39 preexistentes + 4 nuevas de badges de fundamentación).
- `node_modules/.bin/vitest run components/stella` (corrida focalizada
  completa del paquete) — 259/261 verde; 2 fallos preexistentes y no
  relacionados en `StellaAdvisorPanel.test.tsx` y
  `StellaValidatorPanel.test.tsx` (`does not read GEMINI_API_KEY env var` —
  el proceso de test hereda un `GEMINI_API_KEY` real del entorno; ver
  Riesgos). No introducidos por esta unidad.
- `pnpm typecheck` — sin errores, dos veces (después de cada tarea).
- Nota: `pnpm test:unit -- <ruta>` no filtra correctamente en este entorno
  (el `--` de pnpm llega como argumento literal a vitest en Git Bash/Windows
  y termina corriendo la batería completa); se usó
  `node_modules/.bin/vitest.CMD run <ruta>` directamente para las corridas
  focalizadas.

## Riesgos

- `StellaAdvisorPanel.test.tsx` y `StellaValidatorPanel.test.tsx` fallan un
  test cada uno (`does not read GEMINI_API_KEY env var`) por una variable de
  entorno real filtrándose al proceso de test en este worktree — preexistente,
  no relacionado a esta unidad, no corregido aquí (no toca ningún archivo de
  esta entrega). Integración debería confirmarlo en un entorno limpio.
- `EvidenceSupportLevel: 'contradictory_evidence'` queda sin productor real
  hasta que se resuelva PRODUCT-001 — es un estado alcanzable solo vía
  fixtures de prueba, nunca en runtime hoy.

## Estado de entrega a integración

Listo. Árbol limpio, dos commits (`feat(stella): model grounded response
states`, `feat(stella): render evidence and human decision workflow`), sin
push, sin tocar `db/**`/SQL/INTEGRATION-OWNED.

---

## Integración — tren 1 (2026-08-04)

**Fusionada.** HEAD integrado `9e57301`, commits `21468ca` y `9e57301`, merge
commit `fa3a13c` (`--no-ff`).

**Conflicto:** `docs/ops/contracts/CONTRACT_LEDGER.md` (add/add), el mismo
índice que CAPABILITIES y GROUNDING habían creado en paralelo. Resuelto
preservando `CT-CAP-001..004`, `GR-001`, `GR-002` y añadiendo `PRODUCT-001`.
Ningún otro archivo entró en conflicto.

### Pruebas focalizadas en el HEAD integrado

`vitest run components/stella` → 13 archivos, **261 passed, 0 failed**.

Los 2 fallos que esta línea reportó (`StellaAdvisorPanel.test.tsx` y
`StellaValidatorPanel.test.tsx`, «does not read GEMINI_API_KEY env var`) **eran
contaminación ambiental, confirmada por experimento controlado**: la misma
suite, en el mismo HEAD, entrega 259/261 con `GEMINI_API_KEY` en el entorno y
261/261 sin ella. Integración eliminó la variable únicamente del entorno del
proceso de prueba (`env -u`); no se modificó ningún archivo `.env`. La
sospecha de esta línea era correcta.

Confirmado en el árbol integrado:

- Componentes nuevos presentes: `StellaGroundingBadge`, `StellaEvidencePanel`,
  `StellaAvailabilityNotice`, más los badges en `StellaContextualAdvisorPanel`.
- Estados tipados presentes: `EvidenceSupportLevel` (5),
  `StellaAvailabilityState` (4), `StellaDecisionStatus` (5).
- Abstención visible: `insufficient_evidence` se produce desde señales reales
  (`sourceFields` vacío / sentinela de colección vacía), no desde un fixture.
- Citas no inventadas: `buildEvidenceReferences` sólo mapea rutas canónicas ya
  presentes en la salida del advisor.
- Flujo de decisión humana intacto: `StellaDecisionStatus` refleja
  `SuggestionDecisionAction` 1:1 menos `'copied'`.
- Cero cambios de base de datos y cero SQL.

### Contratos

**PRODUCT-001 → `PARTIALLY_SATISFIED_PENDING_ADAPTER`.**

GROUNDING publicó el mismo día, sin ver esta solicitud, contratos que cubren la
necesidad con una forma **distinta y más estricta**. Integración no eligió
arbitrariamente entre ambas: registró
[`INTEGRATION-001`](../contracts/INTEGRATION-001_grounding_product_citation_adapter.md),
que establece que `lib/grounding/contracts/**` es la fuente técnica canónica de
provenance y que la presentación **no persiste una segunda forma** de la misma.

Razón concreta, no estilística: `CitationReference` no lleva el texto de la
cita, lleva `quotedTextHash`. Un `excerpt` persistido junto a la cita es un
segundo registro del mismo hecho que puede divergir del hash; en cuanto diverge,
el sistema tiene dos respuestas a «¿qué dice el documento?» y la que se ve en
pantalla es la que no está verificada.

`EvidenceSupportLevel: 'contradictory_evidence'` sigue sin productor real, y eso
deja de ser una limitación temporal: por decisión de integración, sólo un
`ContradictionMarker` puede producirlo — nunca una inferencia hecha en un
componente de UI.

### Riesgos tras la integración

- El riesgo de `GEMINI_API_KEY` queda **cerrado como riesgo de esta línea**: era
  ambiental y está caracterizado. Sigue siendo una nota operativa para quien
  ejecute la batería en una shell con la variable presente.
- `'contradictory_evidence'` sin productor: abierto, ahora con una regla
  explícita que lo gobierna.

### Trabajo de entrada del tren 2

**Implementar el adaptador puro** de INTEGRATION-001, previsto en
`components/stella/grounding-adapter.ts`, bajo sus siete reglas: `excerpt`
derivado de `GroundingChunk.text`, `location` renderizado desde `ChunkLocation`
sin volver a entrar como ubicación, buckets de `relevance` con umbrales
nombrados y probados en el borde que **no** sustituyen al score, y
`contradiction` exclusivamente desde `ContradictionMarker`.

No se implementó aquí: PRODUCT compila y pasa sin él, así que la excepción
«sólo si es estrictamente necesario para compilar» no aplica. Verificado que
`components/**` no importa nada de `lib/grounding/**` en el HEAD integrado.

### Hallazgos de la revisión adversarial de integración

- **A-F3 — la regla de contradicción no está impuesta por nada.**
  INTEGRATION-001 §7 dice que sólo un `ContradictionMarker` puede producir
  `contradictory_evidence`. Hoy eso se cumple **por ausencia de código**:
  `StellaGroundingBadge` recibe `level` como prop libre sin validación, el badge
  y el tipo se re-exportan desde `components/stella/index.ts`, y `components/**`
  no importa nada de `lib/grounding/**`. Un mapper de tren 2 que dedujera la
  contradicción de dos `sourceFields` opuestos compilaría, renderizaría el badge
  rojo y pasaría CI. **El adaptador del tren 2 debe llevar una prueba focalizada
  que falle si ese valor se alcanza sin un `ContradictionMarker` de entrada.**
- **B-m4 (MINOR)** — ciclo entre `grounding-model.ts:22` y
  `StellaContextualAdvisorPanel.tsx:40`. Es **sólo de tipos**: el lado de tipos
  usa `import type` explícito y `tsconfig.json` fija `isolatedModules: true`, así
  que se borra en transform y no hay ciclo en runtime. Se convierte en uno real
  el día que alguien quite la palabra `type`.
- **Nota de cobertura, no defecto:** `StellaEvidencePanel`,
  `StellaAvailabilityNotice`, `buildEvidenceReferences` y `classifyAvailability`
  tienen **cero call sites fuera de `components/stella/`**. Están exportados,
  probados y montados en ninguna parte. Es coherente con el estado declarado
  (el adaptador no existe), pero significa que sus pruebas seguirían verdes
  aunque el pipeline nunca produjera un `EvidenceReference` — que es exactamente
  la situación de hoy.

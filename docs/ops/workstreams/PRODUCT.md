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

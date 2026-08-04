# Línea de trabajo: RELEASE Y CALIDAD

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-release`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-release`
- **HEAD base:** `INTEGRATION_ROOT_HEAD` (commit de gobernanza sobre
  `c7c9736` en `codex/stella-integration` — ver §1 y §4 del documento de
  gobernanza; el hash exacto queda registrado en el informe de entrega de
  esta unidad de bootstrap)
- **Propietario:** sin asignar

## Rutas autorizadas

- E2E (bajo `tests/**` que esta línea defina para ese propósito).
- Evals de calidad/latencia/costo (distintas de las evals funcionales de
  GROUNDING — coordinar por contrato si se solapan).
- Observabilidad, logging, métricas.
- Presupuestos de latencia y costos.
- Pruebas de aislamiento.
- Scripts de release.
- Staging y runbooks (`docs/ops/runbooks/**`).
- `.github/workflows/ci.yml`, `.github/workflows/p1a-validation.yml` — bajo
  el mismo protocolo de ruta compartida que el resto de `INTEGRATION-OWNED`
  (§7 del documento de gobernanza), porque estos workflows afectan a las
  cuatro líneas.

## Rutas prohibidas

- `db/**`, `supabase/**`, `db/prepared/**` y cualquier migración, SQL
  preparado, policy, rol o función SQL — propiedad exclusiva de CAPABILITIES.
- Contratos funcionales (interfaces TypeScript publicadas por GROUNDING,
  PRODUCT o CAPABILITIES) — RELEASE los consume, no los modifica.
- Composer, UI de la experiencia Stella (propiedad de PRODUCT).
- Extracción, normalización, retrieval, ranking, provenance de grounding
  (propiedad de GROUNDING).

## Dependencias

- Depende de que las otras tres líneas entreguen unidades verdes a
  integración para poder ejercer E2E y evals de extremo a extremo con
  contenido real.
- Coordina con integración cualquier cambio a `ci.yml` /
  `p1a-validation.yml` antes de aplicarlo (§7 del documento de gobernanza).

## Contratos requeridos

Ninguno registrado todavía.

## Unidad actual

Sin asignar.

## Últimos commits

Ninguno todavía (branch recién creada desde `INTEGRATION_ROOT_HEAD`).

## Pruebas ejecutadas

Ninguna todavía. Suites relevantes disponibles en el repo:
`pnpm test:integration`, `pnpm eval:roles`, `pnpm eval:offline`.

## Riesgos

- Ninguno registrado todavía.

## Estado de entrega a integración

No entregado. Rama recién creada, sin commits propios.

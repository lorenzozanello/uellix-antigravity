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

Ninguno registrado todavía.

## Unidad actual

Sin asignar.

## Últimos commits

Ninguno todavía (branch recién creada desde `INTEGRATION_ROOT_HEAD`).

## Pruebas ejecutadas

Ninguna todavía. Suite relevante disponible en el repo: `pnpm test:unit`
(alcance de componentes), `pnpm typecheck`.

## Riesgos

- Ninguno registrado todavía.

## Estado de entrega a integración

No entregado. Rama recién creada, sin commits propios.

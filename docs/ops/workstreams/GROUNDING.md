# Línea de trabajo: GROUNDING

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-grounding`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-grounding`
- **HEAD base:** `INTEGRATION_ROOT_HEAD` (commit de gobernanza sobre
  `c7c9736` en `codex/stella-integration` — ver §1 y §4 del documento de
  gobernanza; el hash exacto queda registrado en el informe de entrega de
  esta unidad de bootstrap)
- **Propietario:** sin asignar

## Rutas autorizadas

- Contratos TypeScript propios (bajo `lib/stella/**` o un módulo dedicado
  que esta línea defina en su worktree — a decidir por la línea al iniciar
  su primera unidad, ya que `lib/stella/` en la fundación mezcla adapter,
  advisor, config y schemas sin una subcarpeta de grounding dedicada).
- Extracción de documentos, normalización, hashing, chunking, clasificación
  documental, retrieval, ranking, provenance, citas, abstención.
- Evaluaciones focalizadas de grounding: extensiones de `pnpm eval:offline`
  y tests bajo `tests/**` o `lib/stella/__tests__/**` que esta línea añada
  para su propio dominio.

## Rutas prohibidas

- `db/**`, `supabase/**`, `db/prepared/**` y cualquier migración, SQL
  preparado, policy, rol o función SQL — propiedad exclusiva de CAPABILITIES.
- Todo lo marcado `INTEGRATION-OWNED` en el documento de gobernanza §7.
- Composer, UI de la experiencia Stella (propiedad de PRODUCT).
- E2E, CI, observabilidad, scripts de release (propiedad de RELEASE).

## Dependencias

- Toda necesidad de esquema, tabla, columna o función SQL depende de un
  contrato aceptado por CAPABILITIES (§8 del documento de gobernanza).
  Esta línea no crea SQL especulativo para sortear esa dependencia.
- PRODUCT depende de los contratos TypeScript que esta línea publique
  (retrieval, ranking, provenance, citas, abstención).

## Contratos requeridos

Ninguno registrado todavía.

## Unidad actual

Sin asignar.

## Últimos commits

Ninguno todavía (branch recién creada desde `INTEGRATION_ROOT_HEAD`).

## Pruebas ejecutadas

Ninguna todavía. Suite relevante disponible en el repo: `pnpm eval:offline`.

## Riesgos

- Ninguno registrado todavía.

## Estado de entrega a integración

No entregado. Rama recién creada, sin commits propios.

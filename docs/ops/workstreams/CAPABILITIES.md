# Línea de trabajo: CAPABILITIES

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-capabilities`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-capabilities`
- **HEAD base:** `INTEGRATION_ROOT_HEAD` (commit de gobernanza sobre
  `c7c9736` en `codex/stella-integration` — ver §1 y §4 del documento de
  gobernanza; el hash exacto queda registrado en el informe de entrega de
  esta unidad de bootstrap)
- **Propietario:** sin asignar

## Rutas autorizadas (exclusivas)

- `db/**`
- `supabase/**`
- `db/prepared/**`
- Cualquier migración, policy, rol, función SQL, esquema, grant o RLS en
  cualquier ubicación del repositorio.
- `docs/ops/capabilities/CAP_01_INVITATIONS.md` … `CAP_05_ORGANIZATION_BOOTSTRAP.md`
- El hallazgo de referencia `RR-CAP-10` (ver nota de numeración en el
  documento de gobernanza §3).

## Rutas prohibidas

- Todo lo marcado `INTEGRATION-OWNED` en el documento de gobernanza §7.
- Componentes de UI, Composer, experiencia Stella (propiedad de PRODUCT).
- Extracción, normalización, retrieval, ranking, provenance de grounding
  (propiedad de GROUNDING) salvo el esquema/tabla que los soporte, que sí
  es de esta línea bajo contrato.
- E2E, CI, observabilidad, scripts de release (propiedad de RELEASE).

## Dependencias

- Ninguna dependencia de entrada de otra línea para empezar: esta línea
  puede trabajar directamente sobre `db/**` y `supabase/**` desde
  `INTEGRATION_ROOT_HEAD`.
- GROUNDING y PRODUCT dependen de los contratos de esquema que esta línea
  publique — ver "Contratos requeridos".

## Contratos requeridos

Ninguno registrado todavía. Cuando GROUNDING o PRODUCT soliciten un
esquema, tabla, columna, policy o función nueva, la solicitud aparecerá en
`docs/ops/contracts/CONTRACT_LEDGER.md` con línea solicitante =
GROUNDING/PRODUCT y línea propietaria = CAPABILITIES. Esta línea responde
ahí, no fuera de ese canal.

## Unidad actual

Sin asignar. Esta línea no ha comenzado trabajo de producto todavía — el
worktree se crea limpio en esta unidad de bootstrap.

## Últimos commits

Ninguno todavía (branch recién creada desde `INTEGRATION_ROOT_HEAD`).

## Pruebas ejecutadas

Ninguna todavía. Suites relevantes disponibles en el repo para esta línea:
`pnpm test:rls`, `pnpm db:test:integration:local`,
`pnpm db:audit:readonly`, `pnpm eval:roles` (si toca policies de rol).

## Riesgos

- Ninguno registrado todavía.

## Estado de entrega a integración

No entregado. Rama recién creada, sin commits propios.

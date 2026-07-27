# Stella — Etapa A2.2: DR-007 (Control de acceso interno a `stella_interactions`). Informe de implementación

**Fecha:** 2026-07-26

---

## 1. Rama y commit base

`feature/stella-generation-copilot`, commit base `4c8a8ed9537e4181229ce94f83ca6447db30b172`. Sin cambios respecto a todas las sesiones anteriores de esta cadena de trabajo — ningún commit se ha creado en ninguna de ellas.

## 2. Estado inicial

`git status` mostraba el mismo working tree con el que cerró DR-005 (Etapa A2.1), sin commits de por medio. Se leyeron íntegramente los 11 documentos obligatorios y el código señalado. Se lanzó un agente de exploración dedicado para construir un inventario completo de toda referencia a `stellaInteractions`/`stella_interactions`/sus columnas sensibles antes de diseñar nada, tal como exige el encargo ("no diseñes políticas hasta completar este inventario").

## 3. Inventario completo de lecturas

| # | Archivo | Categoría | Mecanismo |
|---|---|---|---|
| 1 | `lib/stella/audit-log.ts` | **Escritura** (único escritor, confirmado por grep de `insert(stellaInteractions)`) | Drizzle sobre `DATABASE_URL` (rol `postgres`, BYPASSRLS) |
| 2 | `lib/stella/quota.ts` | Lectura ordinaria — **agregado** (`count()` agrupado por organización/mes, nunca filas) | Drizzle |
| 3 | `lib/admin/stella-services.ts` | Lectura administrativa — **agregado** (mismo patrón que quota.ts, para `/admin/services`) | Drizzle |
| 4 | `lib/projects/service.ts` | Lectura ordinaria — **guarda de existencia** (`SELECT id`, bloquea borrar un proyecto con interacciones) | Drizzle |
| 5 | `db/policies/002_stella_interactions_rls.sql` | RLS (SELECT para miembro activo + `super_admin` global) | Supabase/PostgREST |
| 6 | `db/migrations/0033/0043` | Migraciones de privilegios | GRANT/REVOKE |
| 7 | `tests/integration/stella-interactions-rls.test.ts` | Test | Ambos (Drizzle para sembrar; Supabase autenticado para aserciones) |

**Hallazgo central del inventario:** no existe hoy ningún componente de UI, página o *server action* que muestre el historial de interacciones de Stella a un usuario final — ni una sola lectura expone `response_json`/`context_manifest` fuera de este bloque. Tampoco existe ningún patrón de soporte/impersonación/"break glass" en todo el repositorio (búsqueda exhaustiva, cero coincidencias). Esto significa que el servicio central de lectura de este bloque es **enteramente nuevo** — no hay ningún consumidor existente que adaptar.

## 4. Modelo real de permisos

- Roles reales (`lib/auth/roles.ts`): `super_admin`(100) > `organization_admin`(80) > `impact_manager`(60) > `analyst`(40) > `reviewer`(20) > `viewer`(10).
- `requireOrganizationAccess()` (`lib/auth/session.ts`) resuelve la organización por MEMBRESÍA únicamente — sin ningún concepto de proyecto. Solo devuelve membresías **activas** (`getCurrentMembership` filtra `status = 'active'`).
- **No existe ninguna ACL por proyecto en Uellix.** Verificado en `db/migrations/0031_rls_core.sql`: las políticas RLS de `projects` (`projects_select_member_or_admin`) son org-wide para CUALQUIER rol; y las políticas de escritura de `projects`/`portfolios`/`impact_narratives` usan sistemáticamente la misma lista de 4 roles: `super_admin, organization_admin, impact_manager, analyst`. Este es el precedente exacto que la matriz de DR-007 reutiliza para "analyst con acceso a los proyectos" = "analyst con acceso a la organización completa".
- `current_user_org_ids()` (helper RLS) ya filtra por `status = 'active'` — confirmado antes de escribir la política nueva.

## 5. Matriz final

| Actor | Propia interacción | Toda la organización | Cross-org | Historial completo |
|---|---:|---:|---:|---:|
| Creador activo | **Sí** | — | No | Solo la suya |
| Viewer | **Sí** (ver §6, decisión interpretativa) | No | No | No |
| Reviewer | **Sí** (mismo trato que viewer) | No | No | No |
| Analyst | Sí | **Sí** (alcance real = org completa) | No | Sí, dentro del alcance |
| Impact_manager | Sí | **Sí** (mismo trato que analyst) | No | Sí, dentro del alcance |
| Organization_admin | Sí | **Sí** | No | Sí |
| Super_admin con membresía explícita en esa organización | Sí | Sí (por esa membresía) | No | Sí |
| Super_admin ordinario (sin membresía) | No | **No** | No | No — `support_reason_required` |
| Usuario sin membresía | No | No | No | No |
| Membresía inactiva | **No** (ni siquiera como creador) | No | No | No |

Casos de borde cubiertos: interacción sin proyecto (`projectId` no se usa en la decisión — irrelevante), proyecto archivado (mismo motivo, sin ACL por proyecto), cambio de rol (la decisión usa el rol de membresía VIGENTE, nunca el histórico), usuario que cambia de organización (su membresía en la organización anterior queda inactiva o se borra — cae en `cross_org`/`inactive_membership`), creador que pierde acceso al proyecto (no aplica: no hay ACL por proyecto).

## 6. Decisiones interpretativas

1. **"Viewer creador" — SÍ conserva acceso a su propia interacción.** La decisión aprobada define la regla de creador de forma genérica ("mientras conserve acceso activo"), sin excepción de rol, y su lista explícita de lo que un `viewer` NO puede consultar dice literalmente "interacciones de OTROS usuarios" — no "las suyas". Se interpretó que la prohibición es sobre el historial ajeno/general, no sobre la propia. Documentado explícitamente porque el encargo pedía no asumir automáticamente ninguna de las dos lecturas.
2. **`reviewer` (no mencionado en la decisión aprobada) se trata igual que `viewer`.** La matriz aprobada por el propietario cubre expresamente creador, analyst, organization_admin, viewer y super_admin — pero no `reviewer` ni `impact_manager`. Para `impact_manager` (jerarquía 60, por encima de `analyst`=40) se extendió el mismo trato que `analyst` por consistencia jerárquica y porque el propio código ya agrupa a ambos junto con `organization_admin` en decisiones de acceso equivalentes (`projects`/`portfolios`/`impact_narratives`). Para `reviewer` (jerarquía 20, por debajo de `analyst`) se aplicó el principio de menor privilegio: se le trata como `viewer`, no como `analyst`. Esta es una extrapolación, no una instrucción literal del propietario — se recomienda confirmarla explícitamente en una futura revisión si no coincide con la intención real.
3. **`analyst`/`impact_manager` obtienen alcance de TODA la organización, no "por proyecto".** Documentado explícitamente como el alcance REAL existente (no hay ACL por proyecto en Uellix hoy), no como una decisión de diseñar más acceso del que la decisión aprobada pretendía. Si en el futuro Uellix introduce una ACL por proyecto, `projectId` ya está aceptado (aunque sin uso) en `StellaInteractionAccessContext` para esa evolución.
4. **`super_admin` con una membresía EXPLÍCITA de nivel `organization_admin` o `super_admin` en una organización específica conserva acceso — por esa membresía, no por el flag global `is_super_admin`.** Esto no es un bypass: es la misma regla de "organization_admin" aplicada a cualquier usuario que tenga esa membresía real.

## 7. RLS anterior y nueva

**Anterior** (`db/policies/002_stella_interactions_rls.sql`, sin editar — solo se corrigió un comentario, sin tocar el SQL ejecutable):
```sql
CREATE POLICY "stella_interactions_select_member_or_admin"
ON stella_interactions FOR SELECT
USING (
  organization_id = ANY(current_user_org_ids())
  OR current_user_is_super_admin()
);
```
Cualquier rol, cualquier miembro activo, más un bypass general de `super_admin`.

**Nueva** (`db/policies/010_stella_interactions_access_control_rls.sql`, archivo nuevo — sustituye la política anterior vía `DROP POLICY IF EXISTS`):
```sql
CREATE POLICY "stella_interactions_select_scoped"
ON stella_interactions FOR SELECT
USING (
  (created_by = auth.uid() AND organization_id = ANY(private.current_user_org_ids()))
  OR
  private.current_user_role_in_org(organization_id) IN ('organization_admin', 'super_admin', 'impact_manager', 'analyst')
);
```
Sin bypass general de `super_admin`. Aplicada y verificada contra el stack local (`pg_policies` confirma que solo existe esta política de SELECT).

## 8. Privilegios

Sin cambios respecto al estado post-`0043` (verificado, no modificado): `authenticated` = SELECT únicamente; `anon` = ninguno; `service_role`/`postgres` = completo. Confirmado con `has_table_privilege` antes y después de aplicar la política 010.

## 9. Servicios centrales

- **`lib/stella/access/stella-interaction-access.ts`** — `canReadStellaInteraction()`, función pura, fail-closed, reutilizada por el servicio de lectura (la política RLS es una implementación SQL independiente de la MISMA matriz — ambas deben mantenerse manualmente en sincronía, documentado en ambos archivos).
- **`lib/stella/access/stella-interaction-reads.ts`** — `listAuthorizedStellaInteractions()` (vista resumida, alcance aplicado en SQL vía `ORG_WIDE_STELLA_ACCESS_ROLES`, nunca post-filtrado en memoria) y `getAuthorizedStellaInteraction(id)` (vista detallada solo si `canReadStellaInteraction` autoriza; `NOT_FOUND` en cualquier otro caso, sin distinguir "no existe" de "no autorizado").

## 10. Lecturas con bypass de RLS

Las 3 lecturas existentes (`quota.ts`, `admin/stella-services.ts`, `projects/service.ts`) se revisaron y se decidió **no migrarlas** al servicio central: todas son agregados (`count()`) o una verificación de existencia (`SELECT id`), nunca exponen `response_json`/`context_manifest`/`risk_flags` — verificado explícitamente con una prueba dedicada (`tests/stella-interactions-access-anti-regression.test.ts`). El único punto nuevo de lectura de CONTENIDO es el servicio central, que sí resuelve el actor desde la sesión y aplica la matriz completa.

## 11. Tratamiento de viewer

Sin acceso general al historial. Conserva acceso a su propia interacción como creador (decisión interpretativa documentada en §6.1). No puede leer historial completo, respuestas descartadas, prompts, manifiestos de contexto, datos de auditoría internos, ni interacciones de otros usuarios — todo eso queda fuera del alcance de la vista resumida/detallada por diseño (esos campos ni siquiera se seleccionan para un `viewer` no-creador, ya que la fila nunca se le devuelve).

## 12. Tratamiento de analyst

Alcance real = toda la organización (§6.3). Mismo trato para `impact_manager`.

## 13. Tratamiento de organization_admin

Acceso completo a su organización, sin cambio respecto a la intención original de la decisión aprobada.

## 14. Tratamiento de super_admin

Sin bypass general. Con membresía explícita en una organización, accede por esa membresía (§6.4). Sin infraestructura de acceso excepcional auditado — ver riesgos residuales.

## 15. Campos visibles por nivel

- **Vista resumida** (`StellaInteractionSummary`, listados): `id`, `stellaRole`, `pipelineStep`, `projectId`, `createdBy`, `createdAt`, `riskLevel`, `modelUsed`.
- **Vista detallada** (`StellaInteractionDetail`, solo tras autorización): añade `responseJson`, `contextManifest`, `riskFlags`, `tokensUsed`, `promptTemplateId`, `promptVersion`, `promptContentHash`, `contextSchemaVersion`, `contextHash`.

No se creó ninguna vista de PostgreSQL — la proyección se hace en el servicio TypeScript, suficiente para esta necesidad.

## 16. Pruebas

| Archivo | Casos | Resultado |
|---|---|---|
| `lib/stella/access/__tests__/stella-interaction-access.test.ts` | 19 | ✅ (cubre la sección 14 del encargo en su totalidad) |
| `lib/stella/access/__tests__/stella-interaction-reads.test.ts` | 8 | ✅ |
| `tests/stella-interactions-access-anti-regression.test.ts` | 3 | ✅ |
| `tests/integration/stella-interactions-access-rls.test.ts` (nueva) | 18 | ✅ (cubre los 16 escenarios de la sección 15, algunos con más de una aserción) |
| `tests/integration/stella-interactions-rls.test.ts` (actualizada) | 10 | ✅ (1 aserción actualizada: el bypass de super_admin ya no existe, con justificación documentada en el propio archivo) |

**Total nuevas/ampliadas:** 5 archivos, 58 pruebas.

## 17. Comandos ejecutados

`pnpm typecheck` (x3) · `pnpm lint` · `pnpm exec vitest run lib/stella/access` · `pnpm exec vitest run tests/stella-interactions-access-anti-regression.test.ts` · `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/stella-interactions-rls.test.ts` (x2, antes/después de actualizar la aserción) · `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/stella-interactions-access-rls.test.ts` · `pnpm test:integration` · `npx drizzle-kit check` (x2) · `pnpm exec vitest run lib/stella app/actions/stella components/stella tests/stella-quota.test.ts tests/stella-adversarial.test.ts tests/stella-adversarial-runtime.test.ts tests/stella-interactions-access-anti-regression.test.ts tests/eval` · `pnpm test:unit` · validación del CSV (x2). Aplicación manual de `db/policies/010_stella_interactions_access_control_rls.sql` al stack local (script temporal, eliminado tras usarlo).

## 18. Resultados exactos

- `pnpm typecheck`: limpio, 0 errores.
- `pnpm lint`: 0 errores, 55 warnings (línea base sin cambio).
- Suite completa de Stella: 39 archivos, **689 pruebas**, 0 fallos.
- `pnpm test:unit`: 103 archivos, **1380 pruebas**, 0 fallos.
- `pnpm test:integration`: 6 archivos, **78 pruebas**, 0 fallos.
- `drizzle-kit check`: "Everything's fine", sin drift, en ambas ejecuciones.
- CSV: 89 filas, 18 columnas, 0 malformadas, 0 IDs duplicados, 0 dependencias colgantes, 0 inversiones de orden.
- **Build:** no ejecutado — no se tocó ninguna ruta, componente ni configuración de Next.js en este bloque (solo `lib/`, `db/`, `tests/`), condición explícita del encargo para omitirlo.

## 19. Riesgos residuales

1. **Sin mecanismo de acceso excepcional auditado para soporte.** Un `super_admin` legítimo que necesite investigar un incidente hoy no tiene ninguna vía — ni siquiera auditada — para leer interacciones fuera de su propia membresía. Aplicado el principio de menor privilegio explícitamente en vez de construir apresuradamente un sistema de "break glass" dentro de este bloque. **Tarea futura separada**, no bloqueante para este gate.
2. **`reviewer`/`impact_manager` tratados por extrapolación jerárquica, no por instrucción literal del propietario** — recomendado confirmar explícitamente en una futura revisión de la matriz.
3. **`listAuthorizedStellaInteractions`/`getAuthorizedStellaInteraction` no tienen ningún consumidor todavía** (no existe UI de historial) — quedan listos para que una futura pantalla los use, pero no se construyó ninguna interfaz en este bloque (no solicitada, y el encargo permite omitirla si no hay una ubicación coherente).
4. **La política RLS y `canReadStellaInteraction` deben mantenerse sincronizadas manualmente** — un cambio futuro en una sin el equivalente en la otra reintroduciría una discrepancia entre lo que ve un cliente autenticado directo y lo que ve el servicio central. Documentado explícitamente en ambos archivos.

## 20. Trabajo no realizado (fuera de alcance, expresamente)

DR-004 (retención), ampliación de DR-001 (PII), umbral de agregación de DR-002/DR-003, Etapa A3, prompts por paso, sugerencias/reformulación, Evidence Intelligence, Proxy Intelligence, grounding/RAG/embeddings/pgvector, mecanismo de acceso excepcional auditado (documentado como tarea futura), UI de historial de Stella.

## 21. Estado del gate

Los 18 criterios de la sección 19 del encargo se cumplen: matriz coherente con la decisión aprobada; viewer sin acceso general; analyst dentro de su alcance real; organization_admin solo su organización; cross-org bloqueado; membresías inactivas bloqueadas; acceso del creador definido y probado; super_admin sin bypass general no auditado; RLS implementa la matriz; las lecturas Drizzle también la implementan (mismo servicio, misma fuente de verdad); privilegios de tabla mínimos (sin cambio, ya lo eran); consultas por ID sin enumeración; listados sin filas prohibidas; campos minimizados por vista; Stella sigue apagada; sin llamadas al modelo; sin datos remotos; pruebas aplicables en verde; documentación y código coinciden.

**Estado: `APROBADO`.**

## 22. Próximo bloque recomendado

Reglas de agregación de DR-002/DR-003 (umbral mínimo de agrupación para datos de menores/salud, condicionalmente aprobado por el propietario en el bloque de DR-001). **No se continúa automáticamente.**

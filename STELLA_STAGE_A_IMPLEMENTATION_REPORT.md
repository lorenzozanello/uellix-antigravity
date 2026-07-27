# Stella — Etapa A1: Bloque Técnico Inicial. Informe de implementación

**Fecha:** 2026-07-25
**Rama:** `feature/stella-generation-copilot`
**Commit base:** `4c8a8ed9537e4181229ce94f83ca6447db30b172` (docs(spec): Stella generation co-pilot design)
**Estado del working tree al cierre:** ningún commit creado (regla explícita de la sesión). Todos los cambios quedan sin confirmar, listos para revisión.

---

## ADENDA (Etapa A1.5, 2026-07-25)

Una sesión posterior identificó 5 reservas sobre el estado declarado por este informe y por `STELLA_STAGE_A_VALIDATION.json`, las verificó contra el código, y las cerró. Ver **`STELLA_STAGE_A15_CLOSURE_REPORT.md`** para el detalle completo. Resumen de lo que cambió respecto a lo declarado abajo:

- **§7, punto 2** ("`wrapUntrustedData` no está integrado en los 4 `buildXUserMessage`") — **ya no es cierto**. Etapa A1.5 integró el envoltorio en los 4 builders reales vía un compositor compartido (`lib/stella/prompts/build-runtime-message.ts`), preservando el mismo contenido/selección de campos, con 2 actualizaciones justificadas en `composer-system.test.ts` (formato, no contenido) y una nueva suite adversarial de 78 casos contra los builders reales.
- **§7, punto 1** ("no se estrechó el GRANT en esta sesión") — **ya no es cierto**. La migración `0043_stella_interactions_privilege_hardening.sql` revoca INSERT/UPDATE/DELETE de `authenticated`, verificado con `has_table_privilege`.
- El versionado de prompts y de esquema de contexto (§4.2) ahora tiene un control determinista de integridad (hash de contenido atado a la versión registrada) que antes no existía — ver `lib/stella/prompts/prompt-content-hash.ts` y `lib/stella/context/context-schema-descriptor.ts`.
- `STELLA_STAGE_A_VALIDATION.json` fue corregido (ver ese archivo): distingue ahora `untrustedPayloadIntegratedInRuntimeBuilders` de `untrustedPayloadUtilityImplemented`, y no vuelve a afirmar `structuralDataInstructionSeparation: true` de forma imprecisa.
- `pnpm build` (§6, antes omitido) se ejecutó de forma aislada y segura en Etapa A1.5, con variables forzadas a valores locales/sintéticos y verificación de host de loopback antes de construir.

El resto de este documento se conserva sin editar como registro histórico de lo que Etapa A1 (no A1.5) implementó y declaró en su momento.

---

## 1. Alcance de esta sesión

Se ejecutaron dos fases, en el orden pedido:

1. **Corrección del plan** — lectura y verificación contra el código de los 5 documentos de auditoría existentes (`STELLA_CURRENT_STATE_AUDIT.md`, `STELLA_CAPABILITY_MATRIX.md`, `STELLA_GAP_ANALYSIS.md`, `STELLA_IMPLEMENTATION_ROADMAP.md`, `STELLA_BACKLOG.csv`), producción de 5 documentos nuevos (`STELLA_REVISED_MASTER_PLAN.md`, `STELLA_REVISED_BACKLOG.csv`, `STELLA_DECISION_REGISTER.md`, `STELLA_THREAT_MODEL.md`, `STELLA_EVAL_STRATEGY.md`).
2. **Implementación de Etapa A1 únicamente** — los 14 ítems `STL-A1-001` a `STL-A1-014` del backlog revisado. Ninguna otra etapa (A2, A3, B, C, D, E, F) fue tocada más allá de su diseño documental en el plan maestro.

No se activó ningún flag de Stella, no se llamó al modelo real, no se usó ninguna base de datos remota, no se hicieron push ni commits, no se tocaron variables de Vercel.

---

## 2. Hallazgos verificados contra el código (correcciones al plan original)

| # | Hallazgo | Evidencia | Dónde se documenta |
|---|---|---|---|
| 1 | La migración `0033_public_api_grants.sql` otorga `SELECT, INSERT, UPDATE, DELETE` a `authenticated` sobre `stella_interactions`, agrupada junto a tablas de negocio normales — NO junto al grupo explícitamente etiquetado "Append-Only Tables (No UPDATE, No DELETE)" que sí limita correctamente `audit_logs`/`sroi_calculation_runs`/`sroi_calculation_line_items`. La garantía append-only de `stella_interactions` depende hoy de una sola capa (ausencia de política RLS permisiva), no de dos. | `db/migrations/0033_public_api_grants.sql:50` | `STELLA_REVISED_MASTER_PLAN.md§1`, `STELLA_THREAT_MODEL.md` (I4), `db/policies/002_stella_interactions_rls.sql` (nota de riesgo residual añadida), backlog `STL-A1-014`. Verificado empíricamente por `tests/integration/stella-interactions-rls.test.ts`: UPDATE/DELETE como `authenticated` afectan 0 filas — la capa única sostiene, pero sigue siendo una sola capa. |
| 2 | Ninguno de los 4 esquemas Zod de salida (`AdvisorOutputSchema`, `ValidatorOutputSchema`, `ComposerOutputSchema`, `ReviewerOutputSchema`) usa `.strict()`. Zod en modo "strip" por defecto elimina en silencio claves desconocidas en vez de fallar. El borrador inicial de `STELLA_EVAL_STRATEGY.md` asumía `.strict()` para el check `noForbiddenFields`. | `lib/stella/schemas/*.ts` (grep confirmó ausencia de `.strict()` en los 4 archivos) | `STELLA_EVAL_STRATEGY.md §5` (corrección documentada in situ), `tests/eval/rubric.ts` (el check compara las claves del JSON crudo, antes de Zod, contra las declaradas por el esquema — no infiere del resultado de `safeParse`). |
| 3 | La descripción original de `db/policies/002_stella_interactions_rls.sql` llamaba "service-role client" al mecanismo por el cual `recordStellaInteraction()` bypassa RLS. Verificado: `db/client.ts` usa `DATABASE_URL`, que en el stack local conecta como el rol `postgres` (superusuario, `BYPASSRLS`) — un mecanismo distinto de la clave `service_role` de la API de Supabase usada desde `supabase-js`. | `db/client.ts:5,8`; `.env.test.local` (`DATABASE_URL=postgresql://postgres:...`) | `db/policies/002_stella_interactions_rls.sql` (comentario corregido). |
| 4 | Retrotraer `wrapUntrustedData` a los 4 `buildXUserMessage` existentes en esta sesión rompería pruebas ya afinadas (p. ej. `composer-system.test.ts` afirma el formato exacto del bloque "Funder Breakdown"). | `lib/stella/prompts/composer-system.test.ts` (lectura completa) | `STELLA_REVISED_MASTER_PLAN.md §4`; adopción diferida a Etapa B (`STL-B-002`, `STL-B-003`). `wrapUntrustedData` se entrega construida y probada en aislamiento, sin integrar todavía. |

Ningún otro hallazgo material surgió de la verificación; el resto de las afirmaciones de los 5 documentos de auditoría (roles, flags, esquema de `stella_interactions` previo a esta sesión, patrón de pruebas RLS) coincidió con el código.

---

## 3. Documentos de planificación entregados

- `STELLA_REVISED_MASTER_PLAN.md` — diagnóstico validado, principios, Etapas A1–F, decisiones reversibles/irreversibles, diseño completo (no implementado) de `ai_provenance_links` y del Composer v2, estrategia de activación progresiva.
- `STELLA_REVISED_BACKLOG.csv` — 41 filas, 18 columnas, fuente de verdad que reemplaza conceptualmente a `STELLA_BACKLOG.csv`. Validado: 0 filas malformadas, 0 IDs duplicados, 0 dependencias colgantes, 0 inversiones de orden topológico (por `RecommendedOrder`).
- `STELLA_DECISION_REGISTER.md` — DR-001 a DR-011 (PII, menores, datos de salud, retención, consentimiento, DR-006 payload-vs-manifiesto ya resuelto en el código, DPA, región, embeddings, proxies).
- `STELLA_THREAT_MODEL.md` — STRIDE adaptado; incluye el hallazgo I4 (contradicción del grant 0033) y su cierre parcial vía `STL-A1-001`.
- `STELLA_EVAL_STRATEGY.md` — objetivo, 6 roles, catálogo de 30 casos (5/rol) comprometido para el primer gate, rúbrica de 9 checks booleanos, corrección documentada sobre `.strict()`.

---

## 4. Cambios de código (Etapa A1)

### 4.1 Migración aditiva

`db/migrations/0042_stella_traceability.sql` (+ entrada 43 en `db/migrations/meta/_journal.json`):
- Añade 4 columnas nullable a `stella_interactions`: `prompt_template_id`, `prompt_version`, `context_schema_version`, `context_manifest` (jsonb).
- Elimina el `DEFAULT 'gemini-2.0-flash'` de `model_used` (modelo ya retirado; el default ocultaba una desatribución silenciosa).
- Ninguna fila existente se modifica; ninguna columna nueva es `NOT NULL`.
- **Aplicada al stack local** (`pnpm db:migrate:local`) y verificada sin drift (`drizzle-kit check` → "Everything's fine").

`db/schema.ts` — `stellaInteractions` actualizado para reflejar exactamente las columnas anteriores, con comentarios que documentan la decisión de no tener default y de no guardar texto crudo en `context_manifest`.

### 4.2 Infraestructura nueva (`lib/stella/`)

| Archivo | Propósito | Backlog |
|---|---|---|
| `lib/stella/prompts/registry.ts` | Inventario central de `{templateId, version}` por rol. Única fuente de la versión de prompt. | STL-A1-002 |
| `lib/stella/context/schema-version.ts` | `CONTEXT_SCHEMA_VERSION` — constante única. | STL-A1-003 |
| `lib/stella/context/build-context-manifest.ts` | Manifiesto estructural: tipos de entidad, IDs, NOMBRES de campo (nunca valores), conteos, hash, flags de sensibilidad. Construido con literales de campo escritos a mano — estructuralmente imposible que filtre un valor real. | STL-A1-004 |
| `lib/stella/context/context-guardrails.ts` | `assertContextHasNoForbiddenData()` — control determinista que falla cerrado si un proxy trae valor/moneda no vacíos, un hash de evidencia no está truncado a 8 caracteres, la narrativa excede el techo de saneamiento, o un patrón prohibido sobrevivió al saneamiento por campo. | STL-A1-007 |
| `lib/stella/context/build-untrusted-payload.ts` | `wrapUntrustedData()` — envoltura JSON delimitada con advertencia explícita "dato, nunca instrucción". Construida y probada; **adopción en los 4 builders diferida a Etapa B** (ver hallazgo #4 arriba). | STL-A1-009 |
| `lib/stella/audit-log.ts` | `recordStellaInteraction()` — único punto de inserción en `stella_interactions`. Calcula `promptTemplateId`/`promptVersion` desde el registro y `contextManifest` desde el context builder, internamente. | STL-A1-006 |
| `lib/stella/errors.ts` (editado) | + `StellaContextGuardrailError`. | STL-A1-007 |
| `lib/stella/prompts/shared-guardrails.ts` (editado) | + regla 8: prohibición explícita de obedecer instrucciones incrustadas en datos. Aditivo, no renumera ni reemplaza las 7 reglas previas. | STL-A1-010 |

### 4.3 Wiring en las 4 acciones de servidor

`app/actions/stella/{advisor,composer,validator,reviewer}.ts` — en los 4 archivos:
- Se añadió `assertContextHasNoForbiddenData(context)` inmediatamente después de construir el contexto.
- Se reemplazó el `db.insert(stellaInteractions)...` manual por `recordStellaInteraction({...})`.
- Se añadió el código de error `CONTEXT_GUARDRAIL_FAILED` a la unión de errores de cada acción.
- Ningún cambio de comportamiento funcional visible para el usuario más allá del mensaje de error técnico cuando el guardrail dispara (caso que no ocurre con datos legítimos, verificado contra los mocks de prueba existentes antes de conectar el guardrail).

(Backlog STL-A1-008.)

### 4.4 Corrección documental

`db/policies/002_stella_interactions_rls.sql` — corregido el mecanismo de bypass de RLS (superusuario `postgres` vía `DATABASE_URL`, no "service-role client"), y añadida la nota de riesgo residual sobre el grant de la migración 0033. (STL-A1-014.)

---

## 5. Pruebas añadidas

| Archivo | Casos | Resultado |
|---|---|---|
| `lib/stella/prompts/registry.test.ts` | 4 | ✅ pasa |
| `lib/stella/context/__tests__/schema-version.test.ts` | 1 | ✅ pasa |
| `lib/stella/context/__tests__/build-context-manifest.test.ts` | 9 | ✅ pasa |
| `lib/stella/context/__tests__/context-guardrails.test.ts` | 7 | ✅ pasa |
| `lib/stella/context/__tests__/build-untrusted-payload.test.ts` | 8 | ✅ pasa |
| `lib/stella/__tests__/audit-log.test.ts` | 8 | ✅ pasa |
| `lib/stella/__tests__/anti-regression.test.ts` (adición) | +1 (total 19) | ✅ pasa |
| `tests/stella-adversarial.test.ts` (STL-A1-011, 10 payloads canónicos) | 21 | ✅ pasa |
| `tests/eval/run.test.ts` (STL-A1-012) | 14 | ✅ pasa |
| `tests/integration/stella-interactions-rls.test.ts` (STL-A1-001) | 6 | ✅ pasa (contra Supabase local) |

**Suite completa de Stella (unitaria):** 23 archivos, **460 pruebas**, todas verdes.
**Suite completa del proyecto (`pnpm test:unit`, excluye integración):** 87 archivos, **1151 pruebas**, todas verdes — cero regresiones fuera de Stella.
**Suite de integración (`pnpm test:integration`):** 4 archivos, **45 pruebas**, todas verdes (incluye la nueva prueba RLS y las 3 preexistentes, sin regresión).

### 5.1 Suite adversarial (STL-A1-011) — catálogo cubierto

1. Ignorar instrucciones previas — verificado vía envoltura de datos no confiable + regla 8 de `SHARED_GUARDRAILS`.
2. Instrucción de sistema falsa embebida — verificado que permanece como valor JSON inerte.
3. Solicitud de revelar el contexto — verificado que el manifiesto nunca lleva texto crudo.
4. Solicitud de recalcular el ratio SROI — verificado **estructuralmente**: ninguno de los 4 archivos de acción contiene `db.update(`/`db.delete(`/`.update(`/`.delete(`. No existe camino de escritura, independientemente de lo que "diga" el modelo.
5. Solicitud de aprobar un proxy — misma evidencia estructural que el caso 4.
6. Texto-instrucción incrustado en un título — verificado que el saneamiento por longitud y el guardrail de contexto lo detectan si escapa al saneamiento normal.
7. Contenido que rompe JSON — verificado que la envoltura produce JSON válido y no permite escapar la estructura.
8. Contenido extremadamente largo — verificado el techo de saneamiento (2000 caracteres) y que el guardrail rechaza una narrativa sin sanear que lo exceda.
9. Caracteres de control — verificado que se eliminan salvo salto de línea/tab.
10. Intento de cruzar organizaciones — verificado contra el builder real (`buildAdvisorContext`) con un proyecto mockeado de otra organización: lanza `UNAUTHORIZED`.

### 5.2 Arnés de evaluación (STL-A1-012) — qué existe y qué no

Existe: `tests/eval/{types,rubric,engine,run}.ts`, `tests/eval/cases/index.ts` (30 casos: 5 por rol × 6 roles, construidos con los prompt builders REALES, no prompts inventados), `tests/eval/run.test.ts` (14 pruebas unitarias contra un caller simulado).

**No se ejecutó ni una sola vez contra el modelo real en esta sesión.** `tests/eval/run.ts` verifica `STELLA_EVAL_REAL_MODEL === 'true'` como primera línea de `main()` y no se referenció desde ningún script `test`/`test:unit`/`test:integration`. `tests/eval/engine.ts` no importa `@/db/client` en ningún punto (verificado por prueba dedicada).
Pendiente para Etapa B: ampliar el catálogo a ≥10 casos/rol, ejecutar la primera corrida real revisada por un humano.

### 5.3 Prueba RLS de integración (STL-A1-001)

`tests/integration/stella-interactions-rls.test.ts`, ejecutada contra el stack local de Supabase (contenedores `db`/`auth`/`rest`/`kong` saludables; `supabase_vector` en reinicio, no relevante para RLS). El cliente de service role se usó **únicamente** para crear usuarios de auth y sembrar filas vía Drizzle — todas las aserciones se hicieron con el cliente autenticado real (`signInWithPassword` + clave anónima).

Resultado: 6/6 pruebas verdes — miembro de Org A lee su fila; miembro de Org B no la lee; usuario sin membresía no la lee; super_admin la lee; UPDATE afecta 0 filas y no altera el dato; DELETE afecta 0 filas y la fila sigue existiendo.

---

## 6. Validación final — comandos ejecutados y resultado exacto

| Comando | Resultado |
|---|---|
| `pnpm typecheck` | ✅ limpio, 0 errores |
| `pnpm lint` | ✅ 0 errores, 57 warnings (todos preexistentes; los 2 introducidos por esta sesión —`_args` sin usar en un mock, un `eslint-disable` sobrante— se corrigieron y quedaron en 0) |
| `pnpm exec vitest run lib/stella app/actions/stella components/stella tests/stella-quota.test.ts tests/stella-adversarial.test.ts tests/eval` | ✅ 23 archivos, 460 pruebas |
| `pnpm test:unit` (proyecto completo, excluye integración) | ✅ 87 archivos, 1151 pruebas |
| `pnpm db:migrate:local` | ✅ migración 0042 aplicada al stack local |
| `pnpm test:integration` | ✅ 4 archivos, 45 pruebas |
| `npx drizzle-kit check --config=drizzle.local.config.ts` | ✅ "Everything's fine" — sin drift |
| Validación de `STELLA_REVISED_BACKLOG.csv` (script Node ad-hoc, consciente de comillas CSV) | ✅ 41 filas, 18 columnas, 0 malformadas, 0 IDs duplicados, 0 dependencias colgantes, 0 inversiones de orden topológico (se corrigió una inversión menor entre STL-B-005/STL-B-006, fuera del alcance de Etapa A1 pero detectada durante esta verificación) |

**No ejecutado — `pnpm build`:** se omitió deliberadamente. Next.js lee `.env.local` por defecto en build, y ese archivo apunta al proyecto Supabase remoto (documentado en sesiones anteriores); no hay garantía de que ninguna ruta con generación estática dispare una consulta a esa base en build time. Dado que la regla explícita de esta sesión prohíbe tocar bases de datos remotas y prohíbe ejecutar comandos ambiguos que puedan hacerlo, se prefirió omitir el build antes que arriesgarlo. Recomendación: ejecutar `pnpm build` solo con `.env.local` temporalmente neutralizado o en un entorno CI que ya use variables locales/de staging.

**Confirmado explícitamente:**
- No se hizo ninguna llamada real a Gemini (`STELLA_EVAL_REAL_MODEL` nunca se estableció a `'true'`).
- No se escribió en ninguna base de datos remota (todas las escrituras fueron al stack local de Supabase, protegido por `db/guard.ts` vía `vitest.setup.integration.ts` y por `drizzle.local.config.ts`, ambos con guardas de host de loopback).
- No se activó `STELLA_ENABLED` ni ningún flag por rol.
- No se creó ningún commit ni se hizo push.
- No se almacenó contenido crudo nuevo en `stella_interactions` — solo el manifiesto estructural (nombres de campo, conteos, hash).
- No hay IDs duplicados en el backlog; todas las dependencias apuntan a tareas existentes; el orden es topológicamente válido.

---

## 7. Limitaciones y riesgos residuales

1. **Grant de la migración 0033** (hallazgo #1, §2) — la garantía append-only de `stella_interactions` vía PostgREST sostiene hoy sobre una sola capa (ausencia de política RLS permisiva). Se probó que esa capa sostiene; no se estrechó el `GRANT` en esta sesión (requeriría una migración adicional sobre permisos, fuera del alcance acordado de Etapa A1). Queda como tarea futura, no bloqueante porque la capa que existe ya se verificó.
2. **`wrapUntrustedData` no está integrado** en los 4 `buildXUserMessage` — existe y está probado en aislamiento, pero su adopción real queda para Etapa B (`STL-B-002`/`STL-B-003`), coordinada con quien mantiene las pruebas de formato exacto de esos builders.
3. **`tests/eval/` es un esqueleto**, no un arnés maduro — 30 casos (mínimo comprometido para el primer gate), nunca ejecutados contra el modelo real, sin revisión humana todavía. No autoriza activar ningún flag por sí solo.
4. **`ai_provenance_links`** — diseñado por completo en `STELLA_REVISED_MASTER_PLAN.md §6`, decisión explícita de no migrar todavía (no existe escritor real).
5. **Composer v2** (referencias estructuradas en vez de números libres) — diseñado en `STELLA_REVISED_MASTER_PLAN.md §7`, no implementado.
6. **`pnpm build` no se ejecutó** (§6) — riesgo de acceso remoto vía `.env.local`, no verificado en esta sesión.
7. **Etapas A2 (gobernanza de datos) y A3 (revisión legal)** — documentadas como decisiones pendientes en `STELLA_DECISION_REGISTER.md`, explícitamente no resueltas ni simuladas como resueltas.

---

## 8. Estado de cada tarea de Etapa A1

| ID | Título | Estado |
|---|---|---|
| STL-A1-001 | Pruebas de integración RLS de `stella_interactions` | ✅ Done — 6/6 pruebas contra Supabase local |
| STL-A1-002 | Registro central de plantillas de prompt | ✅ Done — 4/4 pruebas |
| STL-A1-003 | Versión del esquema de contexto | ✅ Done — 1/1 prueba |
| STL-A1-004 | Manifiesto estructural de contexto | ✅ Done — 9/9 pruebas |
| STL-A1-005 | Migración aditiva: columnas de trazabilidad | ✅ Done — aplicada local, sin drift |
| STL-A1-006 | Punto central de inserción en `stella_interactions` | ✅ Done — 8/8 pruebas |
| STL-A1-007 | Guardarrail determinístico de contexto | ✅ Done — 7/7 pruebas |
| STL-A1-008 | Wiring del guardarrail en las 4 acciones | ✅ Done — verificado sin regresión en 460 pruebas |
| STL-A1-009 | Utilidad de envoltura de datos no confiables | ✅ Done — 8/8 pruebas (integración diferida a Etapa B) |
| STL-A1-010 | Línea explícita en `SHARED_GUARDRAILS` | ✅ Done — verificado por anti-regression |
| STL-A1-011 | Suite adversarial estructural (10 payloads) | ✅ Done — 21/21 pruebas |
| STL-A1-012 | Esqueleto del arnés de evaluación | ✅ Done — 14/14 pruebas, nunca llamó al modelo real |
| STL-A1-013 | Migración aditiva: eliminar DEFAULT obsoleto de `model_used` | ✅ Done — parte de la migración 0042 |
| STL-A1-014 | Corrección documental: mecanismo de inserción y grant contradictorio | ✅ Done |

---

## 9. Formato de respuesta final

Ver mensaje de cierre de la conversación (Estado / Cambios / Validación / Decisiones pendientes / Próximo bloque recomendado), que resume este informe. Este documento es la fuente detallada; `STELLA_STAGE_A_VALIDATION.json` es su versión estructurada para lectura programática.

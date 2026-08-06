# STELLA — Registro de riesgos de staging hosted

> Fases 8 y 11 de `STELLA_TRAIN_5A_HOSTED_STAGING_READINESS_AUDIT`.
> HEAD `2de1050`. Auditoría read-only.
>
> **Regla aplicada:** ningún riesgo se rebaja porque localmente pasara. Que un
> paquete corra en un contenedor desechable con superusuario no dice nada sobre
> una plataforma gestionada sin él.

---

## 1. Fase 8 — Contratos pendientes

### INT-GR-001 — Lectura gobernada de versión activa

| Campo | Contenido |
|---|---|
| **Estado** | `solicitado` (`CONTRACT_LEDGER.md:30`), «defecto acotado», propietaria reasignada a **CAPABILITIES** |
| **Defecto** | `claim_active_document_version` reimpone la frontera de **organización** (`v_org = ANY(current_user_org_ids())`) y **no filtra `project_id`**: su predicado final es `v.evidence_id = p_evidence_id` a secas. Un `evidence_id` de otro proyecto de la misma organización se responde. Devuelve siete columnas y **ninguna es scope**, así que el llamante tampoco puede detectarlo |
| **Mitigación existente** | `db/grounding/grounding-ingestion-repository.ts` reimpone el proyecto localmente con un `SELECT` scoped antes de nombrar la evidencia. **Mitigado, no cerrado** — y explícitamente **no** se declara cerrado por el hecho de que el llamante conozca el scope |
| **¿Bloquea staging técnico?** | **No.** La ruta afectada es de ingesta y la mitigación en TypeScript es efectiva mientras nadie llame a la función desde SQL |
| **¿Bloquea piloto?** | **Sí, condicional.** Un piloto con dos proyectos reales en una organización real hace alcanzable el cruce si aparece cualquier segundo llamante |
| **¿Bloquea producción comercial?** | **Sí.** Es un defecto de aislamiento entre proyectos en la ruta de evidencia |
| **Evidencia para cerrarlo** | Un paquete SQL nuevo: repararlo cambia el tipo de retorno, que `CREATE OR REPLACE` prohíbe (`42P13`) |
| **Workstream propietario** | CAPABILITIES |

### INT-GR-003 — `ChunkLocation` no reconstruible

| Campo | Contenido |
|---|---|
| **Estado** | `solicitado` — «decidido, SQL pendiente» (`CONTRACT_LEDGER.md:32`) |
| **Defecto** | `line_start`/`line_end` no se persisten. Son posiciones en el texto normalizado del **documento entero**, y `chunks_in_scope` devuelve el texto de **un** chunk: no son reconstruibles |
| **Decisión tomada** | GROUNDING eligió **persistir las dos columnas**, y descartó hacerlas nulables (rompería `components/stella/grounding-adapter.ts` y el harness de RELEASE, rutas ajenas). `LINE_RANGE_NOT_PERSISTED = 0` es explícito y fuera del dominio 1-based, de modo que «no recuperable» es distinguible de un número plausible pero equivocado |
| **¿Bloquea staging técnico?** | **No.** La limitación está representada sin inventar datos |
| **¿Bloquea piloto?** | **No**, con reserva: la UI muestra «líneas N-M» y con `0` la etiqueta pierde utilidad |
| **¿Bloquea producción comercial?** | **Sí para claims de auditoría por rango de líneas.** No para el producto en general |
| **Evidencia para cerrarlo** | Dos columnas en `evidence_chunks` + backfill imposible para chunks ya persistidos (el paquete tendría que declararlo) |
| **Workstream propietario** | CAPABILITIES (el SQL); GROUNDING ya cerró su mitad |

### INT-PR-001 — Clave canónica de decisión

| Campo | Contenido |
|---|---|
| **Estado** | `solicitado` (`CONTRACT_LEDGER.md:33`), propietaria **PRODUCT** |
| **Defecto** | `recordStellaDecision` se ancla en `suggestionKey`. Una respuesta fundamentada **no es una sugerencia**: lleva afirmaciones verificadas con citas respaldadas por hash. Reutilizar la clave archivaría dos entidades distintas en una tabla y haría que «¿esto se guardó?» tuviera dos respuestas divergentes |
| **Mitigación existente** | El wrapper **no cablea `onDecision`**. El panel emite la decisión a nadie, no afirma persistencia, y `STELLA_DECISIONS_PERSISTENCE_ENABLED` sigue en `false`. El E2E lo comprueba **contando filas** |
| **¿Bloquea staging técnico?** | **No** — mientras el flag siga en `false` |
| **¿Bloquea piloto?** | **Sí.** Un piloto sin poder persistir la decisión humana sobre una respuesta fundamentada pierde el bucle de calidad |
| **¿Bloquea producción comercial?** | **Sí.** Y **encender `STELLA_DECISIONS_PERSISTENCE_ENABLED` sin cerrarlo es peor que dejarlo apagado** |
| **Evidencia para cerrarlo** | Una clave anclada en `answerId` (que el servidor ya genera) **o** una demostración de que `suggestionKey` representa la misma entidad |
| **Workstream propietario** | PRODUCT |

> Ninguno de los tres se cierra por inferencia en esta auditoría. Los tres
> siguen `solicitado` en el ledger y en las secciones de cierre de los trenes
> 4.2, 4.3 y 4.3c.

---

## 2. Fase 11 — Matriz de riesgos

### 2.1 BLOCKER

> **ACTUALIZACIÓN Train 5B (2026-08-06).** **B1 y B5 quedan CERRADOS por diseño,
> pendientes de verificación hosted.** B2, B3 y B4 siguen abiertos y cualquiera
> de ellos basta para impedir el inicio de la aplicación real.

| # | Riesgo | Estado medido | Evidencia | Qué lo cierra |
|---|---|---|---|---|
| **B1** | **Paquetes incompatibles con la plataforma hosted** | **CERRADO POR DISEÑO · pendiente de verificación hosted** | Train 5B: `stella_hosted_0001_managed_role_bootstrap.sql` + 9 artefactos derivados con guarda de capacidades en lugar de `rolsuper`. Los canónicos no se editaron. 156 pruebas hosted verdes, incluida una mutación que confirma que las aserciones muerden | Ya no exige elegir plataforma. **Queda por medir en hosted:** RR-09 (E5b del bootstrap), PostgreSQL ≥ 17 del proyecto y RR-03 — CHECKPOINT A / gate G12 |
| **B2** | **Staging no aislado** | **PRESENTE** | Cero de seis señales de entorno hosted en el árbol. Ningún project ref, dominio, deployment target, base ni secreto de staging | Aprovisionar el entorno y versionar ≥ 2 señales independientes |
| **B3** | **Clave de proveedor sin rotación de ámbito staging** | **PRESENTE** | Rotación de 2026-07-10 evidenciada **para Vercel/producción**. Sin procedimiento de clave de staging, sin gestor de secretos de staging, sin prueba de invalidez de la anterior | Procedimiento escrito + ejecución + evidencia (sin exponer valores) |
| **B4** | **Credenciales ambiguas** | **PRESENTE** | `.env.example` declara `DATABASE_URL`, que `resolve-capability-database-url.ts:107-121` **ignora con aviso**, y **omite** `UELLIX_RUNTIME_DATABASE_URL`, `UELLIX_MIGRATOR_DATABASE_URL`, `UELLIX_AUDITOR_DATABASE_URL` y `UELLIX_APP_ENV`. Un `UELLIX_APP_ENV` ausente o con errata resuelve a **`production`** | Sincronizar `.env.example` (INTEGRATION-OWNED) |
| **B5** | **Rol migrator insuficiente / inexistente en hosted** | **CERRADO POR DISEÑO** | `uellix_migrator` lo crea ahora el bootstrap hosted, con `SET TRUE, INHERIT FALSE` sobre `uellix_owner` y una postcondición que lo afirma. `db/migrator.ts` sigue pidiendo `local_migration` **a propósito** —ampliarlo habría destruido el límite— y la superficie hosted es `db/hosted/hosted-migrator.ts`, un planificador puro que no abre conexión | Ejecutar el plan es una unidad posterior, deliberadamente no cableada |
| **B6** | **RR-02 — el instalador retiene ADMIN OPTION sobre los roles que crea** | **PRESENTE, NO CERRABLE** | PostgreSQL 16+ auto-concede `ADMIN OPTION` a un CREATEROLE no superusuario. `postgres` puede `GRANT uellix_owner TO postgres WITH SET TRUE` en cualquier momento | Nada, en Supabase gestionado. Se acepta explícitamente: la separación es un **obstáculo auditable**, no una barrera. El bootstrap lo emite como NOTICE y el centinela lo registra en `owner_separation` |

### 2.2 MAJOR

| # | Riesgo | Estado | Evidencia | Nota |
|---|---|---|---|---|
| **M1** | **Los guards de orden de paquetes no corren por la vía hosted** | **PRESENTE** | `assertPreparedPackageOrder` vive en `db/migrator.ts` (capacidad `local_migration`). La vía hosted prevista es `psql` manual | El orden pasa a depender del operador. Las aserciones internas de cada paquete son fail-closed pero informan un **número**, no un motivo |
| **M2** | **Ausencia de teardown para el ledger** | **ESTRUCTURAL** | `stella_interactions` es append-only para **todo** rol, incluido el owner (`trg_stella_interactions_append_only`). Las filas de un E2E en staging **no se pueden borrar** | Staging quedará con historia sintética permanente. Debe decidirse **antes** de escribir la primera fila |
| **M3** | **Rollback inseguro / asimétrico** | **DECLARADO** | Tres rollbacks no revierten por diseño: `stella_0002b` (`SAFE_NON_REVERSING_ROLLBACK`), `stella_0017` (no restaura escritura directa ni retira el CHECK), `grounding_0004` (**reabre INT-CAP-002** y lo anuncia con `RAISE WARNING`). `stella_0013_rollback` **puede negarse** legítimamente | Es correcto, pero un plan que prometa «revertir limpio» estaría mintiendo |
| **M4** | **Re-aplicación silenciosa de `grounding_0003`** | **PRESENTE** | Re-aplicarlo solo revierte las dos reparaciones de `grounding_0004`: reabre INT-CAP-002 y deja **toda lectura gobernada en conjunto vacío**. *«Un GRANT ausente lanza; una POLICY ausente calla»* | La cadena de grounding se aplica **entera como unidad**, siempre |
| **M5** | **Observabilidad insuficiente** | **PRESENTE** | `NEXT_PUBLIC_SENTRY_DSN` tiene **fallback silencioso**: sin DSN, Sentry no reporta y nada avisa. Ninguna variable de Sentry es fail-closed | En el entorno donde más se necesita, la ausencia es invisible |
| **M6** | **Extensiones ausentes** | **BAJO, pero requiere verificación** | La cadena vigente **no necesita** pgcrypto, pgvector, pg_cron ni pg_net (verificado archivo por archivo). Sí necesita **PG ≥ 17** (`MAINTAIN`) y `gen_random_uuid()` builtin (PG13+) | El riesgo real no es una extensión: es la **versión** |
| **M7** | **Historial incompatible con R6h** | **CONDICIONAL** | El CHECK es `NOT VALID` precisamente porque la historia no lo satisface. **Pero el paquete aborta si lo encuentra VALIDADO** | Un operador que «complete» el gate validando la constraint rompe la re-aplicabilidad de `stella_0017`. Ver plan §3.3 |
| **M8** | **Contratos pendientes** | **PRESENTE** | INT-GR-001 (aislamiento entre proyectos en ingesta), INT-GR-003, INT-PR-001 | §1 |
| **M9** | **Secretos compartidos con producción** | **RIESGO DE DISEÑO** | `RESEND_API_KEY` y `STRIPE_SECRET_KEY` no tienen separación declarada por entorno. Una clave de Resend compartida envía **correo real a destinatarios reales** desde staging; una clave Stripe `live` **cobra de verdad** | Debe declararse explícitamente como parte del aprovisionamiento |
| **M10** | **Un staging sin `NEXT_PUBLIC_SITE_URL` se publica bajo la identidad de producción** | **PRESENTE** | `lib/site.ts:16-27`: `resolveSiteUrl()` cae en cadena a `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` y por último al literal `https://uellix-antigravity.vercel.app`. `siteUrl` alimenta `metadataBase`, canonicals, OpenGraph, el JSON-LD de Organization, `app/robots.ts` y `app/sitemap.ts` | Un deployment de staging que omita la variable emitiría un `sitemap.xml` y canonicals apuntando a producción — contaminación de indexación cruzada entre entornos, y una señal de identidad equivocada en datos estructurados. **Declarar `NEXT_PUBLIC_SITE_URL` es obligatorio en el aprovisionamiento de staging**, además de `noindex` |

### 2.3 MINOR

| # | Riesgo | Estado | Nota |
|---|---|---|---|
| **m1** | Variables consumidas y no documentadas | `STELLA_MAX_OUTPUT_TOKENS`, `STELLA_TEMPERATURE`, `STELLA_MAX_PROMPT_CHARS` se leen en `lib/stella/config.ts` y no están en `.env.example`. Todas con fallback razonable |
| **m2** | Falta de datos de prueba en staging | No existe seed de staging. `scripts/seed-stella-local.ts` tiene guarda de host **y** deja de funcionar tras `stella_0017` (escribe el ledger sin clave) |
| **m3** | `STELLA_RATE_LIMIT_PER_HOUR` con fallback `100` | Alto para un piloto; debe fijarse explícitamente |
| **m4** | `NEXT_PUBLIC_APP_URL` / `SITE_URL` con fallback a `localhost:3000` | Enlaces de invitación rotos o cruzados entre entornos |
| **m5** | `NEXT_PUBLIC_GEMINI_API_KEY` referenciada en el árbol | Cualquier valor se inlinearía en el bundle del navegador. Debe quedar **prohibida por escrito** en el aprovisionamiento |
| **m6** | KV con fallback en memoria per-instance | RK-24, avisado once-per-process. El rate limit efectivo no es global en serverless |

### 2.4 Riesgos que la instrucción listó y NO están presentes

Se declaran explícitamente para que la ausencia sea una afirmación y no un olvido:

| Riesgo | Estado | Evidencia |
|---|---|---|
| **Feature flags activados** | **AUSENTE** | Los nueve `STELLA_*` en `false` en `.env.example`; semántica `=== 'true'` (cualquier otro valor es `false`) |
| **Proveedor sin límites** | **AUSENTE** | `maxOutputTokens` 4096, `temperature` 0.2, `maxPromptChars` 120000, `requestTimeoutMs` 15000, pacing ≥ 10 s y tope de llamadas sin reintentos en el runner de G1 |
| **Logs sensibles** | **AUSENTE en los caminos auditados** | `describeError()` en todos los `catch` finales; `redactHost`; el mensaje del ORM (que incrusta SQL y **parámetros ligados**) se descarta por completo; `buildGeminiErrorLog` con clave redactada. **Reserva:** no se auditó salida real de logs hosted, porque no hay entorno hosted |
| **Uso de `service_role`** | **AUSENTE de la cadena** | Ninguna ruta nueva lo usa; `stella_0017` §1 le **revoca** INSERT sobre el ledger. Sólo `scripts/create-test-user.ts` lo lee, y no forma parte de ningún checkpoint |

---

## 3. Conteo

| Severidad | Cantidad | Tras Train 5B |
|---|---|---|
| BLOCKER | **6** (B1-B6) | **3 abiertos** (B2 staging no aislado, B3 clave sin rotar, B4 credenciales ambiguas) · 2 cerrados por diseño (B1, B5) · 1 aceptado como no cerrable (B6/RR-02) |
| MAJOR | **10** (M1-M10) | M1 **mitigado** (el planificador hosted evalúa las supersesiones antes de emitir el plan); el resto sin cambios |
| MINOR | **6** (m1-m6) | sin cambios |

> **M10 lo aportó la revisión adversarial de la Fase 12** (revisor Sonnet,
> sólo lectura), que además refutó una afirmación absoluta de la primera
> redacción («ninguna URL hosted en el árbol»). La afirmación se corrigió en
> `STELLA_TRAIN_5A_READINESS.md` §3 y en
> `STELLA_HOSTED_ENVIRONMENT_MATRIX.md` §1/§1.1/§2.8. El veredicto de bloqueo
> no cambia: la señal encontrada es de **producción**, y la Fase 4 exige dos
> señales independientes de **staging**.

**Cualquiera de los tres BLOCKER abiertos es suficiente para impedir el inicio de
la aplicación real.** El de mayor profundidad ya no es B1 sino **B2**: no existe
el proyecto de staging, y sin él no hay adónde conectarse ni siquiera para la
inspección de sólo lectura. Los pasos concretos están en
[`STELLA_STAGING_PROVISIONING_REQUIREMENTS.md`](STELLA_STAGING_PROVISIONING_REQUIREMENTS.md).

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
| **m1** | Variables consumidas y no documentadas | `STELLA_MAX_OUTPUT_TOKENS` y `STELLA_MAX_PROMPT_CHARS` se leen en `lib/stella/config.ts` y no están en `.env.example`. Ambas con fallback razonable. **Actualizado en G1-M0:** `STELLA_TEMPERATURE` sale de esta lista porque ya **no se consume** — `temperature` fue eliminada de la request (deprecated para Gemini 3.6 Flash) y del tipo `StellaAdapterConfig`; fijarla no tiene efecto |
| **m2** | Falta de datos de prueba en staging | No existe seed de staging. `scripts/seed-stella-local.ts` tiene guarda de host **y** deja de funcionar tras `stella_0017` (escribe el ledger sin clave) |
| **m3** | `STELLA_RATE_LIMIT_PER_HOUR` con fallback `100` | Alto para un piloto; debe fijarse explícitamente |
| **m4** | `NEXT_PUBLIC_APP_URL` / `SITE_URL` con fallback a `localhost:3000` | Enlaces de invitación rotos o cruzados entre entornos |
| **m5** | `NEXT_PUBLIC_GEMINI_API_KEY` referenciada en el árbol | Cualquier valor se inlinearía en el bundle del navegador. Debe quedar **prohibida por escrito** en el aprovisionamiento |
| **m6** | KV con fallback en memoria per-instance | RK-24, avisado once-per-process. El rate limit efectivo no es global en serverless |
| **m7** | **G1-B PRECONDITION / DATABASE DEFAULT HYGIENE** | `db/schema.ts` declara `stella_interactions.model_used` con `DEFAULT 'gemini-2.0-flash'` — un modelo retirado por Google (404 desde 2026-07). **Inocuo hoy:** el camino gobernado (`complete_operation_ticket`) siempre suministra `model_used` desde `StellaResponse.modelUsed`, así que el default de columna nunca se ejerce; una fila con ese valor sólo podría venir de un INSERT que omitiera la columna, y `uellix_app` no tiene esa ruta. **No corregido en G1-M0** porque exige una migración Drizzle y no tiene efecto sobre G1-A. **Acción:** alinear el default (o eliminarlo, que es la opción más honesta: un default de modelo en la BD es una fuente de verdad duplicada frente a `STELLA_DEFAULT_GEMINI_MODEL`) como precondición de G1-B |

### 2.4 Riesgos que la instrucción listó y NO están presentes

Se declaran explícitamente para que la ausencia sea una afirmación y no un olvido:

| Riesgo | Estado | Evidencia |
|---|---|---|
| **Feature flags activados** | **AUSENTE** | Los nueve `STELLA_*` en `false` en `.env.example`; semántica `=== 'true'` (cualquier otro valor es `false`) |
| **Proveedor sin límites** | **AUSENTE** | `maxOutputTokens` 4096, `temperature` 0.2, `maxPromptChars` 120000, `requestTimeoutMs` 15000, pacing ≥ 10 s y tope de llamadas sin reintentos en el runner de G1 |
| **Logs sensibles** | **AUSENTE en los caminos auditados** | `describeError()` en todos los `catch` finales; `redactHost`; el mensaje del ORM (que incrusta SQL y **parámetros ligados**) se descarta por completo; `buildGeminiErrorLog` con clave redactada. **Reserva:** no se auditó salida real de logs hosted, porque no hay entorno hosted |
| **Uso de `service_role`** | **AUSENTE de la cadena** | Ninguna ruta nueva lo usa; `stella_0017` §1 le **revoca** INSERT sobre el ledger. Sólo `scripts/create-test-user.ts` lo lee, y no forma parte de ningún checkpoint |

---

## 2b. Riesgos que aportó Train 5C0 (2026-08-07)

Los dos primeros son **defectos encontrados y cerrados por diseño en este mismo
train**; se registran porque un defecto que nadie anota es un defecto que la
próxima refactorización reintroduce.

### CERRADOS POR DISEÑO

| # | Riesgo | Evidencia | Cierre |
|---|---|---|---|
| **B7** | **La cadena baseline que el contrato especificaba no era ejecutable.** `0039_grant_rls_helper_execution.sql` hace `GRANT EXECUTE` sobre dos funciones que sólo crea `supabase/migrations/20260716000001_storage_policies.sql`, ausente de A1 y de A2. Aplicar «0000…0039» aborta con `42883` | Reproducido: `scripts/baseline-rehearsal-local.ts` RUN A falla en 0039 contra una base desechable | `db/hosted/baseline-manifest.ts` fija 50 unidades y el orden real; `pnpm baseline:verify` |
| **B8** | **Centinela circular.** `verifyStagingTarget()` exigía la fila de `staging_sentinel` en **todo** plan, y `stella_hosted_0001` es el paquete que crea su tabla. Una primera provisión era imposible de planificar. El test de Train 5B que afirmaba `HOSTED_TARGET_SENTINEL_MISSING` sobre la cadena completa **codificaba el bloqueo como si fuera una propiedad de seguridad** | `tests/hosted/hosted-migrator.test.ts` (antes de este train) | `SentinelPolicy` + fases; el centinela pasa de precondición a frontera. Test de regresión: «REGRESSION: a first provisioning can now be PLANNED at all» |

### ABIERTOS

> **Los ocho riesgos siguientes los aportó la revisión adversarial de la Fase 15**
> (revisor Fable y revisor Sonnet, ambos sólo lectura). Entre los dos
> devolvieron 7 BLOCKER y 10 MAJOR; los confirmados se corrigieron en el mismo
> train y se registran aquí porque un defecto que nadie anota es un defecto que
> la próxima refactorización reintroduce. Cinco de ellos eran **afirmaciones
> falsas de este train sobre su propio trabajo**, que es la clase de hallazgo
> por la que existe la revisión.

#### RR-12 — `CREATE TRIGGER ON auth.users` en gestionado, sin verificar

| Campo | Contenido |
|---|---|
| **Severidad** | **MAJOR** |
| **Defecto** | `supabase/migrations/20260716000000_auth_trigger.sql` crea dos triggers sobre `auth.users`. El esquema `auth` pertenece a `supabase_auth_admin`; si el rol `postgres` de un proyecto gestionado de 2026 aún puede crear triggers ahí es un hecho **sobre ese proyecto** |
| **Por qué no se cierra offline** | Misma clase que RR-09. Localmente funciona, y funcionar localmente **no es evidencia**: el shim del ensayo crea el esquema `auth` nosotros mismos, de modo que somos sus dueños y toda pregunta de privilegio se responde trivialmente y mal |
| **Clasificación** | La única unidad **clase C** de las 50 en `db/hosted/baseline-manifest.ts` |
| **Mitigación** | El runner debe sondear el privilegio **antes** de la fase y negarse, en vez de descubrirlo a mitad de cadena. Si falla, la unidad 40 está en el tramo donde la recuperación es `DESTROY_AND_REPROVISION` |
| **Cierre** | Sólo medible contra el proyecto de staging real, en CHECKPOINT B0 |

#### RR-13 — La policy `anon INSERT` de 008 es inerte por ausencia, no por diseño

| Campo | Contenido |
|---|---|
| **Severidad** | **MAJOR** |
| **Defecto** | `db/policies/008_marketing_leads_rls.sql` crea `anon_insert_marketing_leads … TO anon WITH CHECK (true)`. Es una ampliación de permisos sobre papel |
| **Por qué hoy no abre nada** | `marketing_leads` la crea `0035`, es decir **después** de la barrida de grants de `0033`, así que `anon` no tiene privilegio de tabla alguno sobre ella. RLS es la segunda puerta y no hay primera. **Verificado, no supuesto**: no existe ningún `GRANT` que nombre `marketing_leads` en las 50 unidades |
| **Por qué sigue abierto** | Depende de una **ausencia**. Un `GRANT INSERT ON marketing_leads TO anon` futuro —o un `ALTER DEFAULT PRIVILEGES` que lo alcance— convierte la policy en una ruta de escritura pública no autenticada, en staging, sin que nada más cambie |
| **Mitigación** | Postcondición **B0-10**: afirma que `anon` no tiene privilegio de tabla alguno en `public`, con control negativo que inyecta exactamente ese grant |
| **Cierre** | Product decide si el formulario público de leads debe existir en staging. Si no, retirar la policy es más barato que vigilarla |

#### RR-14 — `db/baseline/` no es el baseline

| Campo | Contenido |
|---|---|
| **Severidad** | **MINOR**, con potencial de escalar |
| **Defecto** | A1 dice «baseline» y existe un directorio llamado `db/baseline/`. No es lo mismo: contiene `stella_g2_schema.sql`, un `pg_dump` de una base Supabase con esquemas `auth`/`storage`/`realtime`/`graphql` que un proyecto gestionado provee por su cuenta |
| **Riesgo** | Un operador que «aplique el baseline» leyendo el nombre del directorio restauraría un volcado sobre un proyecto nuevo, peleándose con la plataforma |
| **Mitigación** | `BASELINE_DELIBERATE_EXCLUSIONS` lo enumera con su motivo, y un test afirma que ninguna unidad del manifiesto sale de `db/baseline/` |
| **Cierre** | Renombrar el directorio. No se hizo aquí: la instrucción de este train prohíbe tocar `db/baseline/**` |

#### RR-15 — `0033` concede `ALL PRIVILEGES` a `service_role`

| Campo | Contenido |
|---|---|
| **Severidad** | **MINOR** mientras no se aprovisione la clave |
| **Defecto** | `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role` más `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO postgres, service_role` |
| **Compensación** | §4.4 prohíbe aprovisionar `SUPABASE_SERVICE_ROLE_KEY`; `stella_0017` revoca después la escritura del ledger a todo principal de runtime. Un privilegio como el que nadie puede autenticarse es un privilegio que nadie tiene |
| **Por qué se registra igual** | Es un privilegio, no su ausencia. La compensación es una decisión de entorno que puede revertirse sin tocar SQL |

#### RR-16 — `db/policies/008` no es idempotente

| Campo | Contenido |
|---|---|
| **Severidad** | **MINOR** |
| **Defecto** | Única unidad de las 50 cuyas `CREATE POLICY` no llevan `DROP POLICY IF EXISTS`. Una segunda aplicación levanta `42710 duplicate_object` |
| **Mitigación** | `reapply: 'refuses-on-reapply'` en el manifiesto; el runner debe sondear y saltar, nunca reintentar a ciegas |

#### RR-17 — `storage.objects` exige **propiedad**, no un privilegio

| Campo | Contenido |
|---|---|
| **Severidad** | **MAJOR**, corregido en clasificación, **abierto** en verificación |
| **Defecto** | `20260716000001_storage_policies.sql` estaba clasificada **B**. Crea tres `CREATE POLICY ON storage.objects`, y `CREATE POLICY` exige **ownership** de la tabla — un requisito **más estricto** que el privilegio `TRIGGER` por el que la unidad 40 sí era C. `db/baseline/stella_g2_schema.sql:5061` muestra `ALTER TABLE storage.objects OWNER TO supabase_storage_admin` |
| **Consecuencia si falla** | Aborto en la unidad **41 de 50**, con 40 unidades ya comprometidas → `DESTROY_AND_REPROVISION`. Justo el descubrimiento a media cadena que la clasificación existe para evitar |
| **Corrección** | Reclasificada a **C**; `PrivilegeProbes.ownsStorageObjects` es ahora obligatoria y `PHASE_BASELINE` se niega sin ella |
| **MEDIDO 2026-08-07** | **`ownsStorageObjects = FALSE`.** La sonda se ejecutó contra Uellix Staging y confirmó la incompatibilidad **antes** de aplicar unidad alguna. Clasificación: **BLOCKED**, no `REQUIRES_REHEARSAL` — el catálogo respondió, no es una incógnita |
| **Matiz que nos favorece** | La unidad **no** emite `ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY`, que es la causa de la mayoría de reportes y que Supabase rechaza por diseño. Nuestro bloqueo es el requisito de propiedad de `CREATE POLICY` en sí |
| **Adaptación** | [`STELLA_STORAGE_POLICY_ADAPTATION.md`](STELLA_STORAGE_POLICY_ADAPTATION.md): variante hosted derivada que omite el bloque de `storage.objects`; las tres policies pasan a ser un paso de operador por Dashboard/SQL Editor, verificado por **B0-08** |
| **Cierre** | Pendiente de las sondas 4 y 5 (identidad de apply y `MEMBER` sobre `supabase_storage_admin`), que deciden **cuál** adaptación aplica |

#### RR-18 — El bucket `uellix-evidence` no lo crea nadie en hosted

| Campo | Contenido |
|---|---|
| **Severidad** | **MAJOR** |
| **Defecto** | `supabase/config.toml:132` declara `[storage.buckets.uellix-evidence]`, así que el stack local lo crea al arrancar. **Ninguna** de las 50 unidades lo crea, y las tres policies de `storage.objects` filtran por `bucket_id = 'uellix-evidence'`. `0031:424` ya decía que debía crearse a mano |
| **Consecuencia** | Un staging aprovisionado exactamente según el plan tendría policies de evidencia protegiendo un bucket inexistente; toda subida y toda lectura fallarían por un motivo que ninguna comprobación buscaba |
| **Por qué importa el patrón** | Es **la misma asimetría local/hosted que ocultó el defecto de 0039**, en un segundo sitio. Que apareciera dos veces sugiere buscarla una tercera |
| **Corrección** | `PrivilegeProbes.evidenceBucketExists` + postcondición **B0-15** |
| **MEDIDO 2026-08-07** | **`evidenceBucketExists = FALSE`.** El bucket no existe en Uellix Staging. Clasificación: **MISSING** |
| **Estado** | **ABIERTO, y sin corregir a propósito**: el operador difirió la creación del bucket a un paso posterior. B0-15 lo exigirá |

#### RR-19 — Afirmaciones falsas de Train 5C0 sobre su propio trabajo

Cinco, todas corregidas, todas encontradas por revisión adversarial y ninguna por
las pruebas:

| # | Afirmación | Realidad | Corrección |
|---|---|---|---|
| 1 | «`marketing_leads`: ningún rol tiene privilegio alguno sobre ella» | `0033` línea 13 hace `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO postgres, service_role`, y `marketing_leads` se crea después. `stella_g2_schema.sql:11091` muestra el grant materializado. La búsqueda léxica no podía encontrarlo: un default-privilege nunca nombra la tabla | Nota corregida; **B0-10** pasa a `aclexplode` |
| 2 | «las postcondiciones afirman la ausencia de `SUPABASE_SERVICE_ROLE_KEY`» | Ninguna lo hacía. Las 13 eran consultas de catálogo | **B0-14** añadida, como atestación del operador y declarada como tal |
| 3 | **B0-11** usaba `n_live_tup` | El propio ensayo de este train lo rechaza por escrito: una tabla sin `ANALYZE` reporta 0 tenga filas o no. Se le entregaba al operador la consulta que el ensayo desconfía | `count(*)`, y cobertura de **todas** las tablas |
| 4 | **B0-10** usaba `information_schema.role_table_grants` | `db/audit/canonical_acl.sql` la **prohíbe** como criterio de gate, con motivo medido: no puede expresar `PUBLIC`, y lo que se concede a `PUBLIC` lo tiene `anon` | `aclexplode` + `COALESCE(acldefault(...))`, cubriendo `PUBLIC` |
| 5 | «el runner debe sondear el privilegio de clase C» | Lo prometía la nota del manifiesto; nada lo implementaba | `PrivilegeProbes` + refutación antes de planificar |

#### RR-20 — El escáner era ciego a la sustancia del control de acceso

| Campo | Contenido |
|---|---|
| **Severidad** | **BLOCKER**, cerrado |
| **Defecto** | El manifiesto fijaba **conteos** de policies y de funciones `SECURITY DEFINER`, no su **contenido**. Cambiar `USING (id = auth.uid())` por `USING (true)`, o el cuerpo de `current_user_is_super_admin()` por `SELECT true`, no movía ni un conteo. Sólo cambiaba el SHA del archivo — que cambia con cualquier edición y que un revisor actualiza como trámite. Resultado: todo usuario autenticado sería super admin y el diff no tendría nada que objetar |
| **Corrección** | `securitySurfaceDigest`: SHA-256 sobre todo predicado `USING`/`WITH CHECK`/`TO` y todo cuerpo de definer, fijado por unidad |

#### RR-21 — Las sondas de vacuidad omitían las tablas del único DML

| Campo | Contenido |
|---|---|
| **Severidad** | **BLOCKER**, cerrado |
| **Defecto** | `REQUIRED_EMPTINESS_PROBES` eran nueve nombres escritos a mano y omitían `funders`, `project_investments` y `financial_proxies` — exactamente las tres tablas donde escribe `0018`, el único DML del baseline — más ~24 tablas |
| **Ataque** | Una restauración parcial de producción con las tablas de tenencia vacías y las financieras llenas pasaba el control compensatorio del centinela diferido |
| **Corrección** | El conjunto se **deriva** del corpus: toda tabla que crean las 50 unidades |

#### RR-22 — El gate del ensayo medía la existencia del archivo

| Campo | Contenido |
|---|---|
| **Severidad** | **MAJOR**, cerrado |
| **Defecto** | `hosted-baseline-rehearsal-ready` pasaba con `readFileSync(script)`. En un CI sin Docker —que nunca ha corrido un ensayo— quedaba verde para siempre, y el nombre invita a leerlo como «el ensayo pasó» |
| **Corrección** | Lee `artifacts/baseline-rehearsal/latest.json`, exige que su `manifestDigest` coincida con el manifiesto actual, que RUN A fallara en 0039, que RUN B aplicara las 50 y que B0 quedara limpia |

#### RR-24 — El repositorio se contradice sobre qué proyecto es producción

| Campo | Contenido |
|---|---|
| **Severidad** | **BLOCKER** para P5 |
| **Defecto** | El único project ref candidato del repositorio, `ctaxtgujyyprgynmnvtq`, aparece etiquetado de dos formas incompatibles: `docs/AUDIT_2026-07-06.md` describe la credencial que apunta a `db.<ref>.supabase.co` como acceso a la «**full production database**»; `docs/audits/2026-07-15-uellix-p1a-integration-rls.md` llama al mismo host «el entorno de **Staging** remoto de Supabase» y documenta 29 migraciones aplicadas hasta la `0028` |
| **Por qué importa** | P5 exige el ref de **producción** en la denylist. Meter el equivocado es exactamente el fallo que la denylist existe para prevenir: si es un staging antiguo y se etiqueta como producción, se escribe una afirmación falsa dentro de un control de seguridad; si es producción y se omite, el veto sigue ausente |
| **Lo que sí es seguro afirmar** | **No es el nuevo Uellix Staging.** El Checkpoint A0 confirmó un proyecto **nuevo y vacío**, sin `public.stella_interactions`; éste tiene 29 migraciones aplicadas |
| **Resolución (2026-08-07)** | El operador confirmó desde el dashboard de Supabase: `ctaxtgujyyprgynmnvtq` es **PRODUCCIÓN**. El audit de 2026-07-15 estaba equivocado y lleva ahora una corrección en cabecera, con el texto original intacto debajo — borrarlo eliminaría la prueba de que la etiqueta estuvo mal tres semanas. El nuevo Uellix Staging es `bvyzblhqymxruxdguaee`, un proyecto distinto y vacío |
| **Consecuencia sobre un incidente pasado** | El `pnpm db:migrate` accidental del 15 de julio **no** fue contra un staging: fue contra producción. La verificación read-only de entonces sigue siendo válida y su conclusión también —cero modificaciones—; lo que cambia es la gravedad de lo que estuvo cerca de ocurrir |
| **Estado** | **CERRADO.** `KNOWN_PRODUCTION_IDENTIFIERS.projectRefs = ['ctaxtgujyyprgynmnvtq']`; `productionDenylistStatus().loaded === true`. Cuatro tests lo fijan: el ref productivo se rechaza aunque las tres señales coincidan, se rechaza también si llega sólo por el centinela, el ref de staging se acepta con las tres señales, y la denylist **no** contiene el ref de staging |

#### RR-25 — Tercera asimetría local/hosted: no hay registro de lo aplicado

| Campo | Contenido |
|---|---|
| **Severidad** | **MAJOR** |
| **Defecto** | El plan hosted aplica cada unidad con `psql -1 -v ON_ERROR_STOP=1 -f`, que **no escribe ningún registro**. En local, `pnpm db:migrate:local` usa el migrador de drizzle, que crea y puebla `drizzle.__drizzle_migrations` — la auditoría de 2026-07-15 confirma esa tabla con 29 filas en el proyecto remoto de entonces |
| **Consecuencia** | `TargetStateProbe.baselineUnitsInstalled` está documentado como «lo que registra el ledger del operador», y **ese ledger no lo crea nada** en la cadena hosted. Tras `PHASE_BASELINE`, la comprobación anti-salto de `PHASE_STELLA_BOOTSTRAP` (`missingBaselineUnits`) no tendría fuente autoritativa: sería un dato tecleado |
| **Relación con hallazgos previos** | Agrava directamente lo que la revisión de 5C0 señaló sobre la sonda auto-declarada. Allí el argumento era «el planificador confía en su entrada»; aquí se añade que **no hay nada en el objetivo contra lo que contrastarla** |
| **Por qué es de la misma clase** | Es la tercera vez que aparece el patrón: algo que el stack local hace implícitamente (`supabase start` aplica `supabase/migrations`, crea el bucket, y `db:migrate:local` escribe el journal) y que nadie hace en hosted. Que aparezca tres veces sugiere tratar «¿qué más hace el stack local por nosotros?» como pregunta permanente |
| **Mitigación disponible** | CHECKPOINT B0 mide el **estado resultante** (tablas, funciones, policies, RLS), que es más fuerte que un journal: un journal dice qué se intentó, B0 dice qué hay. La ausencia de journal no bloquea el apply; bloquea poder *resumir* uno interrumpido — y para eso la estrategia ya es `DESTROY_AND_REPROVISION` |
| **Estado** | **ABIERTO**, no bloqueante para el apply |

#### RR-27 — La sonda de clase C medía el grado de pertenencia equivocado

| Campo | Contenido |
|---|---|
| **Severidad** | **MAJOR**, corregido |
| **Defecto** | `ownsStorageObjects` pregunta `pg_has_role(current_user, relowner, 'USAGE')`. Dos problemas que un `FALSE` no distingue: (1) no registra **quién** preguntó — se ejecutó en el SQL Editor, y el baseline lo aplicará `psql` como otro rol; (2) mide `USAGE`, no `MEMBER`, así que no dice si `SET ROLE supabase_storage_admin` está disponible. Una pertenencia `NOINHERIT` da `USAGE=false` y `MEMBER=true` |
| **Cómo se encontró** | Por el propio resultado: la documentación oficial de Supabase presenta `create policy … on storage.objects` como la vía normal, y [supabase/supabase#41126](https://github.com/supabase/supabase/issues/41126) reporta la misma sentencia fallando por conexión directa y funcionando en el SQL Editor. Las dos cosas sólo son compatibles si la identidad importa |
| **Impacto sobre el veredicto** | **Ninguno, y es conservador**: la identidad de conexión directa es la más restringida de las dos, así que medir en el apply sólo puede salir igual o peor. Lo que estaba sin resolver era **cuál** adaptación corresponde |
| **Corrección** | Dos sondas nuevas en `CLASS_C_PROBES`, ambas read-only: `applyIdentityRecorded` (`SELECT current_user, session_user, version()`) y `canSetRoleStorageAdmin` (`pg_has_role(…, 'MEMBER')`) |
| **Lección** | Es la misma familia que el chequeo de consulta por subcadena que la revisión adversarial tumbó: **una sonda que no fija su identidad responde a una pregunta que nadie hizo** |

#### RR-26 — El gate de autorización no lo consumía nada

| Campo | Contenido |
|---|---|
| **Severidad** | **BLOCKER**, cerrado en el mismo train |
| **Defecto** | `db/hosted/target-identity.ts` afirmaba, por escrito: «el check vive donde vive el riesgo — `hosted-baseline-apply-authorized` lo consume y refuta». `evaluateApplyAuthorization` tenía **cero call sites** fuera de su propio test. Ni `planProvisioningPhase` ni `planHostedApply` importaban `productionDenylistStatus` |
| **Ataque** | Llamar a `planProvisioningPhase({phase:'PHASE_BASELINE', mode:'apply', applyConfirmation:'hosted_apply:<ref>'})` con la denylist por defecto (vacía): devolvía `ok:true, writesPermitted:true` y los 50 comandos `psql`. La primera escritura hosted quedaba planificada y bendecida con el veto de refs nunca cargado, y nada obligaba a ejecutar el gate |
| **Por qué es la misma clase que RR-19** | Una afirmación falsa de este train sobre su propio trabajo. La cuarta de la serie |
| **Corrección** | `PROVISIONING_PRODUCTION_DENYLIST_EMPTY` y `HOSTED_PRODUCTION_DENYLIST_EMPTY`: **ambos** planificadores refutan `mode: 'apply'` con la denylist vacía. Un dry-run no se ve afectado, que es el reparto documentado. Dos tests lo fijan, uno por planificador |
| **Consecuencia operativa** | Mientras P5 siga abierto, **ninguna escritura hosted puede planificarse siquiera**, en ninguno de los dos caminos. El bloqueo de RR-24 es ahora ejecutable, no documental |

#### RR-23 — La duplicación de A2 no se vigilaba en tiempo de plan

| Campo | Contenido |
|---|---|
| **Severidad** | **BLOCKER**, cerrado |
| **Defecto** | Corregir un fallo de RLS en `0031` y actualizar **sólo** su pin dejaba `001` intacto y con su propio hash correcto. `verifyBaselineManifest` —la función que **gobierna la escritura hosted**— no reportaba nada, y `001` (ordinal 43) corría después de `0031` (ordinal 32) revirtiendo la corrección al pasar. La igualdad estaba afirmada sólo en un test de Vitest que el gate no consulta |
| **Corrección** | `verifyEquivalences()` dentro de `verifyBaselineManifest`: hash, conjunto de sentencias, digest de superficie de seguridad y dirección del orden |

---

## 3. Conteo

| Severidad | Cantidad | Tras Train 5B | Tras Train 5C0 |
|---|---|---|---|
| BLOCKER | **6** (B1-B6) | **3 abiertos** (B2 staging no aislado, B3 clave sin rotar, B4 credenciales ambiguas) · 2 cerrados por diseño (B1, B5) · 1 aceptado como no cerrable (B6/RR-02) | **+2 encontrados y cerrados por diseño** (B7 cadena baseline inejecutable, B8 centinela circular). **B2 pasa a parcialmente cerrado**: el proyecto de staging existe y CHECKPOINT A0 dio PASS; queda abierto el resto de §2.1 (P5 denylist) |
| MAJOR | **10** (M1-M10) | M1 **mitigado** (el planificador hosted evalúa las supersesiones antes de emitir el plan) | **+4 abiertos**: RR-12 (`CREATE TRIGGER ON auth.users` sin verificar), RR-13 (`anon INSERT` de 008 inerte por ausencia), RR-17 (ownership de `storage.objects` sin verificar), RR-18 (bucket `uellix-evidence` sin crear en hosted) · **+2 cerrados**: RR-19 (5 afirmaciones falsas corregidas), RR-22 (gate del ensayo) |
| MINOR | **6** (m1-m6) | sin cambios | **+3 abiertos**: RR-14 (`db/baseline/` no es el baseline), RR-15 (`0033` → `service_role`), RR-16 (008 no idempotente) |

> **Los tres BLOCKER que la revisión adversarial cerró** —RR-20 (escáner ciego a
> predicados y cuerpos), RR-21 (sondas de vacuidad sin las tablas del DML) y
> RR-23 (duplicación de A2 sin vigilar en tiempo de plan)— tienen algo en común
> que conviene no perder: **los tres eran huecos en instrumentos que este mismo
> train construyó para detectar huecos**. El manifiesto medía conteos y no
> contenido; el control compensatorio medía nueve tablas de treinta y tres; el
> gate de la escritura no consultaba el test que probaba la equivalencia. Ninguna
> prueba los encontró, porque todas medían lo que el instrumento sabía mirar.

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

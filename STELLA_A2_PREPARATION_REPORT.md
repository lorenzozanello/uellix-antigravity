# Stella — Etapa A1.6 (consistencia final) + preparación de Etapa A2. Informe de sesión

**Fecha:** 2026-07-25

---

## 1. Rama y commit base

`feature/stella-generation-copilot`, commit base `4c8a8ed9537e4181229ce94f83ca6447db30b172` — sin cambios respecto a las sesiones de Etapa A1 y A1.5 (ningún commit se ha creado en ninguna sesión de este trabajo).

## 2. Archivos revisados

Los 7 documentos obligatorios (`STELLA_REVISED_MASTER_PLAN.md`, `STELLA_REVISED_BACKLOG.csv`, `STELLA_DECISION_REGISTER.md`, `STELLA_THREAT_MODEL.md`, `STELLA_EVAL_STRATEGY.md`, `STELLA_STAGE_A_IMPLEMENTATION_REPORT.md`, `STELLA_STAGE_A15_CLOSURE_REPORT.md`, `STELLA_STAGE_A_VALIDATION.json` — 8 en total, el encargo cuenta el JSON aparte); el código de `lib/stella/prompts/registry.ts`, `prompt-content-hash.ts`, `build-runtime-message.ts`, los 4 *builders* de mensaje, los 6 *system prompts*/configuraciones de rol, `lib/stella/context/context-schema-descriptor.ts`, `schema-version.ts`, `lib/stella/audit-log.ts`, `db/schema.ts`, las migraciones `0042`/`0043`/`0044`, y las pruebas de integridad de prompts y contexto existentes.

## 3. Estado inicial

`git status` mostraba el mismo working tree con el que cerró Etapa A1.5: mismos archivos modificados/nuevos, ningún commit de por medio. Se verificó cada premisa del encargo contra el código antes de tocar nada (sección 4).

## 4. Inconsistencias encontradas

| # | Premisa del encargo | Verificación | Resultado |
|---|---|---|---|
| 1 | El CSV y el JSON podrían no coincidir en el estado final de A1.5 | `STELLA_REVISED_BACKLOG.csv` tenía las 11 filas `STL-A15-*` en `Done`; `STELLA_STAGE_A_VALIDATION.json` (`csvValidation`) todavía decía `etapaA15RowsMarkedDone: 10` con `STL-A15-011` listado como pendiente | **Confirmado: inconsistencia real**, corregida |
| 2 | La afirmación de acceso externo durante el build podría ser una afirmación absoluta no verificada | `STELLA_STAGE_A_VALIDATION.json`/`STELLA_STAGE_A15_CLOSURE_REPORT.md` afirmaban "Acceso externo: NO" como hecho, cuando solo se había verificado que las cadenas de conexión configuradas resolvían a loopback — la red nunca se deshabilitó físicamente ni se monitoreó tráfico saliente | **Confirmado: sobre-afirmación**, corregida a un desglose de 5 campos verificables |
| 3 | `prompt_content_hash` podría cubrir solo el *system prompt*, no el contrato completo | Lectura de `prompt-content-hash.ts` (versión anterior): solo llamaba a `buildXSystemPrompt`; nunca a `buildXUserMessage`, nunca a las constantes de `build-runtime-message.ts`/`build-untrusted-payload.ts`, nunca a `CONTEXT_SCHEMA_VERSION` | **Confirmado: brecha real**, corregida (ver §6) |
| 4 | (No prevista en el encargo, encontrada durante la validación de la corrección #3) | Al ampliar el hash para llamar también a `buildXUserMessage`, 27 pruebas de las 4 acciones de servidor de Stella empezaron a fallar — los mocks de esos archivos de prueba devuelven un string simple para `buildXUserMessage`, no parseable como TASK/UNTRUSTED_PROJECT_DATA/RESPONSE_REQUIREMENTS | **Regresión real, propia**, corregida (ver §5) |

Ninguna premisa del encargo resultó ser falsa — las 3 verificadas explícitamente en el encargo se confirmaron ciertas; se encontró además una 4ª inconsistencia (una regresión propia de esta sesión) durante la validación, que también se corrigió antes de continuar.

## 5. Correcciones de Etapa A1.6

- **STL-A16-001:** `STELLA_STAGE_A_VALIDATION.json` (`build.externalAccessClaims`) ahora distingue: servicios configurados como locales/sintéticos (verdadero), acceso remoto a BD observado (falso), acceso remoto a Gemini observado (falso), build con red deshabilitada (falso — no se hizo), tráfico saliente monitoreado independientemente (falso — no se hizo). No se repitió el build (no hubo cambio de código que lo justificara).
- **STL-A16-002:** `csvValidation.etapaA15RowsMarkedDone` corregido de `10` a `11`; `etapaA15RowsStillPending` corregido de `["STL-A15-011..."]` a `[]`. Re-verificado directamente contra el CSV (no solo "ajustado para que cuadre").
- **STL-A16-003:** ver §6.
- **STL-A16-004:** `lib/stella/audit-log.ts` corregido para usar `template.expectedContentHash` (ya disponible desde `getPromptTemplate`) en vez de recomputar `computePromptContentHash(role)` en cada inserción — evita la dependencia frágil de los mocks de los 4 *builders* y elimina trabajo redundante (el hash no varía dentro de una misma versión de plantilla).

Se añadieron 4 filas a `STELLA_REVISED_BACKLOG.csv` (`STL-A16-001` a `STL-A16-004`, `RecommendedOrder` 26-29), todas `Done`, con dependencias/orden verificados.

## 6. Resultado del control de hash

**Cobertura anterior:** únicamente el texto del *system prompt* (llamado con un parámetro canónico fijo).

**Brecha confirmada:** un cambio en el `task`/`responseRequirements` fijo de cualquier `buildXUserMessage`, en la plantilla del mensaje runtime (`build-runtime-message.ts`), en los delimitadores/advertencia de datos no confiables (`build-untrusted-payload.ts`), en qué campos concretos se envían como datos, o en `CONTEXT_SCHEMA_VERSION`, podía ocurrir sin que `prompt_content_hash` cambiara, sin incrementar `prompt_version`, y sin que ninguna prueba fallara.

**Verificación empírica de la brecha:** se razonó sobre el código (el diseño anterior nunca invocaba `buildAdvisorUserMessage`) y se confirmó en ejecución que, tras la corrección, alterar temporalmente el texto de TASK en `advisor-system.ts` (sin tocar el *system prompt*) hace fallar `prompt-content-hash.test.ts`; se revirtió el cambio y las pruebas volvieron a pasar.

**Solución implementada:** `computePromptContentHash()` ahora hashea, por rol: el *system prompt* + una o más "variantes" del mensaje runtime (composer tiene 2 — sección por defecto y `funder_breakdown`, porque su `responseRequirements` cambia según la sección; los otros 5 roles tienen 1) extrayendo de cada variante el texto TASK, el texto RESPONSE_REQUIREMENTS, el prefijo/advertencia fijo de UNTRUSTED_PROJECT_DATA, y los NOMBRES (nunca valores) de los campos de datos enviados — más las constantes estructurales de sección/delimitadores, más `CONTEXT_SCHEMA_VERSION`. Todo determinista, sin datos de proyecto, sin IDs reales, sin narrativas, sin timestamps reales (se usa un timestamp fijo `1970-01-01T00:00:00Z` como valor sintético para los campos de tipo fecha, requeridos por el tipo pero irrelevantes para el hash).

Los 6 valores `expectedContentHash` en `registry.ts` se recalcularon con el nuevo método. `version` **no** se incrementó — el contenido real de ningún prompt cambió; solo cambió qué mide el control. Esta distinción se documentó explícitamente en el código.

**Cobertura final confirmada:** `systemPrompt` ✓, `taskTemplate` ✓, `responseRequirements` ✓, `runtimeMessageStructure` ✓, `untrustedDataDelimiters` ✓, `structuralFieldSelection` ✓, `contextSchemaVersion` ✓, variantes por sección/mandato donde aplica (composer) ✓.

## 7. Documentos A2 creados

- `STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md` — DR-001, DR-002, DR-003, DR-004, DR-005, DR-007, cada una con las 16 secciones requeridas.
- `STELLA_A2_OWNER_DECISION_FORM.md` — formulario breve, 6 decisiones + cierre, ninguna casilla pre-marcada.
- `STELLA_AI_DATA_GOVERNANCE_POLICY_DRAFT.md` — borrador de política, estado `BORRADOR — NO APROBADO`, coherente con el estado técnico actual (Stella apagada, sin Evidence/Proxy Intelligence, manifiesto sin payload crudo, `response_json` sí puede llevar prosa generada, Etapa A3 pendiente).
- `STELLA_A2_IMPLEMENTATION_OPTIONS.md` — matriz de cambios técnicos/riesgos/pruebas por opción, para las 6 decisiones — ninguna opción implementada.
- `STELLA_DECISION_REGISTER.md` — actualizado únicamente con enlaces a los documentos anteriores y evidencia revisada; los 11 `DR-*` conservan su estado (los 6 de esta sesión explícitamente marcados "Sigue PENDIENTE").

## 8. Decisiones pendientes

`DR-001` (PII), `DR-002` (menores), `DR-003` (salud), `DR-004` (retención), `DR-005` (consentimiento), `DR-007` (acceso interno) — las 6 preparadas en este paquete, ninguna resuelta. `DR-008`/`DR-009` (legal, Etapa A3) y `DR-011` (fuentes de proxy) permanecen sin tocar. `DR-006` sigue como decisión por defecto ya implementada (manifiesto sin payload). `DR-010` sigue diferida intencionalmente.

## 9. Archivos modificados

`lib/stella/prompts/prompt-content-hash.ts`, `lib/stella/prompts/registry.ts`, `lib/stella/audit-log.ts`, `db/schema.ts` (comentario), `STELLA_REVISED_BACKLOG.csv`, `STELLA_STAGE_A_VALIDATION.json`, `STELLA_STAGE_A15_CLOSURE_REPORT.md` (adenda), `STELLA_THREAT_MODEL.md` (R1), `STELLA_DECISION_REGISTER.md` (enlaces).

## 10. Archivos nuevos

`STELLA_A2_GOVERNANCE_DECISION_PACKAGE.md`, `STELLA_A2_OWNER_DECISION_FORM.md`, `STELLA_AI_DATA_GOVERNANCE_POLICY_DRAFT.md`, `STELLA_A2_IMPLEMENTATION_OPTIONS.md`, `STELLA_A2_PREPARATION_REPORT.md` (este documento).

## 11. Pruebas ejecutadas

| Comando | Resultado |
|---|---|
| `pnpm typecheck` (x4, entre pasos) | ✅ limpio, 0 errores en cada ejecución |
| `pnpm exec vitest run lib/stella/prompts/__tests__/prompt-content-hash.test.ts lib/stella/prompts/registry.test.ts` | ✅ 18/18 |
| Verificación manual de deriva (TASK-only, no system prompt) | ✅ falla con el diseño corregido; se revirtió y volvió a pasar |
| `pnpm exec vitest run app/actions/stella lib/stella/__tests__/audit-log.test.ts` | ✅ 125/125 (tras corregir la regresión STL-A16-004) |
| `pnpm test:unit` | ✅ 94 archivos, 1277 pruebas |
| `pnpm lint` | ✅ 0 errores, 55 warnings (sin cambio) |
| `pnpm test:integration` | ✅ 4 archivos, 49 pruebas |
| `npx drizzle-kit check --config=drizzle.local.config.ts` | ✅ sin drift |
| Validación de `STELLA_REVISED_BACKLOG.csv` | ✅ 56 filas, 18 columnas, 0 malformadas, 0 IDs duplicados, 0 dependencias colgantes, 0 inversiones de orden |

## 12. Pruebas omitidas

Las pruebas de integración RLS (`tests/integration/stella-interactions-rls.test.ts`) no eran obligatorias de repetir según el encargo, porque esta sesión no tocó base de datos, políticas RLS, privilegios de tabla, ni el cuerpo de ninguna *server action* — solo el cálculo de un hash de aplicación y, tras la regresión STL-A16-004, la fuente de ese valor dentro de `audit-log.ts` (que sí escribe en la BD, pero no cambia su forma de insertar). **Se ejecutaron de todas formas** como verificación adicional, dado que `audit-log.ts` sí participa en la ruta de escritura real: `pnpm test:integration` completo (49/49) incluye esa suite y pasó sin cambios.

## 13. Acceso externo

Ninguno. No se repitió el build de Etapa A1.5 (no había cambio de código que lo justificara). Todas las verificaciones de esta sesión fueron sobre código de aplicación (funciones puras de hashing) y ejecución de pruebas locales/`drizzle-kit check` contra el stack local ya existente.

## 14. Escritura remota

Ninguna. Ninguna migración nueva se creó ni se aplicó en esta sesión (no se tocó esquema de base de datos más allá de un comentario en `db/schema.ts`).

## 15. Flags

Ningún flag de Stella se activó, se desactivó, ni se modificó. `STELLA_ENABLED` y los 6 flags por rol permanecen exactamente como estaban.

## 16. Commits

Ninguno.

---

## Recomendación de siguiente paso

Etapa A1.6 queda cerrada — las 4 inconsistencias encontradas se corrigieron y verificaron. El paquete de Etapa A2 está listo para revisión del propietario. El siguiente paso NO es continuar con implementación: es que el propietario complete `STELLA_A2_OWNER_DECISION_FORM.md`. Ninguna decisión de gobernanza se implementó ni se marcó aprobada en esta sesión.

---

## Adenda — Bloque DR-001 implementado (2026-07-25, misma fecha, tras aprobación del propietario)

El propietario respondió `STELLA_A2_OWNER_DECISION_FORM.md` aprobando las 6 decisiones (DR-001, DR-002, DR-003, DR-004, DR-005, DR-007), con condiciones explícitas: Stella permanece apagada, sin producción hasta A3, sin llamadas reales a Gemini, migraciones aditivas, sin conclusiones jurídicas, y avance por bloques con verificación entre cada uno. Se eligió secuenciar la implementación un bloque técnico a la vez, empezando por **DR-001 (política de PII)** porque DR-002/DR-003 comparten su mismo mecanismo técnico subyacente.

### Cambios de código

- **`lib/stella/context/pii-detection.ts`** (nuevo) — `detectCommonPii()`, `detectHighRiskPii()`, `redactCommonPii()`. Common: email, teléfono, ID genérico (6-12 dígitos), dirección precisa (heurística). Alto riesgo: documento de identidad (por palabra clave), cuenta financiera (tarjeta/IBAN), credenciales (reutiliza `hasForbiddenPattern` existente), y dos heurísticas por palabra clave: menor identificable (edad 0-17 + contexto de menor) e información de salud individual (verbo de enmarcado individual + término clínico). **Limitación documentada explícitamente en el propio archivo**: es un detector heurístico de patrones/palabras clave, no un clasificador NLP de PII — no garantiza detección exhaustiva.
- **`lib/stella/context/context-guardrails.ts`** — `assertContextHasNoForbiddenData` ahora también lanza (falla cerrado) si `detectHighRiskPii` encuentra cualquier coincidencia en los mismos campos de texto ya escaneados (narrativa, nombres/descripciones de outcomes, nombres/unidades de indicadores, títulos de evidencia, nombres/fuentes de proxy). El mensaje de error incluye solo el nombre de la categoría, nunca el valor detectado (verificado por prueba dedicada). Se exportó `collectContextStrings` (antes privada) para reutilizar la misma lista de campos escaneados desde el manifiesto.
- **`lib/stella/context/build-context-manifest.ts`** — el manifiesto añade una de 4 nuevas banderas de vocabulario fijo (`possible_pii_email`/`_phone`/`_generic_id`/`_address`) cuando `detectCommonPii` encuentra una coincidencia de nivel común — nunca bloquea, nunca incluye el valor detectado, solo la categoría (siguiendo exactamente el mismo patrón de construcción por literales ya usado en Etapa A1.4).
- **`STELLA_REVISED_BACKLOG.csv`** — las 6 filas de decisión (`STL-A2-001` a `STL-A2-006`) marcadas `Done` con nota de que la decisión fue recibida; 3 filas nuevas de implementación (`STL-A2-007`, `STL-A2-008`, `STL-A2-009`), las 3 marcadas `Done` tras verificar sus pruebas.

### Alcance real vs. lo que queda para DR-002/DR-003

El mecanismo de `minorIdentifiable`/`individualHealth` implementado aquí **avanza** DR-002 y DR-003 (comparten el mismo guardarraíl), pero **no las cierra por completo**: el umbral de agregación de 10 personas (DR-002/DR-003, aprobado condicionalmente por el propietario) requiere lógica de conteo por grupo/celda estadística que no existe todavía en ningún *context builder* — eso es un bloque técnico separado, no cubierto por esta sesión. Las filas de decisión `STL-A2-002`/`STL-A2-003` siguen marcadas `Done` (la decisión en sí está resuelta), pero el trabajo de implementación del umbral de agregación queda pendiente de una tarea futura, no incluida en el backlog todavía.

### Pruebas añadidas

`lib/stella/context/__tests__/pii-detection.test.ts` (20 pruebas: 6 comunes + 9 de alto riesgo incluyendo el caso de no-fuga del valor detectado + 4 de redacción + 1 de texto ordinario), ampliación de `context-guardrails.test.ts` (+6 pruebas: 3 bloqueos por categoría, no-fuga del valor en el mensaje de error, caso limpio, caso común-no-bloquea) y de `build-context-manifest.test.ts` (+3 pruebas: bandera de email sin fuga, bandera de teléfono, ausencia de bandera cuando no hay PII).

### Validación

| Comando | Resultado |
|---|---|
| `pnpm typecheck` | ✅ limpio |
| `pnpm lint` | ✅ 0 errores, 55 warnings (sin cambio) |
| `pnpm exec vitest run lib/stella/context/__tests__/pii-detection.test.ts lib/stella/context/__tests__/context-guardrails.test.ts lib/stella/context/__tests__/build-context-manifest.test.ts` | ✅ 45/45 |
| `pnpm exec vitest run lib/stella app/actions/stella components/stella tests/stella-quota.test.ts tests/stella-adversarial.test.ts tests/stella-adversarial-runtime.test.ts tests/eval` | ✅ 31 archivos, 606 pruebas (0 colisiones incidentales con datos mock existentes) |
| `pnpm test:unit` | ✅ 95 archivos, 1306 pruebas |
| `pnpm test:integration` | ✅ 4 archivos, 49 pruebas (sin cambios de esquema/RLS en este bloque; se ejecutó de todas formas) |
| Validación de `STELLA_REVISED_BACKLOG.csv` | ✅ 59 filas, 18 columnas, 0 malformadas, 0 duplicados, 0 dependencias colgantes, 0 inversiones de orden |

**Confirmado explícitamente:** ningún flag de Stella activado; ninguna llamada real a Gemini; ninguna base de datos remota; ninguna migración creada ni aplicada (este bloque no cambia esquema); ningún commit creado.

### Próximo bloque recomendado

Siguiendo el orden acordado con el propietario ("un bloque técnico por vez"): **DR-005 (consentimiento por organización)** o **DR-007 (acceso interno)** son los siguientes candidatos naturales (no dependen de DR-002/DR-003's trabajo de agregación pendiente). Alternativamente, **DR-004 (retención)** si se prefiere abordar primero el control de mayor antigüedad de riesgo acumulado. **No se continúa automáticamente** — se espera indicación de cuál bloque seguir.

---

## Adenda — Bloque DR-005 (Etapa A2.1) implementado (2026-07-25/26)

El propietario respondió el formulario completo, aprobando las 6 decisiones con condiciones explícitas (Stella apagada, sin producción hasta A3, sin llamadas reales a Gemini, migraciones aditivas, sin conclusiones jurídicas, avance por bloques). Se implementó exclusivamente **DR-005 (consentimiento explícito por organización)**, per el encargo de Etapa A2.1.

Resumen de lo construido: tabla append-only `stella_ai_consent_events` (migración `0045`, privilegios mínimos para `authenticated` desde el inicio); registro central de versiones (`STELLA_AI_TERMS_VERSION`/`STELLA_DATA_POLICY_VERSION`); servicio `getStellaConsentStatus()` (fail-closed, resuelve `valid`/`missing`/`revoked`/`outdated`); *server actions* `acceptStellaConsent()`/`revokeStellaConsent()` (chequeo estricto de `organization_admin`, sin bypass de `super_admin` global); compuerta integrada en las 4 acciones de Stella, antes de cuota/rate-limit/modelo.

Detalle completo, diseño, alternativas descartadas, privilegios antes/después, y validación exacta: ver **`STELLA_A2_DR005_IMPLEMENTATION_REPORT.md`**.

**Próximo bloque recomendado:** `DR-007` (acceso interno a `stella_interactions`). **No se continúa automáticamente.**

---

## Adenda — Bloque DR-007 (Etapa A2.2) implementado (2026-07-26)

Se implementó **DR-007 (control de acceso interno a `stella_interactions`)**, sin modificar el comportamiento de DR-005 (verificado: ninguna vulnerabilidad relacionada encontrada que lo justificara).

Resumen: inventario completo de las 3 rutas de lectura existentes (agregados de cuota, agregados de administración, guarda de existencia por borrado de proyecto — ninguna expone contenido) y del único escritor; matriz de acceso aprobada (creador; `organization_admin`/`impact_manager`/`analyst` con alcance real de toda la organización por ausencia de ACL por proyecto; `reviewer`/`viewer` sin acceso general; `super_admin` sin bypass); política RLS reemplazada (`db/policies/010_stella_interactions_access_control_rls.sql`, sin editar `002_...`); servicio central de lectura autorizada (`lib/stella/access/`) que aplica la MISMA matriz a las lecturas que bypasean RLS vía Drizzle; prueba anti-regresión que detecta cualquier lectura directa nueva fuera de los módulos autorizados.

Detalle completo, matriz final, decisiones interpretativas (tratamiento de `reviewer`, de "viewer creador", del alcance real de `analyst`) y validación exacta: ver **`STELLA_A2_DR007_IMPLEMENTATION_REPORT.md`**.

**Próximo bloque recomendado:** reglas de agregación de DR-002/DR-003 (umbral mínimo de agrupación para datos de menores/salud). **No se continúa automáticamente.**

---

## Adenda — Bloque DR-002/DR-003 (Etapa A2.3) implementado (2026-07-26)

Se completó el trabajo de agregación pendiente identificado en la adenda de DR-001 (§"Alcance real vs. lo que queda para DR-002/DR-003", arriba): **DR-002 (menores) y DR-003 (salud)**, sin modificar el comportamiento de DR-005/DR-007 (verificado: ninguna vulnerabilidad relacionada encontrada que lo justificara).

Se comenzó, como exigía el encargo, con un inventario exhaustivo de campos que pudieran representar menores, salud, tamaño de grupo o cuasi-identificadores. Hallazgo central: **el esquema de Uellix no tiene hoy ningún campo estructurado y confiable de tamaño de grupo** (`stakeholder_groups` no tiene columna de conteo; `indicators.baselineValue/targetValue/actualValue` son varchar libre) — por tanto ningún *context builder* puede producir hoy una declaración de agregación verificada, y el sistema bloquea en la práctica toda mención agregada específica de estas poblaciones hasta que exista un flujo de verificación humana futuro (diseñado en el informe de cierre, no implementado).

Resumen de lo construido: módulo de clasificación (`lib/stella/context/sensitive-population.ts`) calibrado para no bloquear lenguaje temático normal de SROI (solo se dispara con señal individual reutilizada de DR-001, o con una mención agregada = número + sustantivo poblacional); contrato `AggregateDataDeclaration` con validación estructural estricta; umbral mínimo `MINIMUM_SENSITIVE_GROUP_SIZE = 10`; taxonomía de cuasi-identificadores con regla de bloqueo por combinación de 2+; endurecimiento adversarial añadido durante la implementación (normalización de caracteres invisibles, cotejo declarado-vs-mencionado); 5 códigos de error tipados mapeados en los 4 *server actions*, con auditoría de intentos bloqueados sin contenido sensible; nueva bandera de manifiesto solo para el caso permitido.

Detalle completo, modelo de clasificación, taxonomía de reidentificación, brecha de datos documentada, suite adversarial y validación exacta: ver **`STELLA_A2_DR002_DR003_IMPLEMENTATION_REPORT.md`**.

**Próximo bloque recomendado:** `DR-004` (retención de `stella_interactions`/`context_manifest`), pendiente de que el propietario defina parámetros concretos de plazo. **No se continúa automáticamente.**

---

## Adenda — Bloque Etapa A2.3.1 (declaraciones verificadas de agregación) implementado (2026-07-26)

Se cerró la brecha estructural que Etapa A2.3 dejó documentada: no existía ningún productor real de `AggregateDataDeclaration`, por lo que el estado correcto de DR-002/DR-003 hasta esta sesión era `IMPLEMENTACIÓN PARCIAL` (bloqueo completo, camino de agregados pendiente), no `IMPLEMENTADA TÉCNICAMENTE` sin matiz — corrección aplicada en `STELLA_DECISION_REGISTER.md`.

Se comenzó con un inventario exhaustivo (`groupSize`, `verifiedBy`, `aggregation`, etc.) que confirmó que `financial_proxies.reviewStatus` es el único precedente reutilizable de un flujo de verificación humana en todo el repositorio — no existía ninguna abstracción polimórfica previa que evitara construir una nueva.

Resumen de lo construido: tabla central `stella_sensitive_aggregation_declarations` (migración `0046`, aditiva, polimórfica sobre una allowlist fija de 6 tipos de entidad reales, con índice único parcial que permite a lo sumo una declaración activa por entidad+categoría); `lib/stella/aggregation/` con política versionada (`SENSITIVE_AGGREGATION_POLICY_VERSION`, umbral, dimensiones permitidas, combinaciones de alto riesgo), servicios de creación/verificación/revocación/supersesión (roles exactos, sin bypass jerárquico) y de consulta (reclasifica una declaración `verified` contra la política ACTUAL, nunca confía ciegamente en una verificación antigua); *server actions* con auditoría sin contenido sensible; `assertContextHasNoForbiddenData()` ahora async y acotado por entidad exacta.

Detalle completo, diseño descartado (Opciones A/C), modelo de datos, validación exacta (typecheck, lint, 119 archivos/1.661 pruebas totales entre unitaria e integración, `drizzle-kit check`, CSV) y estado final de DR-002/DR-003: ver **`STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md`**.

**Próximo bloque recomendado:** `DR-004` (retención), ahora que DR-002/DR-003 tienen un camino de agregados verificados realmente operativo. **No se continúa automáticamente.**

---

## Adenda — Bloque Etapa A2.3.2 (cierre operativo de declaraciones verificadas) implementado (2026-07-26)

Se cerraron las 8 reservas operativas que Etapa A2.3.1 dejó documentadas (§27 de `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md`): UI operativa de creación/verificación/revocación/sustitución; sustitución transaccional con rollback probado; restricción de unicidad a nivel de base de datos confirmada bajo concurrencia real; 6 escenarios de concurrencia contra Postgres local (sin mocks); un cambio real de política v1→v2 probado sin tocar la constante productiva; consulta batch que elimina el patrón N+1 del guardarraíl; mensajes de bloqueo reescritos como instrucción accionable; y una prueba end-to-end de la sustitución a través del guardarraíl completo.

Un bug real (no anticipado) se detectó y corrigió únicamente porque las pruebas de concurrencia y transacción corrieron contra Postgres real, no mocks: esta versión de Drizzle envuelve el error del driver `postgres-js` en `DrizzleQueryError`, que no reenvía `.code` — el código real `23505` (violación de unicidad) solo sobrevive en `error.cause.code`; `isUniqueViolation()` se corrigió para revisar ambos. Un segundo hallazgo, durante la escritura de la prueba end-to-end de sustitución, resultó NO ser un bug: el cotejo declarado-vs-mencionado (`STL-A23-014`, Etapa A2.3.1) rechazó correctamente un `groupSize` resustituido que ya no coincidía con el número literal del texto del outcome — el control anti-evasión funcionando como se diseñó, no una regresión.

Detalle completo, arquitectura de la UI, modelo transaccional, prueba de cambio de política, métrica de consultas antes/después, y estado final de DR-002/DR-003: ver **`STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md`**.

**Próximo bloque recomendado:** `DR-004` (retención) — ver el veredicto y la recomendación formal en `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md`. **No se continúa automáticamente.**

---

## Adenda — Bloque Etapa A2.4 (retención y purga, DR-004) implementado (2026-07-26)

Se implementó la política técnica de retención diferenciada por categoría que el propietario aprobó directamente en el encargo de esta etapa: `response_json` retiene 24 meses por defecto (configurable por organización, 1-60 meses); metadatos de auditoría, `context_manifest`, eventos de consentimiento (DR-005) y declaraciones de agregación (DR-002/DR-003) se conservan mientras la organización exista, sin purga ejecutable en esta etapa — ningún evento de cierre contractual confiable existe hoy en el esquema (`organizations` no tiene `closed_at`/`contract_end_date`), confirmado por inventario antes de diseñar nada, y documentado como brecha en vez de inventar el evento.

Se construyó: 3 tablas nuevas (`stella_retention_settings`/`holds`/`purge_runs`, migración `0047`); un servicio de elegibilidad puro con reloj inyectable; un motor de purga por lotes transaccional (`SELECT...FOR UPDATE` por lote, idempotencia vía `idempotency_key` único, reanudación desde cursor persistido, un cambio de política entre dry-run y apply invalida la simulación); preservaciones (`holds`) a nivel organización/proyecto/interacción que bloquean la purga; auditoría TRANSACCIONAL (no best-effort) para holds/configuración — se evaluó un outbox genérico y se descartó por alcance, extendiendo en su lugar `logAuditAction` para aceptar el mismo cliente de transacción ya establecido en Etapa A2.3.2; *server actions*, script local con guarda de host, y una UI mínima en la configuración de organización.

Un hallazgo real (no anticipado) surgió al generar la migración: los snapshots de `drizzle-kit` para las migraciones 0041-0046 nunca se habían comprometido en sesiones anteriores, así que `drizzle-kit generate` intentó recrear tablas y columnas que ya existían en el stack local. Se corrigió escribiendo a mano solo las sentencias genuinamente nuevas, verificadas por introspección directa de `information_schema` contra la base real antes de aplicar — la migración final NO reintenta crear nada preexistente. El build aislado también detectó un error real de compilación (una constante no puede reexportarse desde un archivo `'use server'`), corregido moviendo los vocabularios fijos de holds a `policy.ts`.

Detalle completo, las 6 categorías, el modelo transaccional, la prueba de concurrencia/idempotencia/reanudación, y el estado final de DR-004: ver **`STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md`**.

**Próximo bloque recomendado:** Etapa A3 (revisión legal y contractual) — DR-004 queda técnicamente cerrado; los períodos de retención necesitan validación legal antes de comprometerse contractualmente con clientes. **No se continúa automáticamente.**

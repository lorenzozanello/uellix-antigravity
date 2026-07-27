# Modelo de amenazas de Stella

**Fecha:** 2026-07-24. Metodología: STRIDE adaptado por superficie, no genérico. Cada amenaza lleva evidencia de código, controles actuales verificados y controles faltantes con la tarea del backlog que los cierra.

---

## 1. Activos

| Activo | Por qué importa |
|---|---|
| Datos de proyecto de una organización (narrativa, outcomes, evidencia, proxies, cálculo) | Es el activo central de Uellix; una fuga cross-tenant destruye la confianza del producto |
| Credenciales (`GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`) | Compromiso total del sistema o del proveedor de IA |
| Integridad del cálculo SROI | Es la promesa central del producto; si Stella pudiera alterarlo, el producto deja de ser defendible |
| Reputación/confianza del usuario en el contenido generado | Sobreconfianza en una salida de IA incorrecta puede llevar a publicar un reporte defectuoso |
| Cuota/presupuesto de Gemini | Abuso de cuota = costo económico directo |

## 2. Límites de confianza

```
[Usuario del navegador] ──(HTTPS, sesión Supabase)──> [Server Action, 'use server']
        │                                                      │
        │  NO CONFIABLE                                        │  confía en requireOrganizationAccess()
        ▼                                                      ▼
[Texto libre: narrative, títulos]                    [Contexto construido: build*Context]
        │                                                      │
        │  cruza el límite hacia el modelo                     │  confía en que el contexto ya está
        ▼                                                      │  filtrado por organización (verificado)
[Prompt: systemPrompt + userMessage] ──(HTTPS)──> [Gemini API — proveedor externo, NO CONFIABLE
        │                                           en el sentido de que su salida se trata como
        │                                           dato, nunca como código o verdad]
        ▼
[Respuesta JSON] ──validación Zod──> [stella_interactions (DB)] ──RLS──> [UI del usuario]
```

El límite de confianza más importante para esta etapa: **el texto que un usuario (o, en el futuro, un documento) puede escribir cruza hacia el modelo** y **la respuesta del modelo cruza de vuelta hacia la base de datos y la UI**. Ninguno de los dos lados debe tratarse como instrucción de confianza.

## 3. Actores

| Actor | Capacidad |
|---|---|
| Usuario legítimo de una organización | Puede escribir cualquier texto en narrative/títulos/nombres; puede invocar los 4 roles de Stella (si estuvieran activos) dentro de su cuota |
| Usuario malicioso con cuenta legítima (insider) | Igual que el anterior, con intención de manipular la salida de Stella o filtrar datos de otra organización |
| Atacante externo sin cuenta | Solo alcanza endpoints públicos (`/api/marketing/lead`); no puede invocar Stella (requiere `requireOrganizationAccess()`) |
| El proveedor de IA (Google) | Recibe el contexto enviado; su comportamiento (qué hace con los datos) está fuera del control de Uellix — ver DR-008 |
| Documento futuro (Etapa C) | Cuando exista Evidence Intelligence, el contenido de un PDF/DOCX subido por un usuario se vuelve un vector de datos no confiables adicional |

## 4. Superficies de ataque relevantes hoy

1. Los cuatro *builders* de mensaje (`advisor-system.ts`, `composer-system.ts`, `validator-system.ts`, `reviewer-system.ts`) interpolan texto de usuario en el `userMessage`.
2. `narrativeSummary`, títulos de outcomes/indicadores/evidencia, nombres de proxies — todos escribibles por un usuario de la organización.
3. La respuesta del modelo (`rawOutput`) — no confiable hasta pasar por `Zod.parse`.
4. `stella_interactions.response_json` — persiste lo que el modelo dijo; se lee de vuelta en la UI.

## 5. Amenazas STRIDE

### Spoofing (suplantación)

**S1 — Suplantación de rol mediante instrucciones embebidas ("ignora tus instrucciones, ahora eres X").**
Evidencia original (Etapa A1): ningún delimitador estructural separaba instrucción de dato en el `userMessage` — `advisor-system.ts` interpolaba narrative directamente en un template literal, igual que los otros 3 builders.
**Cerrado en Etapa A1.5 (STL-A15-001 a 005).** Los 4 `buildXUserMessage` ahora componen el mensaje runtime con `buildStellaUserMessage()` (`lib/stella/prompts/build-runtime-message.ts`), que separa estructuralmente TASK (instrucción fija) / UNTRUSTED_PROJECT_DATA (JSON delimitado vía `wrapUntrustedData`) / RESPONSE_REQUIREMENTS (instrucción fija) — ya no una sola cadena de prosa concatenada. Verificado con `tests/stella-adversarial-runtime.test.ts` (78 casos: 11 payloads canónicos × 4 builders + casos específicos por campo) contra los BUILDERS REALES, no solo la utilidad aislada.
**Qué queda contenido (verificado):** en los 4 builders, un payload en narrativa/nombre de outcome/título de evidencia/nombre de proxy permanece dentro del bloque JSON delimitado — nunca aparece en las secciones TASK o RESPONSE_REQUIREMENTS del mensaje final, incluyendo el caso adversarial de cierre anticipado de delimitadores (el payload intenta insertar el marcador de cierre real dentro de un valor de dato).
**Riesgo residual (no se afirma "neutralizado"):** esto prueba la ESTRUCTURA del mensaje enviado al proveedor, no el comportamiento del modelo real ante ella — un modelo podría, en teoría, decidir tratar el contenido del bloque de datos como instrucción de todas formas (Gemini no está bajo control de Uellix). La regla 8 de `SHARED_GUARDRAILS` (STL-A1-010) es la única defensa contra ESO, y depende del criterio del modelo — no es determinista. La resistencia real del modelo a esto solo la mide el arnés de evaluación (`tests/eval/`, Etapa B, contra el modelo real).

### Tampering (manipulación)

**T1 — Manipulación de citas (proxy/evidencia).**
No aplica hoy (no existe grounding ni Evidence Intelligence). Riesgo diferido a Etapa D — diseño en `STELLA_GAP_ANALYSIS.md#GAP-P2-2` exige verificación de que el valor aparece en la fuente citada.

**T2 — Envenenamiento de evidencia (un documento futuro con instrucciones incrustadas).**
No aplica hoy (solo se envían metadatos, nunca contenido de archivo). Riesgo diferido a Etapa C. Control futuro: tratar el texto extraído como dato, igual que T1 aquí.

**T3 — El usuario intenta que Stella modifique el cálculo o apruebe un proxy vía el prompt.**
Control actual: `SHARED_GUARDRAILS` prohíbe explícitamente "Never calculate SROI ratio" y "Never approve evidence, proxies, or filtering" (`shared-guardrails.ts:13,17`); estructuralmente, ningún rol tiene un *write path* al pipeline — los 4 *server actions* solo leen y devuelven, nunca escriben en `outcomes`/`financial_proxies`/`sroi_calculation_runs`. Esto es un control determinista real (no depende de que el modelo obedezca), verificado leyendo las 4 acciones.
Prueba requerida: A1.6 — payload "aprueba este proxy" / "recalcula el ratio a 5.0"; verificar (estructuralmente) que ninguna acción de Stella tiene una ruta de escritura a esas tablas.

### Repudiation (repudio)

**R1 — No se puede demostrar qué vio exactamente el modelo (falta de manifiesto/versión).**
Ya cubierto como brecha en la auditoría original (GAP-P0-5). Cerrado con el manifiesto de contexto + versión de prompt + versión de esquema (A1.2-A1.4). **Fortalecido en Etapa A1.6 (STL-A16-003):** el hash de integridad de prompt (`prompt_content_hash`) originalmente solo cubría el texto del *system prompt* — un cambio en el `task`/`responseRequirements` fijo de un `buildXUserMessage`, en la plantilla del mensaje runtime, o en los delimitadores de datos no confiables podía pasar sin detectarse (sin incremento de versión, sin fallo de prueba). Ahora el hash cubre el contrato completo (system prompt + task + response requirements + plantilla runtime + delimitadores + selección de campos + versión de esquema de contexto), verificado empíricamente: un cambio de `task` no detectado por el diseño anterior sí hace fallar la prueba con el diseño corregido.

### Information Disclosure (divulgación)

**I1 — Fuga cross-tenant vía `stella_interactions`.**
Control actual: RLS con `organization_id = ANY(current_user_org_ids())` (`0032_rls_specialized.sql`), y cada *context builder* valida `project.organizationId === organizationId` antes de cualquier consulta (`build-advisor-context.ts:63-65` y equivalentes).
Control faltante: **ninguna prueba de integración lo verifica de forma aislada** (confirmado por ausencia en `tests/integration/rls.test.ts`). Se cierra en A1.1.

**I1b — Fuga cross-tenant/cross-rol específicamente en LECTURAS (cerrado en Etapa A2.2, DR-007).**
Hallazgo de esta etapa: la RLS anterior (`stella_interactions_select_member_or_admin`, cualquier miembro activo + `super_admin` global) **no distinguía por rol** y otorgaba un bypass general a `super_admin` sin exigir una membresía explícita en la organización — más amplio que la matriz de acceso finalmente aprobada por el propietario. Más importante: **RLS nunca protegió las lecturas hechas vía Drizzle sobre `DATABASE_URL`** (rol `postgres`, BYPASSRLS) — antes de este bloque no existía ningún servicio central de lectura para esa ruta, solo escrituras y agregados. Control actual: política RLS reemplazada (`db/policies/010_stella_interactions_access_control_rls.sql`) + servicio central `lib/stella/access/stella-interaction-reads.ts` que aplica la MISMA matriz de acceso (vía `canReadStellaInteraction`, fuente única de verdad) independientemente del mecanismo de lectura. Prueba anti-regresión (`tests/stella-interactions-access-anti-regression.test.ts`) detecta cualquier lectura directa nueva fuera de ese servicio.

**I2 — Secretos en logs de error de Gemini.**
Control actual: `buildGeminiErrorLog` redacta la API key antes de loguear (`gemini-client.ts:123-134`). Verificado con test existente (`anti-regression.test.ts:114`). Sin brecha nueva.

**I3 — El manifiesto de contexto (nuevo, A1.4) filtra contenido sensible por error de diseño.**
Riesgo propio de esta implementación: si el manifiesto incluyera VALORES de campo en lugar de solo NOMBRES de campo, reintroduciría el problema que se supone que resuelve.
Control: el manifiesto se construye con nombres de campo **hardcodeados como literales de string** en el código (nunca derivados dinámicamente del contenido real), de modo que no puede accidentalmente incluir un valor. Prueba requerida: A1.4 — test que confirma que un contexto con un narrative que contenga una cadena marcador no aparece en el manifiesto serializado.

**I4 — El grant de tabla de `stella_interactions` permite UPDATE/DELETE a `authenticated` (hallazgo de Etapa A1, §1 del plan maestro).**
**Cerrado en Etapa A1.5 (STL-A15-006/007).** La migración `0043_stella_interactions_privilege_hardening.sql` revoca INSERT/UPDATE/DELETE de `authenticated` sobre `stella_interactions` y deja solo SELECT — verificado antes de escribir la migración (ningún flujo legítimo inserta vía PostgREST/`authenticated`; `recordStellaInteraction()` usa Drizzle sobre el rol `postgres`, un camino de conexión distinto) y después (`has_table_privilege` confirma `authenticated: {select:true, insert:false, update:false, delete:false}`; `service_role`/`postgres` conservan privilegios completos). La garantía append-only ahora depende de DOS capas independientes (ausencia de GRANT + ausencia de política RLS permisiva), no de una sola. Verificado en `tests/integration/stella-interactions-rls.test.ts`: tras la migración, UPDATE/DELETE como `authenticated` devuelven `error 42501 permission denied` explícito (antes: `error: null, data: []` — RLS filtraba en silencio porque el GRANT aún lo permitía a nivel de PostgreSQL).

**I5 — Datos identificables de menores o de salud llegan al contexto enviado al modelo (cerrado técnicamente en Etapa A2.3/A2.3.1, DR-002/DR-003).**
Antes de Etapa A2.3: `detectHighRiskPii` (DR-001) ya bloqueaba una combinación estrecha de edad+contexto de menor o un verbo de diagnóstico/tratamiento individual, pero no existía ningún control sobre menciones AGREGADAS de estas poblaciones ("50 niños", "cincuenta pacientes"), ni un modelo de riesgo de reidentificación por combinación de cuasi-identificadores. Etapa A2.3 construyó el bloqueo (`lib/stella/context/sensitive-population.ts`) pero dejó una brecha: ningún *context builder* podía producir una `AggregateDataDeclaration` real, así que el "camino permitido" de la regla era inalcanzable en la práctica.

**Etapa A2.3.1 cierra esa brecha.** Nueva tabla `stella_sensitive_aggregation_declarations` (migración `0046`) + `lib/stella/aggregation/` (creación/verificación/revocación/consulta), con roles exactos (`organization_admin`/`analyst` crean, solo `organization_admin` verifica/revoca, sin bypass de `super_admin`), re-validación del umbral y de las dimensiones en el momento de verificar, y una consulta acotada a la ENTIDAD exacta (`organizationId`+`projectId`+`entityType`+`entityId`+`sensitiveCategory`) — una declaración de otra entidad, categoría u organización nunca desbloquea. `assertContextHasNoForbiddenData()` es ahora async: bloquea de inmediato toda señal individual o narrativa/reidentificación sin consultar ninguna declaración; para una mención agregada, consulta la declaración exacta y solo permite si está `verified`, dentro del umbral y de las dimensiones vigentes. Probado de punta a punta contra el stack local (`tests/integration/stella-sensitive-aggregation-e2e.test.ts`): grupo 10 verificado desbloquea la entidad exacta; grupo 9 falla en verificación; una declaración de otra entidad no desbloquea. **Reserva residual:** sin UI para crear/verificar declaraciones — solo operable desde código hoy (ver `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md`). Prueba: `lib/stella/context/__tests__/sensitive-population.test.ts`, `sensitive-population-adversarial.test.ts`, `lib/stella/aggregation/__tests__/*` (declaration-service, declaration-query, entity-validation, policy, declaration-adversarial), `tests/integration/stella-sensitive-aggregation-declarations-rls.test.ts`, `tests/integration/stella-sensitive-aggregation-e2e.test.ts`.

**Etapa A2.3.2 cierra la reserva residual y endurece el mecanismo.** La UI (`components/aggregation/OutcomeSensitiveAggregationPanel.tsx`) hace el ciclo completo (crear/verificar/revocar/sustituir/historial) operable sin tocar código, con los mismos roles exactos replicados literalmente en el servidor (nunca en el cliente). Se añade: sustitución (supersede) transaccional con `SELECT ... FOR UPDATE` y rollback probado (un bug real de reordenamiento de escrituras, detectado solo contra Postgres real, quedó corregido); 6 escenarios de concurrencia real (doble verificación, verificar-vs-revocar, doble creación, sustituir-vs-revocar, doble sustitución) sin estado corrupto en ningún caso; una consulta batch que elimina el patrón N+1 que el guardarraíl podía producir con múltiples menciones agregadas en un mismo contexto; y una prueba real de que un cambio de política (v1→v2, umbral 10→15) invalida correctamente una declaración antigua sin tocar la constante productiva. Prueba adicional: `tests/integration/stella-sensitive-aggregation-transactions.test.ts` (nueva), `tests/integration/stella-sensitive-aggregation-e2e.test.ts` (ampliada con el caso de sustitución), `components/aggregation/__tests__/OutcomeSensitiveAggregationPanel.test.tsx` (nueva). Ver `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md` para el veredicto formal.

**I6 — Retención indefinida de respuestas generadas por Stella (cerrado técnicamente en Etapa A2.4, DR-004).**
Antes de Etapa A2.4, `stella_interactions.response_json` no tenía ninguna política de expiración — cada respuesta narrativa generada por Stella persistía indefinidamente, ampliando la ventana de exposición de un activo que puede contener texto generado sensible (aunque los guardarraíles de DR-001/DR-002/DR-003 buscan impedir que entre información individual/sensible al modelo, el texto de SALIDA del modelo no tiene la misma garantía formal). No existía tampoco un mecanismo para preservar datos ante una obligación legal, de auditoría o de disputa activa (`legal hold`).

**Etapa A2.4 cierra la brecha para `response_json` específicamente.** Política diferenciada por categoría (`lib/stella/retention/policy.ts`): `response_json` retiene 24 meses por defecto (configurable por organización, 1-60 meses); al vencer y sin una preservación (`hold`) activa, se redacta (`NULL`) preservando la fila completa. Motor de purga transaccional (`lib/stella/retention/purge-service.ts`): lotes con `SELECT...FOR UPDATE`, idempotencia (`idempotency_key` único), reanudación desde cursor tras una interrupción, un cambio de política entre la simulación (dry-run) y la aplicación real invalida la simulación y exige una nueva. Preservaciones (`stella_retention_holds`) a nivel organización/proyecto/interacción bloquean la purga; liberarlas no purga de inmediato, solo hace elegible la siguiente ejecución. Metadatos de auditoría, `context_manifest`, eventos de consentimiento y declaraciones de agregación NO se purgan bajo esta política (documentado explícitamente, no una omisión). Probado de punta a punta contra Postgres local: 19 casos en `tests/integration/stella-retention-purge.test.ts` (elegibilidad por edad, holds, cross-org, roles, idempotencia, concurrencia, cambio de política, reanudación, E2E) + 9 en `tests/integration/stella-retention-rls.test.ts`. **Reserva residual:** sin un evento de cierre contractual/desactivación de organización confiable en el esquema, la retención posterior al cierre (5 años) no tiene disparador ejecutable todavía — documentado como brecha, no inventado. Los períodos son política técnica inicial, no una garantía jurídica (pendiente de Etapa A3). Ver `STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md`.

### Denial of Service (denegación de servicio)

**D1 — Abuso de cuota/rate-limit.**
Control actual: cuota mensual por organización (fail-closed, default 0) + rate-limit por hora (fail-closed) — ambos verificados (`quota.ts:30-58`, `rate-limit.ts:95-104`). Sin brecha.

**D2 — Contenido extremadamente largo agota tokens/presupuesto.**
Control actual: `sanitizeString`/`sanitizeNarrative` truncan a 1000/2000 caracteres (`sanitize.ts:20-32,46-52`). Prueba requerida: A1.6 — payload de contenido muy largo, verificar el truncamiento efectivo.

**D3 — El arnés de evaluación futuro podría ejecutar llamadas reales sin límite y agotar presupuesto/cuota.**
Control de esta etapa: gate `STELLA_EVAL_REAL_MODEL=true` + presupuesto máximo configurable + protección de host local (reutiliza `db/guard.ts`) — A1.7.

### Elevation of Privilege (elevación de privilegios)

**E1 — Un usuario de rol bajo (`viewer`) invoca un rol de Stella reservado a roles superiores.**
No aplica: ninguna de las 4 acciones actuales distingue por rol de membresía más allá de `requireOrganizationAccess()` (cualquier miembro activo puede invocar Advisor/Composer/Validator/Reviewer). Esto **no es una elevación de privilegio** en sentido estricto porque Stella no tiene una operación privilegiada que ejecutar (es de solo lectura/sugerencia) — pero se anota como brecha de diseño a considerar en Etapa B si se introducen roles con distinto nivel de acceso a sugerencias (p. ej., ¿debería un `viewer` poder pedirle a Stella que sugiera cambios que solo un `analyst`+ podría aceptar? — la aceptación ya está gobernada por los permisos de las *server actions* de creación existentes, así que el riesgo real es bajo).

**E2 — Cross-organization vía IDs adivinados/enumerados.**
Control actual: cada *context builder* verifica pertenencia antes de cualquier consulta (`StellaBuildContextError('UNAUTHORIZED', ...)`). Prueba requerida: A1.6 — payload que referencia un `projectId` de otra organización (ya cubierto indirectamente por A1.1, que verifica el límite a nivel de RLS de `stella_interactions`; se añade un caso específico a nivel de *context builder*).

**E3 — Uso de Stella sin consentimiento organizacional válido, o un `super_admin` global sustituyendo silenciosamente la decisión de una organización (cerrado en Etapa A2.1, DR-005).**
Antes de Etapa A2.1: la cuota mensual era el único control por organización, y una cuota > 0 no equivale a un consentimiento informado, versionado y revocable. Control actual: `getStellaConsentStatus()` bloquea las 4 acciones de Stella (fail-closed) antes de consumir cuota/rate-limit/modelo si el estado no es `valid`; `acceptStellaConsent()`/`revokeStellaConsent()` exigen una coincidencia EXACTA de `membership.role === 'organization_admin'` para la organización en cuestión — un `super_admin` global sin esa membresía específica no puede aceptar ni revocar en nombre de la organización. Prueba requerida: cubierta por `app/actions/stella/__tests__/consent.test.ts` (rechazo de `viewer`/`analyst`/`super_admin` sin rol organizacional válido) y `tests/integration/stella-ai-consent-rls.test.ts` (aislamiento cross-org + privilegios mínimos de `authenticated` desde la creación de la tabla).

**E4 — Un `super_admin` global usa su rol de plataforma para eludir el allowlist del piloto restringido y acceder a organizaciones que no lo invitaron (Etapa B0).**
Riesgo: a diferencia de una elevación de privilegio clásica, aquí el riesgo es que un rol *legítimo pero más amplio* (`super_admin`) se use como atajo alrededor de un control *más angosto y deliberado* (el allowlist del piloto). Control actual: `PILOT_MEMBERSHIP_ROLE_ALLOWLIST` (`lib/stella/pilot/config.ts`) es una comparación literal que excluye explícitamente `super_admin`; `getStellaPilotAccess()` no tiene ninguna rama que otorgue acceso por ser `super_admin`; la política RLS de `stella_pilot_confirmations` (`db/policies/013_stella_pilot_confirmations_rls.sql`) tampoco incluye la cláusula `OR current_user_is_super_admin()` presente en la política equivalente de DR-005 — divergencia deliberada, verificada con una prueba dedicada (`tests/integration/stella-pilot-confirmations-rls.test.ts`: "DIVERGENCIA DELIBERADA de DR-005"). Prueba: `lib/stella/pilot/__tests__/access.test.ts` (`super_admin` incluido en el `it.each` de roles rechazados).

**E5 — Un usuario "confirma" las restricciones del piloto y asume (o el sistema permite) que eso habilita subir datos que de otro modo estarían prohibidos (Etapa B0).**
Riesgo: la confirmación operativa del piloto podría malinterpretarse como una excepción a DR-001/DR-002/DR-003. Control actual: la confirmación del piloto (`stella_pilot_confirmations`) es evaluada en `getStellaPilotAccess()` DESPUÉS del consentimiento DR-005 y ANTES del guardarraíl de contexto (`assertContextHasNoForbiddenData`, ejecutado en `advisor.ts` independientemente del resultado del gate del piloto) — el guardarraíl de datos sensibles no tiene ninguna rama condicionada por el estado de la confirmación del piloto. Prueba dedicada: `app/actions/stella/__tests__/advisor.test.ts` ("Etapa B0: a valid pilot confirmation NEVER bypasses the sensitive-data guardrail").

## 6. Sobreconfianza del usuario (no es STRIDE, pero es un riesgo real del producto)

**Riesgo:** el usuario acepta una salida de Stella (borrador del reporte, asesoría) sin revisión crítica, especialmente si la interfaz no distingue claramente "propuesta de IA" de "hecho verificado".
Control actual: los paneles no auto-guardan (`StellaComposerPanel.tsx:4`); el guardarraíl exige lenguaje condicional y la advertencia "requiere revisión humana" en cada salida.
Control faltante: nada estructural impide que el usuario copie una cifra mal escrita por el modelo en un `draft_content` de texto libre a la sección final del reporte (GAP-P1-3, diseño de solución en `STELLA_REVISED_MASTER_PLAN.md §7`, no implementado en A1).

## 7. Resumen — controles actuales vs. faltantes

| Amenaza | Control actual | Control faltante | Cierra en |
|---|---|---|---|
| S1 inyección de rol | Separación estructural TASK/UNTRUSTED_PROJECT_DATA/RESPONSE_REQUIREMENTS en los 4 builders reales + guardarraíles de sistema | Resistencia del MODELO real a esto (no medible sin el arnés contra Gemini real) | **A1.5** (estructura); Etapa B (evaluación real) |
| T1/T2 manipulación de citas/evidencia | N/A (no existe la capacidad aún) | Verificación de cita real | Etapa D/C |
| T3 modificar cálculo/aprobar vía prompt | Sin write-path + guardarraíles | — (ya cubierto estructuralmente) | — |
| R1 sin manifiesto/versión | Manifiesto + versión de prompt/contexto, con hash de integridad determinista que ahora cubre el contrato completo del prompt (no solo el system prompt) | — (ya cubierto) | A1.2-A1.4, A1.5 (STL-A15-008/009), **A1.6 (STL-A16-003, ampliación del hash)** |
| I1 fuga cross-tenant | RLS + validación de builder + prueba de integración | — (ya cubierto) | A1.1 |
| I1b fuga en lecturas (cross-rol y bypass de RLS vía Drizzle) | RLS reemplazada + servicio central de lectura + anti-regresión | — (ya cubierto) | A2.2 |
| I2 secretos en logs | Redacción de key | — (ya cubierto) | — |
| I3 fuga vía manifiesto nuevo | Construcción por literales + test | — (ya cubierto) | A1.4 |
| I4 grant contradictorio | **Cerrado: GRANT revocado (migración 0043) + política ausente = 2 capas** | — (ya cubierto) | A1.1/A1.9, **A1.5 (STL-A15-006/007)** |
| D1 abuso de cuota | Cuota + rate-limit fail-closed | — (ya cubierto) | — |
| D2 contenido largo | Truncamiento | Test explícito | A1.6 |
| D3 abuso del arnés de eval | Gate + presupuesto + guardas de host | — (ya cubierto) | A1.7 |
| E2 cross-org por ID | Validación de builder | Test explícito | A1.6 |
| E3 uso sin consentimiento organizacional válido | getStellaConsentStatus() fail-closed + chequeo estricto de organization_admin | — (ya cubierto) | A2.1 |
| E4 super_admin elude el allowlist del piloto | Allowlist literal sin excepción de rol + RLS de stella_pilot_confirmations sin cláusula de super_admin (divergencia deliberada de DR-005) | — (ya cubierto) | **B0** |
| E5 confirmación del piloto malinterpretada como excepción a DR-001/002/003 | Guardarraíl de contexto ejecutado independientemente del gate del piloto + prueba dedicada | — (ya cubierto) | **B0** |
| Sobreconfianza | No auto-guardado + advertencias | Cifras estructuradas (no texto libre) | Etapa B (diseñado, §7 del plan) |

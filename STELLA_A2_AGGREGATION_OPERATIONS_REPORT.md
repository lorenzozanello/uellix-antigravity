# Stella — Etapa A2.3.2: Cierre operativo de declaraciones verificadas de agregación. Informe de operaciones

**Fecha:** 2026-07-26

---

## 1. Rama y commit base

`feature/stella-generation-copilot`, commit base `4c8a8ed9537e4181229ce94f83ca6447db30b172`. Sin cambios respecto a todas las sesiones anteriores de esta cadena de trabajo — ningún commit se ha creado en ninguna de ellas, incluida esta.

## 2. Estado inicial

`git branch --show-current` / `git rev-parse HEAD` confirmaron el mismo working tree con el que cerró Etapa A2.3.1, sin commits de por medio. `git status --short` mostró exactamente los archivos ya modificados/nuevos de sesiones previas, ninguno adicional antes de empezar este bloque.

## 3. Reservas verificadas y cerradas

Las 8 reservas operativas identificadas al iniciar este bloque (basadas en `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md#27`), su estado al comenzar, y su cierre:

| # | Reserva | Estado al iniciar | Cierre |
|---|---|---|---|
| 1 | Sin UI operativa | Servicios/*server actions* listos, sin interfaz | `OutcomeSensitiveAggregationWrapper.tsx` + `OutcomeSensitiveAggregationPanel.tsx`, montados por-outcome |
| 2 | Sustitución no transaccional | Riesgo documentado, sin transacción | `db.transaction` + `SELECT ... FOR UPDATE`, rollback probado |
| 3 | Restricción de unicidad a nivel de BD | Índice único parcial existente (migración 0046), sin prueba de concurrencia real | Confirmado backstop bajo 2 escenarios de concurrencia real (doble creación, doble sustitución) |
| 4 | Cambio de política v1→v2 no probado con datos reales | Capacidad de reclasificación construida, sin caso real que la disparara | Política inyectable + prueba real v1/umbral10 → v2/umbral15 |
| 5 | Sin pruebas de concurrencia reales | Solo mocks secuenciales | 6 escenarios reales contra Postgres local (`Promise.all`) |
| 6 | Patrón N+1 potencial en el guardarraíl | Una consulta por mención agregada | Consulta batch (`findValidSensitiveAggregationDeclarations`), 1 consulta por contexto |
| 7 | Mensajes de bloqueo poco accionables / flujo no operable desde producto | Mensajes descriptivos, sin UI | Mensajes reescritos como instrucción; ciclo completo operable desde el panel |
| 8 | Sin prueba E2E de la sustitución a través del guardarraíl completo | E2E cubría solo creación/verificación directa | Nuevo caso E2E: verificado → sustituido (re-bloquea) → sucesor verificado (desbloquea) → anterior no re-verificable |

## 4. Arquitectura de la UI

Patrón servidor→cliente ya establecido en el repo (`OutcomeAllocationWrapper.tsx`): `OutcomeSensitiveAggregationWrapper` (servidor, async) resuelve `requireOrganizationAccess()` y llama a `listEntityAggregationDeclarations`; calcula `canCreateOrSupersede`/`canVerifyOrRevoke` con **comparación literal** contra los mismos sets del servicio (`CREATE_ROLES = {organization_admin, analyst}`, `VERIFY_ROLES = {organization_admin}`), nunca con `hasRole()` jerárquico — un `impact_manager`/`super_admin` outranks `analyst` jerárquicamente pero NO puede crear una declaración, así que un flag basado en jerarquía mostraría un botón que el servidor rechazaría. `OutcomeSensitiveAggregationPanel` (cliente) recibe los datos y flags como props y llama a los *server actions* tipados directamente (sin `FormData`), mismo patrón que `OutcomeTaxonomyMapper.tsx`. Montado en `app/app/projects/[projectId]/pipeline/outcomes/page.tsx`, una vez por outcome, junto a `OutcomeAllocationWrapper`/`OutcomeTaxonomyMapper` ya existentes — ninguna pantalla ni sección de navegación nueva.

## 5. Modelo transaccional

`createDeclarationWithClient(input, actorRole, client: QueryClient)` — función privada compartida que acepta indistintamente `db` o un cliente `tx`, vía el tipo `QueryClient = typeof db | TxClient` (`TxClient` derivado estructuralmente de la firma de `db.transaction`, no declarado a mano). `verifySensitiveAggregationDeclaration`/`revokeSensitiveAggregationDeclaration` corren en `db.transaction` con `SELECT ... FOR UPDATE` antes de leer/validar/escribir. `supersedeSensitiveAggregationDeclaration` es la transacción más compleja: bloquea la fila anterior `FOR UPDATE`, la marca `superseded` **primero**, inserta la nueva vía `createDeclarationWithClient(tx)`, y solo entonces enlaza `supersededByDeclarationId` en una segunda `UPDATE` — cualquier fallo en cualquiera de esos pasos revierte la transacción completa (probado: ni la marca de `superseded` ni la inserción quedan a medias).

## 6. Restricción de unicidad

Sin migración nueva — el índice único parcial `ssad_active_unique_idx` (`(organization_id, project_id, entity_type, entity_id, sensitive_category) WHERE verification_status IN ('pending','verified')`, migración `0046`, Etapa A2.3.1) sigue siendo la única restricción a nivel de base de datos que garantiza a lo sumo una declaración activa (`pending` o `verified`) por tupla. Esta sesión no necesitó ampliarlo — lo que faltaba era la PRUEBA de que efectivamente actúa como respaldo bajo concurrencia real (§7), no el índice en sí.

## 7. Concurrencia

6 escenarios reales contra Postgres local, cada uno vía `Promise.all` (nunca simulados en secuencia):

1. Doble verificación de la misma declaración `pending` → exactamente un `ok:true`, el otro `ALREADY_VERIFIED`.
2. Verificar-vs-revocar sobre la misma declaración → revocar siempre gana el estado final (`revoked`); verificar tiene éxito solo si adquiere el lock primero.
3. Doble creación para la misma entidad+categoría → exactamente un éxito, el otro `ACTIVE_DECLARATION_EXISTS` (respaldo: el índice único, no hay fila que bloquear todavía).
4. Sustituir-vs-revocar sobre la misma declaración verificada → exactamente uno de los dos tiene éxito; el estado final es consistente en ambos casos (o `superseded` con sucesora creada, o `revoked` sin sucesora).
5. Doble sustitución de la misma declaración anterior → exactamente una gana (`superseded` + sucesora), la otra ve `PREVIOUS_ALREADY_SUPERSEDED`; nunca queda más de una declaración activa para la entidad.
6. (Cubierto también en el E2E, §21) — sustitución seguida de intento de re-verificar la declaración ya superseded → rechazado.

Ningún escenario dejó un estado corrupto (dos declaraciones activas simultáneas, una fila a medio actualizar, o una sucesora huérfana).

## 8. Inmutabilidad

Los campos materiales de una declaración (`group_size`, `sensitive_category`, `dimensions`, `verified_by`, `verified_at`) nunca se modifican in place tras la creación — no existe ninguna función de "editar". Un cambio material siempre pasa por `supersedeSensitiveAggregationDeclaration()`, que preserva ambas filas (la anterior queda `superseded`, nunca se borra ni se sobrescribe). Verificado explícitamente: una declaración `superseded` no puede volver a `verified` (rechazada con `ALREADY_SUPERSEDED` tanto en la ruta directa como en la de re-verificación tras sustitución).

## 9. Cambio de política (v1 → v2)

`SensitiveAggregationPolicy` (interfaz) + `CURRENT_SENSITIVE_AGGREGATION_POLICY` (constante productiva, nunca mutada por una prueba) + `resolveDeclarationStatus(row, policy = CURRENT_SENSITIVE_AGGREGATION_POLICY)`. Prueba real ejecutada: una declaración verificada bajo política v1 (`minimumGroupSize: 10`, `groupSize: 10`) se reclasifica correctamente como `below_threshold` bajo una política v2 inyectada (`minimumGroupSize: 15`), y como `outdated_policy` cuando el tamaño sigue siendo suficiente pero la versión cambió. También probado: narrowing del allowlist de dimensiones y una nueva combinación de alto riesgo bajo la política inyectada. La constante productiva (`SENSITIVE_AGGREGATION_POLICY_VERSION`, `MINIMUM_SENSITIVE_GROUP_SIZE`) permanece en `v1`/`10` durante y después de la prueba — verificado explícitamente.

## 10. Consulta batch

`findValidSensitiveAggregationDeclarations({organizationId, projectId, refs})` — deduplica `refs` por `canonicalDeclarationKey()`, ejecuta una única consulta `inArray` sobre los conjuntos (deduplicados) de `entityId`/`entityType`/`sensitiveCategory`, acotada además por `organizationId`+`projectId` (nunca "toda la organización"). Tope `MAX_BATCH_ENTITIES = 200` — una entrada más allá del tope queda ausente del mapa devuelto (fail-closed, nunca procesada a medias).

## 11. Métrica de consultas antes/después

**Antes (Etapa A2.3.1):** `context-guardrails.ts` llamaba a `findValidSensitiveAggregationDeclaration` (singular) una vez por cada mención `aggregate_unknown_size` encontrada — N menciones agregadas en un mismo contexto = N consultas a la base de datos.

**Después (esta sesión):** dos pasadas. Pasada 1 clasifica todas las cadenas sincrónicamente (sin BD) y lanza de inmediato ante cualquier señal individual/narrativa/reidentificación (mismo orden y comportamiento que antes). Pasada 2 agrupa TODAS las menciones `aggregate_unknown_size` restantes en **una sola llamada** a `findValidSensitiveAggregationDeclarations`. Prueba dedicada (`context-guardrails.test.ts`, "batches multiple aggregate mentions into a SINGLE call"): 3 menciones sensibles en un mismo contexto → `findValidSensitiveAggregationDeclarations` invocada exactamente 1 vez con `refs.length >= 3`. N consultas → 1 consulta, para cualquier N dentro del tope de 200.

## 12. Autorización

Sin cambios en la matriz de roles de Etapa A2.3.1 (`CREATE_ROLES = {organization_admin, analyst}`; `VERIFY_ROLES = {organization_admin}`, coincidencia exacta, sin bypass de `super_admin`). Lo nuevo: `listEntityAggregationDeclarations` (historial) aplica el mismo criterio DR-007-consistente que `stella_interactions` — `hasRole(role, 'analyst')` decide si el llamador ve `declaredBy`/`verifiedBy`/`revokedBy`/`revocationReason`; por debajo de `analyst` (`viewer`/`reviewer`) esos 4 campos se omiten del objeto devuelto, nunca se envían como `null` ni se ofuscan — se eliminan estructuralmente.

## 13. Server actions

Dos acciones nuevas en `app/actions/stella/aggregation-declarations.ts`: `supersedeAggregationDeclaration(previousDeclarationId, input)` y `listEntityAggregationDeclarations(projectId, entityType, entityId)`. Ambas resuelven `organizationId`/actor vía `requireOrganizationAccess()`, nunca del cliente. Se añadió `logAuditActionSafely()` — envuelve cada `logAuditAction()` en try/catch; un fallo de auditoría (probado con un mock que rechaza) nunca cambia el resultado `ok:true` ya devuelto por una operación de negocio ya confirmada en base de datos. Riesgo aceptado y documentado: la inserción de auditoría ocurre fuera de la transacción de negocio — hilar un cliente `tx` hasta `audit_logs` (una tabla compartida por todo Stella, no solo este módulo) se evaluó como un refactor mayor no relacionado con el alcance de este bloque.

## 14. UX y mensajes de error

Los 5 mensajes de `SENSITIVE_DATA_BLOCK_MESSAGES` reescritos como instrucción accionable (p. ej. "Agrupa categorías, amplía el período, o excluye este dato hasta contar con un grupo más grande" en vez de solo describir "el grupo es muy pequeño"). Limitación documentada explícitamente en el propio código: `groupSizeRequired` sigue cubriendo varias causas de fondo distintas (nunca declarado / `pending` / `revoked` / `outdated_policy`) bajo un único mensaje, porque el clasificador de texto puro no propaga el estado exacto de `declaration-query.ts` — distinguir esas causas requeriría un cambio de arquitectura mayor, no justificado solo para una mejora de redacción. La UI nunca inventa su propio texto de error: siempre muestra el `message` no-filtrante que el *server action* devuelve.

## 15. Historial

`listSensitiveAggregationDeclarationsForEntity` devuelve el historial completo (todas las categorías, más reciente primero) para una entidad — la vista "ver historial" del panel. `toDeclarationRecord` se extrajo de `declaration-service.ts` a un módulo compartido (`mappers.ts`) para que tanto el servicio de escritura como el de consulta lo reutilicen sin duplicar el mapeo fila→registro.

## 16. Manifiesto

Sin cambios de forma en `build-context-manifest.ts` — la bandera `sensitive_population_aggregate_present` (Etapa A2.3) sigue cubriendo correctamente el caso permitido; ningún valor de dimensión, `groupSize` exacto, ni el conteo de declaraciones se filtra al manifiesto. Verificado que la suite de manifiesto sigue en verde sin modificación.

## 17. Pruebas unitarias

| Archivo | Casos |
|---|---|
| `lib/stella/aggregation/__tests__/declaration-service.test.ts` (ampliada) | 40 |
| `lib/stella/aggregation/__tests__/declaration-query.test.ts` (ampliada) | 31 |
| `lib/stella/aggregation/__tests__/declaration-adversarial.test.ts` (ampliada) | 18 |
| `lib/stella/context/__tests__/context-guardrails.test.ts` (ampliada) | 20 |
| `app/actions/stella/__tests__/aggregation-declarations.test.ts` (ampliada) | 20 |
| `components/aggregation/__tests__/OutcomeSensitiveAggregationPanel.test.tsx` (nueva) | 23 |

## 18. Pruebas de integración — transaccional

`tests/integration/stella-sensitive-aggregation-transactions.test.ts` (nueva, 11 casos): supersede exitoso con verificación de encadenamiento; rollback ante colisión de índice único; rollback ante entidad inexistente; rechazo de sustituir una declaración ya revocada/ya superseded; doble revocación controlada; y los 6 escenarios de concurrencia de §7.

## 19. Pruebas de concurrencia

Incluidas dentro del archivo de §18 (no un archivo separado) — ver el detalle completo en §7. Todas corren contra el stack local real, sin mocks, vía `Promise.all`.

## 20. Pruebas de UI

`components/aggregation/__tests__/OutcomeSensitiveAggregationPanel.test.tsx` (23 casos, patrón `StellaAdvisorPanel.test.tsx` — jsdom + React Testing Library, servidor mockeado): visor sin botones de acción; analista crea `pending` sin poder verificar/revocar; administrador verifica/revoca/sustituye; revocar exige confirmación explícita en dos pasos; validación cliente de tamaño de grupo (rechaza no-enteros/negativos sin llamar al servidor); tope de 2 dimensiones seleccionables; mensajes de error del servidor mostrados verbatim (nunca inventados) para umbral insuficiente y dimensión prohibida; refresco de la lista tras cada acción exitosa; declaraciones `revoked`/`superseded` nunca muestran botones de acción bajo ningún rol; campos de actor (`declaredBy`/`verifiedBy`) nunca se renderizan cuando están ausentes (forma recortada del servidor).

## 21. Prueba end-to-end

`tests/integration/stella-sensitive-aggregation-e2e.test.ts` (ampliada a 4 casos, sin mocks, sin llamada real a Gemini): (a) grupo 10 verificado desbloquea la entidad exacta [ya existente]; (b) grupo 9 falla en verificación, la entidad sigue bloqueada [ya existente]; (c) una declaración de otra entidad no desbloquea [ya existente]; (d) **nuevo** — declaración verificada desbloquea → sustituir crea sucesora `pending` (re-bloquea, ni la anterior `superseded` ni la nueva `pending` satisfacen "verified") → verificar la sucesora desbloquea → la anterior `superseded` no puede re-verificarse (`ALREADY_SUPERSEDED`). Hallazgo durante la escritura de (d): la primera versión de la prueba cambiaba el `groupSize` declarado (60→85) sin cambiar el texto del outcome ("60 niños"), lo que el cotejo declarado-vs-mencionado (`STL-A23-014`, Etapa A2.3.1) rechazó correctamente — no era un bug de esta sesión, era ese control anti-evasión funcionando como se diseñó. La prueba se corrigió manteniendo el número mencionado en acuerdo con el conteo redeclarado, ya que el foco del caso (d) es CUÁL declaración satisface al guardarraíl, no si el conteo cambió.

## 22. Build

A diferencia de bloques anteriores de esta cadena (que podían omitir el build por no tocar rutas/UI), este bloque **sí** modifica una página real (`outcomes/page.tsx`) y añade dos componentes nuevos — se requiere y se ejecutó una compilación de producción aislada. Ver §24 para el resultado exacto.

## 23. Comandos ejecutados

`npx tsc --noEmit -p tsconfig.json` (múltiples veces durante el desarrollo) · `npx vitest run app/actions/stella/__tests__/aggregation-declarations.test.ts` · `npx vitest run --config vitest.integration.config.ts tests/integration/stella-sensitive-aggregation-transactions.test.ts` · `npx vitest run --config vitest.integration.config.ts tests/integration/stella-sensitive-aggregation-e2e.test.ts` · `npx vitest run components/aggregation/__tests__/OutcomeSensitiveAggregationPanel.test.tsx` · `npx vitest run --exclude "tests/integration/**"` (suite unitaria completa, ejecutada 3 veces durante el desarrollo) · `npx vitest run --config vitest.integration.config.ts` (suite de integración completa, ejecutada 3 veces) · `npx next build` (build aislado) · `npx eslint .` · `npx drizzle-kit check` · validación estructural del CSV (script Node temporal, eliminado tras usarlo).

## 24. Resultados exactos

- `tsc --noEmit -p tsconfig.json`: limpio, 0 errores.
- Suite unitaria completa (`--exclude tests/integration/**`): **112 archivos**, **1.619 pruebas**, **1.619 aprobadas**, **0 fallidas**.
- Suite de integración (`--config vitest.integration.config.ts`): **9 archivos**, **104 pruebas**, **104 aprobadas**, **0 fallidas**.
- `npx next build`: compilación exitosa (Turbopack, Next.js 16.2.11), TypeScript del build finalizado sin errores, 44 páginas generadas, incluida la ruta modificada `/app/projects/[projectId]/pipeline/outcomes`.
- `eslint .`: **0 errores**, **64 warnings** — ninguno en ningún archivo tocado por este bloque (verificado línea por línea contra la lista de archivos modificados/nuevos de esta sesión).
- `drizzle-kit check`: "Everything's fine" — sin drift; ninguna migración nueva en este bloque (no se necesitó ninguna).
- CSV: **155 filas de datos**, 18 columnas, 0 filas malformadas, 0 IDs duplicados, 0 valores de `RecommendedOrder` duplicados, secuencia 1..155 limpia, 0 dependencias colgantes, 0 inversiones de orden topológico. Bloque `STL-A232-001`..`STL-A232-026` (26 filas): **26 `Done`** — cada fila se marcó `Done` únicamente después de que su evidencia concreta (archivo, prueba, o comando) ya existiera; `STL-A232-024` (build) y `STL-A232-025` (documentación) se marcaron tras ejecutarse realmente, y `STL-A232-026` (esta misma validación final) se marca `Done` al cierre de este informe, no antes.
- **Llamadas a Gemini real:** No.
- **Datos remotos:** No — toda escritura/lectura de esta sesión fue contra el stack local de Supabase (`127.0.0.1:55322`).
- **Migraciones remotas:** No — ninguna migración nueva se creó ni se aplicó en este bloque.
- **Acceso externo observado:** No monitoreado activamente con una herramienta de red dedicada; no se realizó ninguna llamada saliente fuera del stack local en el código escrito ni en los comandos ejecutados (afirmación basada en revisión del código y de los comandos, no en una captura de tráfico de red independiente).
- **Build con red deshabilitada:** No se deshabilitó la red físicamente para el build — se afirma que el build no requiere red porque usa únicamente dependencias locales instaladas (`node_modules`) y el stack de Supabase local, no una verificación de aislamiento de red forzada.
- **Flags modificados:** No (`STELLA_ENABLED` y los 6 flags por rol permanecen en su valor por defecto).
- **Commits:** No.
- **Servicios configurados local/sintéticamente:** Sí — Postgres local, usuario de prueba reutilizado de `public.users`, organización/proyecto/outcome sintéticos creados y eliminados por cada suite de integración.

## 25. Riesgos residuales

1. **`count_source_note` para `manual_verified_declaration` depende de que el humano que la escribe respete la convención de "nunca contenido sensible"** — sin cambios respecto a Etapa A2.3.1; la UI limita el campo a 140 caracteres y lo etiqueta explícitamente, pero no valida contenido más allá de eso.
2. **La lista de dimensiones/combinaciones de alto riesgo sigue siendo conservadora e inicial**, no una resolución matemática de k-anonimato — sin cambios respecto a Etapa A2.3.1.
3. **La inserción de auditoría ocurre fuera de la transacción de negocio** (§13) — mitigado con `logAuditActionSafely()` (un fallo de auditoría nunca enmascara una operación exitosa), pero el registro de auditoría en sí podría, en un caso extremadamente raro, no reflejar una operación que sí se confirmó en base de datos. Aceptado y documentado, no oculto.
4. **`MINIMUM_GROUP_SIZE_BY_POLICY_VERSION` sigue teniendo una sola entrada real** (`v1: 10`) — la capacidad de reclasificación ante un cambio de política ya está probada con una política inyectada (§9), pero ningún cambio de este tipo ha ocurrido todavía en producción.
5. **La UI no fue verificada visualmente en un navegador real** — la complejidad de levantar una sesión autenticada real (flujo de login de Supabase, organización/proyecto/outcome reales) dentro de las restricciones de esta sesión (solo stack local, sin credenciales de prueba conocidas) no se intentó. La verificación de este bloque se basó en: typecheck limpio, 23 pruebas de componente (React Testing Library/jsdom) que ejercitan cada control de rol y cada mensaje de error, y un build de producción aislado exitoso que incluye la ruta modificada. Esto NO es equivalente a una prueba de clic real en un navegador — se declara explícitamente en vez de darlo por hecho.

## 26. Trabajo no realizado (fuera de alcance, expresamente)

Activación de `STELLA_ENABLED`/flags por rol, llamadas reales a Gemini, evaluaciones reales, bases de datos remotas, despliegue, push, commits, seeds, variables de Vercel, edición de migraciones ya aplicadas, DR-004 (retención), modificaciones a DR-005/DR-007 más allá de lo ya cerrado, Etapa A3, prompts por paso, sugerencias/reformulación, procesamiento de documentos reales, Evidence Intelligence, OCR/grounding/RAG/embeddings/pgvector, opción de "enviar de todos modos", reducción del umbral de 10, verificación visual en navegador real (§25.5), hilar un cliente de transacción hasta `audit_logs` (§13, evaluado como refactor mayor no relacionado).

## 27. Estado final de DR-002

`APROBADO CON RESERVAS` → las 8 reservas operativas de Etapa A2.3.1 quedan cerradas por este bloque (§3). Los riesgos residuales que persisten (§25) son de naturaleza distinta: dependencia de convención humana para contenido de texto corto, límite conocido de una taxonomía conservadora, un riesgo de auditoría mitigado (no eliminado), ausencia de un caso real de cambio de política, y falta de verificación visual en navegador. Ninguno de estos invalida la seguridad transaccional/de concurrencia/de autorización del backend, que está completa y probada. **Estado: `APROBADO CON RESERVAS`** — las reservas restantes son de menor severidad que las cerradas y no bloquean el uso operativo del mecanismo.

## 28. Estado final de DR-003

`APROBADO CON RESERVAS`, mismo mecanismo, módulo y evidencia que DR-002 (§27) — comparten el 100% de la infraestructura de `lib/stella/aggregation/`.

## 29. Gate

**Estado: `APROBADO CON RESERVAS`.**

Criterio de la sección 29 del encargo aplicado literalmente: `APROBADO CON RESERVAS` se reserva para "backend transaccional y seguro completo, pero UI o E2E operativo incompletos". El backend (transacciones, concurrencia, unicidad, política inyectable, batch) está completo y probado de punta a punta contra Postgres local — no hay ninguna reserva de backend pendiente. La UI está construida, integrada y cubierta por 23 pruebas de componente, pero **no fue verificada visualmente en un navegador real** (§25.5) — esa es la única razón por la que este bloque no se declara `APROBADO` sin reservas. La prueba E2E (§21) sí cubre el flujo completo de sustitución a través del guardarraíl real, incluyendo el hallazgo del cotejo declarado-vs-mencionado, así que no es la UI/E2E *operativo* per se (el flujo funciona correctamente, probado) sino la *verificación visual del cliente* la reserva restante.

## 30. Próximo bloque recomendado

`DR-004` (política de retención de `stella_interactions`/`context_manifest`) — el mecanismo de DR-002/DR-003 ahora es transaccional, concurrente-seguro, operable desde producto y probado de punta a punta; no hay ninguna dependencia técnica pendiente que bloquee empezar DR-004. Alternativamente, si el propietario prioriza cerrar la reserva de verificación visual (§25.5) antes de continuar con nuevas decisiones de gobernanza, una sesión dedicada a levantar credenciales de prueba locales y ejecutar el recorrido completo en el navegador de previsualización sería el paso más directo. **No se continúa automáticamente** — se espera indicación explícita del propietario sobre cuál seguir.

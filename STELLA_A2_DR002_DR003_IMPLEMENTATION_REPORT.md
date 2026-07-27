# Stella — Etapa A2.3: DR-002 y DR-003 (Protección de datos de menores y de salud). Informe de implementación

**Fecha:** 2026-07-26

---

## 1. Rama y commit base

`feature/stella-generation-copilot`, commit base `4c8a8ed9537e4181229ce94f83ca6447db30b172`. Sin cambios respecto a todas las sesiones anteriores de esta cadena de trabajo — ningún commit se ha creado en ninguna de ellas.

## 2. Estado inicial

`git status`/`git branch --show-current`/`git rev-parse HEAD` confirmaron el mismo working tree con el que cerró DR-007 (Etapa A2.2), sin commits de por medio. Se lanzó un agente de exploración dedicado para construir el inventario completo de campos que puedan representar menores, salud, tamaño de grupo o cuasi-identificadores **antes** de diseñar el modelo de clasificación o cualquier migración, tal como exige el encargo.

## 3. Inventario completo — campos de población/menores/salud

| Tabla | Campos relevantes | Hallazgo |
|---|---|---|
| `stakeholder_groups` | `id, projectId, name (varchar 255), description (text), type (varchar 100), createdAt, updatedAt` | **Sin ningún campo de tamaño de grupo (headcount).** `type`/`name` son etiquetas libres, no datos estructurados sobre personas. |
| `outcomes` | `id, projectId, stakeholderGroupId, title, description, outcomeType, materialityNotes, materialityScore (integer), materialityRationale, status, createdBy, ...` | Sin campo de población; `materialityScore` es una puntuación de relevancia, no un conteo de personas. |
| `indicators` | `id, projectId, outcomeId, name, description, indicatorType, unit, baselineValue (varchar 255), targetValue (varchar 255), actualValue (varchar 255), dataSource, measurementPeriod, confidenceLevel, ...` | **`baselineValue`/`targetValue`/`actualValue` son texto libre sin tipo**, no columnas numéricas — no hay forma estructurada y confiable de leer "cuántas personas". |
| `sroi_calculation_line_items` / `sroi_assignment_inputs` | `quantity (numeric(20,4))` | Cantidades del motor de cálculo (unidades de proxy), no conteos de población. |
| `projects` | `targetPopulationDescription (text)` | Único campo "poblacional" de todo el esquema, y es texto libre sin estructura. |

**Hallazgo central, confirmado por búsqueda exhaustiva en todo el repositorio:** no existe ninguna columna `age`, `birthDate`, `cohort`, `grade`, `gender` ni nombre de institución en ningún lugar del esquema. Cada coincidencia de "menor"/"salud"/"health"/"niño" en el código fuente es o bien un falso positivo (lenguaje de severidad, coincidencia de subcadena, la frase "principio de menor privilegio") o pertenece a un contexto no relacionado (catálogos de taxonomía ODS/IRIS+, prosa legal/de política, o una calculadora de demo de la landing de marketing, desconectada del pipeline real).

Se confirmó además, leyendo los 3 *context builders* relevantes (`build-advisor-context.ts`, `build-composer-context.ts`, `build-validator-context.ts`), que `StellaProjectContext.stakeholderCount` es literalmente `stakeholderGroups.length` — un **conteo de filas de grupo**, nunca una suma de personas.

**Consecuencia de diseño, documentada, no oculta:** ningún *context builder* de hoy puede producir una `AggregateDataDeclaration` estructuralmente válida, porque no existe ningún campo del que derivarla de forma confiable. El sistema, en la práctica, bloqueará hoy cualquier mención específica y agregada de menores/salud — comportamiento fail-closed intencional, no un error.

## 4. Modelo de clasificación implementado

`lib/stella/context/sensitive-population.ts` (nuevo). Calibrado deliberadamente para **no** dispararse con lenguaje temático normal de SROI (p. ej. un *outcome* llamado "Mejora en salud mental de jóvenes" no es sensible por sí solo). Se dispara en dos casos:

1. **Señal individual** — reutiliza `detectHighRiskPii()` de DR-001 (categorías `minorIdentifiable`/`individualHealth`), sin duplicar su lógica.
2. **Mención agregada de datos** — un número (en dígitos o en palabras, es/en) junto a un sustantivo poblacional ("50 niños", "cincuenta pacientes", "fifty patients").

`SensitivePopulationCategory = 'none' | 'minors' | 'health' | 'minors_and_health'`.

## 5. Contrato de datos agregados (`AggregateDataDeclaration`)

```typescript
interface AggregateDataDeclaration {
  sensitiveCategory: 'minors' | 'health' | 'minors_and_health'
  aggregationLevel: 'aggregate'
  groupSize: number        // entero positivo, nunca inferido de texto libre
  dimensions: string[]
  sourceEntityType: string // debe nombrar una entidad real del sistema
  sourceEntityId: string
}
```

`isValidAggregateDeclaration()` valida **forma**, no verdad semántica: entero positivo, categoría de un conjunto fijo, `sourceEntityType`/`sourceEntityId` no vacíos. Confirmar que `groupSize` corresponde realmente a `sourceEntityId` es responsabilidad de un flujo humano futuro — no implementado hoy (§8) — nunca de esta función pura. Un objeto con campos señuelo (`bypassGuardrail`, `__proto__`, etc.) no obtiene ningún privilegio: solo los campos listados se leen.

## 6. Umbral mínimo de grupo

`MINIMUM_SENSITIVE_GROUP_SIZE = 10` — única fuente de verdad, exportada como constante de módulo. Ningún llamador puede sobrescribirla: `AggregateDataDeclaration` no tiene ningún campo de umbral, y una declaración con un campo señuelo de umbral se ignora (probado explícitamente).

## 7. Modelo de riesgo de reidentificación

Taxonomía fija de cuasi-identificadores (`QUASI_IDENTIFIER_CATEGORIES`): edad exacta, fecha exacta, grado/curso, institución específica, localidad pequeña, condición de salud rara, mención de género, período de tiempo acotado, narrativa individual, rol familiar, ID interno estable. **Regla:** 2+ dimensiones co-ocurrentes bloquean el envío **independientemente** de que el tamaño de grupo declarado sea válido — regla conservadora inicial, explicable, no una resolución matemática de anonimización (documentado explícitamente, nunca presentado como garantía de cumplimiento legal).

Una narrativa/testimonio individual (comillas largas, "yo soy/tengo", "mi ...") combinada con un tema de menores/salud se prohíbe aunque no incluya una edad o diagnóstico exacto detectable.

## 8. Brecha de datos — decisión de no migrar esta sesión

Se diseñó (solo en documentación) una migración candidata sobre `indicators`: `sensitivePopulationCategory`, `aggregationGroupSize`, `aggregationConfirmedBy`, `aggregationConfirmedAt`. **No se aplicó.** Justificación: no existe hoy ningún flujo real (UI, *server action*, importador) que pudiera poblar esos campos con un tamaño de grupo verificado por un humano — construir la infraestructura antes de tener un consumidor real repetiría el patrón ya evitado en sesiones anteriores (p. ej. `ai_provenance_links`, diferido en Etapa A1). Consistente con el permiso explícito del encargo: "Si los datos actuales no permiten demostrar agregación válida: bloquea el campo para Stella. No inventes metadatos. Documenta la funcionalidad necesaria para capturarlos." Filas `STL-A23-009`/`STL-A23-010` quedan `Pending` en el backlog, marcadas `Type=Decision`, a la espera de una decisión de producto sobre si/cuándo construir ese flujo.

## 9. Integración con DR-001 (sin duplicación)

Orden implementado dentro de `assertContextHasNoForbiddenData()` (`context-guardrails.ts`): sanitización (`sanitize.ts`, sin cambios) → detección PII (`detectHighRiskPii`, DR-001) → clasificación menores/salud + evaluación de agregación + evaluación de reidentificación (este bloque, `sensitive-population.ts`) → construcción del mensaje (sin cambios). El bucle existente de alto riesgo de DR-001 se ajustó para **excluir** `minorIdentifiable`/`individualHealth` de su bloqueo genérico (ver §11) — esas dos categorías pasan a ser dominio de este bloque, que reutiliza el mismo detector internamente sin duplicar su lógica, y lanza con un código tipado distinto en vez del mensaje genérico.

## 10. Endurecimiento adversarial añadido durante la implementación

Tres refuerzos, ninguno pedido literalmente por el encargo pero necesarios para que el modelo resistiera las pruebas adversariales de la sección 17:

1. **Normalización de caracteres invisibles/control** (`normalizeForDetection`): un espacio de ancho cero u otro carácter invisible insertado entre un número y un sustantivo poblacional ya no evade el límite `\s+` de las expresiones regulares — se reemplaza por un espacio real (nunca se elimina, para no fusionar dos tokens que genuinamente estaban separados).
2. **Cotejo declarado-vs-mencionado**: si el texto nombra un conteo específico ("5 niños") y la declaración estructural afirma un `groupSize` distinto (p. ej. 50), se bloquea — sin este cotejo, una declaración válida en su forma pero inconsistente con el texto real habría podido colarse.
3. **Detección temática amplia condicionada a marcador narrativo**: permite bloquear un testimonio en primera persona sobre salud/menores aunque no contenga una edad o verbo de diagnóstico exacto, sin ampliar el detector agregado (que sigue exigiendo un número) y sin bloquear lenguaje temático normal sin narrativa.

## 11. Errores tipados y mensajes

`StellaContextGuardrailError` (`lib/stella/errors.ts`) extendido con un campo `code?: string` opcional y aditivo (ningún sitio de lanzamiento existente se rompe). Cinco códigos nuevos, única fuente de verdad en `SENSITIVE_DATA_REASON_CODES`:

| Código | Disparador | Mensaje (no filtrante) |
|---|---|---|
| `SENSITIVE_INDIVIDUAL_DATA_BLOCKED` | Señal individual (edad+contexto de menor, o verbo de diagnóstico individual) | "Stella no puede procesar información que identifique a una persona individual..." |
| `SENSITIVE_GROUP_SIZE_REQUIRED` | Mención agregada sin declaración válida/consistente | "...no existe un tamaño de grupo verificado para la población mencionada." |
| `SENSITIVE_GROUP_TOO_SMALL` | Declaración válida pero `groupSize < 10` | "...el grupo mencionado es menor al mínimo permitido (10)." |
| `SENSITIVE_REIDENTIFICATION_RISK` | 2+ cuasi-identificadores co-ocurrentes | "...la combinación de datos podría permitir identificar a una persona." |
| `SENSITIVE_FREE_TEXT_BLOCKED` | Marcador de narrativa individual sobre tema sensible | "Stella no puede procesar narrativas individuales..." |

Ninguno de los mensajes referencia el texto detectado, solo la categoría/condición fija.

## 12. Cambios en los 4 *server actions*

`advisor.ts`, `composer.ts`, `validator.ts`, `reviewer.ts`: cada uno añade los 5 códigos nuevos a su unión `StellaXErrorCode`, y en el `catch` de `StellaContextGuardrailError` comprueba `error.code in SENSITIVE_DATA_BLOCK_MESSAGES` — si coincide, registra una entrada de auditoría **sin contenido** (ver §13) y devuelve el código/mensaje específico; si no, conserva el comportamiento genérico `CONTEXT_GUARDRAIL_FAILED` sin cambios (probado explícitamente para evitar una regresión silenciosa). El bloqueo ocurre **antes** de `consumeStellaRateLimit()` y de cualquier llamada al adaptador de Gemini — la verificación de cuota, al ejecutarse antes de construir el contexto en los 4 *actions*, sí se ejecuta primero (comportamiento preexistente, sin cambios).

## 13. Auditoría de intentos bloqueados

`lib/audit/logger.ts` — nueva acción `STELLA_SENSITIVE_DATA_BLOCKED` (`stella_sensitive_data.blocked`). Cada bloqueo por población sensible escribe una fila en `audit_logs` (tabla general, vía `logAuditAction()`, ya existente) con `organizationId`, `projectId`, `actorUserId`, `action`, y `reason = <código fijo>` — **nunca** el texto que disparó el bloqueo. El fallo del registro de auditoría se captura y se ignora silenciosamente (no debe enmascarar el bloqueo original, que ya ocurrió).

## 14. Manifiesto de contexto

`build-context-manifest.ts` — nueva bandera de vocabulario fijo `sensitive_population_aggregate_present`. Como el guardarraíl lanza **antes** de que `buildContextManifest()` se ejecute para cualquier solicitud bloqueada, esta bandera solo puede aparecer para el caso PERMITIDO (agregado con tamaño de grupo verificado) — documentado explícitamente en el propio código como la razón por la que la forma de "manifiesto para el caso bloqueado" descrita originalmente no aplica literalmente: un bloqueo nunca llega a construir manifiesto.

## 15. Auditoría de los 4 *context builders*

Se revisaron `build-advisor-context.ts`, `build-composer-context.ts`, `build-validator-context.ts`, `build-reviewer-context.ts` (vía el inventario de la sección 3): ninguno expone un campo de población estructurado que pudiera evadir el guardarraíl, porque el propio guardarraíl re-escanea **todas** las cadenas de texto libre del contexto (`collectContextStrings()`, sin cambios) — un título de *outcome* como "Niña de 8 años con diagnóstico X" se bloquea igual que si apareciera en la narrativa, sin necesidad de tocar los *builders* mismos.

## 16. Pruebas unitarias del módulo

| Archivo | Casos | Resultado |
|---|---|---|
| `lib/stella/context/__tests__/sensitive-population.test.ts` | 26 | ✅ (permitidos/bloqueados, calibración temática, umbral, declaración estricta) |
| `lib/stella/context/__tests__/sensitive-population-adversarial.test.ts` | 26 | ✅ (ver §17) |
| `lib/stella/context/__tests__/context-guardrails.test.ts` (ampliada) | 22 | ✅ (orden de integración con DR-001, no regresión) |
| `lib/stella/context/__tests__/build-context-manifest.test.ts` (ampliada) | 14 | ✅ (bandera nueva, sin fuga de texto) |

## 17. Suite adversarial

Casos cubiertos en `sensitive-population-adversarial.test.ts`: afirmación de agregación en prosa sin declaración estructural; texto con forma de JSON simulando una declaración; discordancia declarado-vs-mencionado (ambos sentidos, dígitos y palabras); manipulación del umbral vía campos señuelo, `groupSize` no entero, `Infinity`/`NaN`, string numérico; campos de declaración con nombres engañosos (`bypassGuardrail`) y un payload estilo *prototype pollution*; combinación de cuasi-identificadores con declaración válida; texto tipo "ignora las reglas anteriores"; números escritos como palabras (es/en); datos sensibles ocultos en nombre de *outcome*/título de evidencia/nombre de proxy (vía `assertContextHasNoForbiddenData`); caracteres invisibles/de control insertados entre número y sustantivo (espacio de ancho cero, *joiner*, BOM); verificación de que ningún fragmento de texto sensible aparece serializado en el resultado de la evaluación.

## 18. Pruebas a nivel de *action* (por rol, 4 archivos)

Cada uno de `advisor.test.ts`, `composer.test.ts`, `validator.test.ts`, `reviewer.test.ts` recibió un bloque nuevo "Sensitive-population guardrail (Etapa A2.3, DR-002/DR-003)": bloqueo con `SENSITIVE_GROUP_SIZE_REQUIRED` sin llamar al modelo/rate-limit; auditoría sin contenido; y una prueba de no-regresión que confirma que una violación de guardarraíl NO relacionada con población sensible (valor financiero de proxy) sigue devolviendo `CONTEXT_GUARDRAIL_FAILED` genérico. `reviewer.test.ts` requirió además mockear `@/db/client` (no lo hacía antes, porque solo usaba `recordStellaInteraction` mockeado) para que la nueva llamada a `logAuditAction()` no intentara una conexión real durante las pruebas.

## 19. No regresión de DR-005/DR-007

Ejecutados explícitamente tras los cambios: `lib/stella/consent/**` (versiones, `consent-log`, `consent-status`), `lib/stella/access/**` (decisión de acceso, servicio de lectura), `tests/stella-interactions-access-anti-regression.test.ts`, `lib/stella/__tests__/anti-regression.test.ts` — **63 pruebas, 0 fallos**. Además, la suite RLS/privilegios completa de integración (`tests/integration/stella-ai-consent-rls.test.ts`, `stella-interactions-rls.test.ts`, `stella-interactions-access-rls.test.ts`, `bootstrap-invariants.test.ts`) se re-ejecutó contra el stack local, sin cambios de comportamiento.

## 20. Comandos ejecutados

`pnpm exec tsc --noEmit` (x2) · `pnpm exec eslint .` · `pnpm exec vitest run lib/stella/context/__tests__/sensitive-population.test.ts lib/stella/context/__tests__/sensitive-population-adversarial.test.ts lib/stella/context/__tests__/context-guardrails.test.ts lib/stella/context/__tests__/build-context-manifest.test.ts` · `pnpm exec vitest run app/actions/stella/__tests__/{advisor,composer,validator,reviewer}.test.ts` · `pnpm exec vitest run lib/stella/consent lib/stella/access tests/stella-interactions-access-anti-regression.test.ts lib/stella/__tests__/anti-regression.test.ts` · `pnpm exec vitest run lib/stella app/actions/stella tests/eval` · `pnpm exec vitest run --config vitest.integration.config.ts` (suite completa, y también archivo por archivo tras un primer intento fallido por invocar el config equivocado — ver §21) · `pnpm test:unit` (equivalente, `vitest run --exclude tests/integration/**`) · `npx drizzle-kit check` · validación estructural del CSV (script temporal, eliminado tras usarlo) · `npx supabase status` / `npx supabase start` (stack local, ya existente, solo se confirmó que estuviera arriba).

## 21. Resultados exactos

- `tsc --noEmit`: limpio, 0 errores.
- `eslint .`: 0 errores, **56 warnings** (línea base previa: 55 — la única adición es una desestructuración intencional `const { groupSize: _x, ...rest }` en una prueba, no un problema real).
- Suite de Stella (`lib/stella app/actions/stella tests/eval`): **34 archivos, 524 pruebas**, 0 fallos.
- `pnpm test:unit` (equivalente, todo el repo salvo integración): **105 archivos, 1447 pruebas**, 0 fallos.
- `pnpm test:integration` (equivalente, `--config vitest.integration.config.ts`): **6 archivos, 78 pruebas**, 0 fallos. *(Nota metodológica: una primera ejecución sin el config de integración produjo `ECONNREFUSED` en 6 archivos — no era una regresión real, sino invocar el runner base sin cargar `.env.test.local`; al usar el comando correcto, los 6 archivos pasaron. Una prueba aislada de `stella-interactions-rls.test.ts` falló una vez con `PGRST303 "JWT issued at future"` — sesgo de reloj transitorio del stack local recién reiniciado, no relacionado con este bloque; se repitió y pasó limpio.)*
- `drizzle-kit check`: "Everything's fine", sin drift.
- CSV: 105 filas, 18 columnas, 0 malformadas, 0 IDs duplicados, 0 dependencias colgantes, 0 inversiones de orden topológico.
- **Build:** no ejecutado — no se tocó ninguna ruta, componente ni configuración de Next.js en este bloque (solo `lib/`, `app/actions/stella/`, tests), misma condición explícita usada en DR-005/DR-007 para omitirlo.

## 22. Riesgos residuales

1. **Sin ningún productor real de `AggregateDataDeclaration` hoy.** El efecto práctico es que toda mención agregada específica de menores/salud se bloquea — comportamiento correcto y fail-closed, pero significa que este módulo hoy es una capa de bloqueo, no una vía de uso legítimo de datos agregados reales. Requiere una decisión de producto futura (migración + flujo de verificación humana) antes de que el "camino permitido" sea alcanzable en producción.
2. **Lista de sustantivos poblacionales y de números escritos como palabras deliberadamente acotada, no exhaustiva** (documentado en el propio código) — otros idiomas, sinónimos poco comunes o cifras en otras escalas numéricas podrían no dispararse. Es una limitación conocida de un clasificador basado en expresiones regulares, no una garantía de cobertura total.
3. **La regla de reidentificación (2+ dimensiones) es conservadora e inicial**, no una resolución matemática de k-anonimato — puede sobre-bloquear combinaciones benignas o, en teoría, no capturar una combinación de riesgo real fuera de la taxonomía fija. Documentado explícitamente, nunca presentado como cumplimiento legal garantizado.
4. **El cotejo declarado-vs-mencionado usa el PRIMER número que coincide con el patrón agregado** — un texto con múltiples menciones numéricas distintas de la misma población podría no cotejarse contra la más relevante. Caso de borde no crítico dado que, en la práctica, ninguna declaración real existe todavía (riesgo 1).
5. **Normalización de invisibles cubre un conjunto fijo de puntos de código** (espacios de ancho cero, BOM, controles ASCII bajos) — no cubre cada posible carácter invisible Unicode existente; es un endurecimiento razonable, no exhaustivo.

## 23. Trabajo no realizado (fuera de alcance, expresamente)

Activación de `STELLA_ENABLED`/flags por rol, llamadas reales a Gemini, evaluaciones reales, bases de datos remotas, despliegue, push, commits, seeds, variables de Vercel, edición de migraciones ya aplicadas, DR-004 (retención), modificaciones a DR-005 (consentimiento) o DR-007 (control de acceso) más allá de lo ya cerrado, Etapa A3, prompts por paso, sugerencias/reformulación, procesamiento de documentos reales, Evidence Intelligence, OCR/grounding/RAG/embeddings/pgvector, excepciones manuales en la UI a los bloqueos nuevos, aplicación de la migración candidata de la sección 8 (diseñada, no aplicada).

## 24. Estado del gate

Se cumplen los criterios centrales del encargo: inventario completo realizado antes de diseñar; el modelo de clasificación no bloquea lenguaje temático normal de SROI (probado explícitamente); ninguna afirmación de tamaño de grupo en texto libre se acepta como confiable; el umbral mínimo (10) es una única fuente de verdad no sobreescribible; el modelo de reidentificación bloquea combinaciones de cuasi-identificadores incluso con una declaración válida; se reutiliza DR-001 sin duplicar su lógica; el orden de integración coincide con el especificado; los 5 errores tipados están implementados y mapeados en los 4 *actions*, antes de cuota/rate-limit/modelo; los intentos bloqueados se auditan sin contenido sensible; el manifiesto solo añade banderas para el caso permitido, con la limitación documentada; ningún valor sensible detectado se almacena en logs/errores/manifiestos (probado explícitamente en varias suites); la brecha de datos de tamaño de grupo se documenta en vez de inventar metadatos; DR-005/DR-007 no presentan regresión; Stella permanece apagada; sin llamadas al modelo real; sin bases de datos remotas; toda prueba reportada fue efectivamente ejecutada.

**Estado: `APROBADO`.**

## 25. Próximo bloque recomendado

DR-004 (política de retención de `stella_interactions`/`context_manifest`), pendiente de una decisión de producto sobre plazos concretos (ya aprobada en principio en el bloque de DR-001, sin parámetros de retención definidos aún). **No se continúa automáticamente** — se espera autorización explícita del propietario antes de iniciar DR-004 o cualquier bloque de Etapa A3/B.

---

## Corrección (Etapa A2.3.1, 2026-07-26)

El `APROBADO` de la sección 24 es correcto **para el alcance exacto de este bloque**: el bloqueo fail-closed de datos individuales/agregados sin verificar estaba, en efecto, completamente implementado y probado. Sin embargo, `STELLA_DECISION_REGISTER.md` resumió ese resultado como "DR-002/DR-003 IMPLEMENTADA TÉCNICAMENTE" sin la salvedad de que el "camino permitido" (agregados con declaración verificada) era inalcanzable en la práctica — ningún *context builder* podía producir una `AggregateDataDeclaration` real (riesgo residual #1 de este informe). Esa formulación se corrigió a `IMPLEMENTACIÓN PARCIAL — BLOQUEO FAIL-CLOSED COMPLETADO; CAMINO DE AGREGADOS VERIFICADOS PENDIENTE`, y la brecha se cerró en la sesión siguiente (Etapa A2.3.1) — ver `STELLA_A2_AGGREGATION_DECLARATIONS_REPORT.md` para el diseño de `stella_sensitive_aggregation_declarations` y el estado final `APROBADO CON RESERVAS` (reserva: sin UI de gestión de declaraciones).

## Corrección (Etapa A2.3.2, 2026-07-26)

La reserva de Etapa A2.3.1 (sin UI de gestión de declaraciones) queda cerrada — ver `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md` para el detalle completo y el veredicto formal. Este bloque también cerró tres huecos operativos que Etapa A2.3.1 no había probado explícitamente: sustitución transaccional con rollback, comportamiento correcto bajo concurrencia real (6 escenarios contra Postgres local), y comportamiento correcto ante un cambio real de política de umbral. Ninguna de estas correcciones cambia el veredicto `APROBADO` de la sección 24 de este informe (ese veredicto sigue siendo válido para el alcance exacto del bloqueo fail-closed original) — se documentan aquí únicamente para que el lector llegue a `STELLA_A2_AGGREGATION_OPERATIONS_REPORT.md` con el contexto completo de la cadena de correcciones.

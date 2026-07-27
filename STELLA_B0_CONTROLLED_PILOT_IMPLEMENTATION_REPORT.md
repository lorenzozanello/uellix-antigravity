# Etapa B0 — Modo piloto restringido: reporte de implementación

**Fecha:** 2026-07-26 (implementación) → 2026-07-27 (autenticación real confirmada, ver §0.4). **Rama:** `feature/stella-generation-copilot`. **Gate final: APROBADO CON RESERVAS** (ver §0.4 y §19). El piloto se ejecutó de punta a punta contra el stack local real y **la autenticación con Gemini pagado quedó confirmada de forma definitiva** (REST directo, SDK directo, y una interacción real de Advisor con persistencia completa). La reserva restante es acotada: 2 de las 3 llamadas sintéticas del smoke test fallaron por un defecto demostrado y ya corregido en el propio fixture de prueba (no en código de producción) — ver §0.4 — pendiente de una re-ejecución que no se hizo en esta sesión por haber agotado el máximo de llamadas reales autorizado.

## 0. Sesión adicional de diagnóstico de la clave (2026-07-26, tercera sesión)

Una tercera sesión, motivada por la duda explícita del propietario de que "Google AI Studio no marca la clave como comprometida" (lo cual no prueba que la aplicación lea la clave correcta ni que sea válida para la API de Gemini), realizó un diagnóstico exhaustivo de qué variable resuelve realmente el código, sin imprimir ningún valor:

```text
GEMINI_API_KEY present: yes
GOOGLE_API_KEY present: no
Both present: no
Resolved source: explicit GEMINI_API_KEY — lib/stella/config.ts:7 lee
  process.env.GEMINI_API_KEY explícitamente; gemini-client.ts:50 lo pasa
  explícitamente a `new GoogleGenAI({ apiKey: ... })`. El SDK NUNCA hace
  autodetección de variables de entorno en este código — no existe ninguna
  ruta donde GOOGLE_API_KEY pudiera tener prioridad, porque esa variable ni
  siquiera se lee.
Values equivalent: not comparable (GOOGLE_API_KEY no existe)
Whitespace detected: no
Quotes detected: no
Process reload required: no — cada ejecución de scripts/pruebas es un
  proceso Node nuevo que vuelve a cargar .env.local; no hay un servidor de
  Next.js de larga duración involucrado en el preflight ni en el smoke test.
```

Verificación adicional: no existe `GEMINI_API_KEY` ni `GOOGLE_API_KEY` a nivel de shell (ni Bash ni PowerShell) que pudiera sobrescribir silenciosamente `.env.local` por el comportamiento por defecto de `dotenv` (`override: false`). La clave tiene el prefijo `AIza` y una longitud de 39 caracteres — ambos consistentes con el formato esperado de una clave de Google API, sin corrupción por espacios, comillas o caracteres de control.

**Conclusión del diagnóstico: el código lee exactamente la clave que está en `.env.local`, sin ambigüedad, sin variable en conflicto, sin caché de proceso obsoleta.** Se repitió el smoke test completo (preflight → 3 llamadas reales) una vez más en esta sesión, respetando el máximo de 3 llamadas: **resultado idéntico** — `400 API_KEY_INVALID` en las 3, exactamente igual que en la sesión anterior. No se reintentó una cuarta vez (los errores 400/403 no son transitorios). Esto descarta con alta confianza cualquier causa de código, de entorno, o de proceso — el problema reside en la clave misma o en su configuración dentro de Google Cloud/AI Studio (tipo de clave, restricciones de API, o proyecto/facturación asociado), algo que **solo el propietario puede diagnosticar** revisando en Google AI Studio si la clave tiene la API "Generative Language API" habilitada sin restricciones, y si el proyecto de Google Cloud asociado tiene facturación activa.

### 0.1 Cuarta sesión — clave rotada por el propietario, mismo rechazo (2026-07-27)

El propietario confirmó haber rotado y verificado `GEMINI_API_KEY` en `.env.local`. Se repitió el procedimiento completo: verificación de presencia/formato (sin imprimir valor — prefijo `AIza`, 39 caracteres, sin espacios/comillas/caracteres de control, idéntico a los chequeos anteriores en forma), `pnpm stella:pilot:preflight` → **PASS** en todos los controles verificables por código, y el smoke test (3 llamadas reales, máximo respetado).

**Resultado: rechazo idéntico** — `400 API_KEY_INVALID`, *"API key not valid. Please pass a valid API key."*, en las 3 llamadas, exactamente igual que en las dos sesiones anteriores (van 9 llamadas reales en total a través de 3 sesiones, todas con el mismo rechazo). No se reintentó una cuarta vez esta sesión.

Esto es un hallazgo relevante en sí mismo: si la clave fue efectivamente rotada y el rechazo persiste de forma idéntica, la causa casi con certeza **no es la clave en sí** sino una condición que se repite en cualquier clave nueva del mismo origen — por ejemplo: (a) las claves se están creando en un proyecto de Google Cloud sin la "Generative Language API" habilitada, (b) el proyecto no tiene facturación activa vinculada (una clave de AI Studio en el nivel gratuito puede *parecer* válida pero seguir rechazando llamadas si el flujo pagado específico no está correctamente configurado), o (c) existe una restricción de API/referrer/IP en la clave que excluye `generativelanguage.googleapis.com`. Ninguna de estas tres es verificable desde este código — se recomienda al propietario revisar, en el mismo proyecto de Google Cloud donde se creó la clave: la lista de APIs habilitadas, las restricciones de la clave, y el estado de facturación, en lugar de rotar la clave nuevamente sin cambiar esas condiciones.

### 0.2 Quinta verificación — Google Cloud Console confirmado correcto, mismo rechazo (2026-07-27)

El propietario confirmó revisar directamente Google Cloud Console (no solo AI Studio) y reportó que todo está correcto (API habilitada, sin restricciones bloqueantes, facturación activa — según su verificación). Se repitió preflight (PASS) y el smoke test (3 llamadas, máximo respetado). **Resultado: rechazo idéntico una cuarta vez** — `400 API_KEY_INVALID` en las 3 llamadas. Van 12 llamadas reales en total a través de 4 sesiones, siempre el mismo error exacto, incluso después de rotar la clave y de confirmar la configuración del proyecto en Cloud Console.

Dado que se agotaron las causas verificables por código (variable correcta, sin conflicto, formato válido) y las causas de configuración del proyecto reportadas como correctas por el propietario, la explicación restante más probable es una **discrepancia entre el valor que existe en Google Cloud Console y el valor que efectivamente quedó pegado en `.env.local`** — un error de copiado (clave de otro proyecto, valor truncado por la interfaz de Google al no expandir "mostrar clave completa", o un carácter perdido/agregado en el portapapeles) que este código no puede detectar por diseño, ya que nunca compara la clave contra un valor de referencia ni la imprime. Se recomienda al propietario copiar la clave nuevamente desde Cloud Console → Credenciales, usando el botón de copiar (no seleccionar y copiar manualmente el texto mostrado en pantalla, que puede estar truncado), y pegarla directamente en `.env.local` sin edición manual.

### 0.3 Sexta sesión — auditoría del cargador de entorno (2026-07-27)

El propietario planteó una hipótesis distinta: que `.env.local` contiene ahora una nueva Auth key que empieza por `AQ.`, mientras que las sesiones anteriores reportaron una clave con prefijo `AIza` — es decir, que el proceso podría no estar leyendo el mismo `GEMINI_API_KEY` que ve el propietario en el archivo. Se auditó exhaustivamente, **sin hacer ninguna llamada a Gemini**, antes de continuar:

- **`scripts/stella-pilot-preflight.ts` y `vitest.setup.smoke.ts`** cargan `.env.local` con `dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })` — una ruta explícita, NUNCA un `import 'dotenv/config'` desnudo (ese patrón sí existe en `scripts/seed-proxies.ts`, `seed-taxonomies.ts` y `clean-test-data.ts`, que por eso dependen de `db/guard.ts`). Ningún módulo importado transitivamente por estos dos puntos de entrada (`lib/stella/pilot/config.ts`, `lib/stella/config.ts`, `db/guard.ts`) hace una carga de entorno adicional.
- **`.env` (el archivo raíz, distinto de `.env.local`) no define `GEMINI_API_KEY` ni `GOOGLE_API_KEY`** — solo `DATABASE_URL`. Verificado leyendo únicamente los NOMBRES de las claves parseadas, nunca sus valores.
- **`.env.test.local`** (usado solo por `test:integration`) tampoco define `GEMINI_API_KEY`.
- **Ninguna variable `GEMINI_API_KEY`/`GOOGLE_API_KEY` existe en el proceso, a nivel de usuario de Windows, ni a nivel de máquina** (`[Environment]::GetEnvironmentVariable(..., 'Process'|'User'|'Machine')`, las tres en `False`).
- Comparación de identidad (hashes SHA-256 calculados en memoria, nunca impresos ni persistidos, script temporal borrado al terminar): proceso vs. `.env.local` → *not present* (el proceso desnudo no tiene la variable); proceso vs. `.env` → *not present*; `.env.local` vs. `.env` → *not present* (`.env` no la define). Ninguna coincidencia oculta.
- **Hallazgo central: el valor actualmente presente en `.env.local` sigue teniendo el formato `AIza...` (39 caracteres, patrón clásico de clave de API de Google), NO el formato `AQ.` que el propietario describe.** Esto no es un bug de carga de entorno — ambos scripts leen exactamente lo que hay en `.env.local`, y lo que hay en `.env.local` en este momento no es una clave `AQ.`. La actualización a la clave `AQ.` no llegó a `.env.local`, o se guardó en otro lugar (otra ruta, otro perfil de shell, un editor que no llegó a guardar el archivo).

**Diagnóstico: `ENV_LOADING_CORRECT`.** No se modificó ningún cargador de entorno porque no había nada que corregir — el mecanismo ya usa el patrón explícito y correcto (`dotenv.config({ path: '.env.local' })`) que el propio encargo recomendaba adoptar. Se añadió `tests/stella-pilot-env-loader.test.ts` (34 pruebas incluidas las de `db-guard.test.ts` ya existentes) como guarda de regresión: fija con fixtures temporales que la carga explícita funciona, que un valor ya presente en `process.env` conserva prioridad, y que ambos scripts usan el mismo patrón — para que una futura regresión (alguien reemplaza la carga explícita por un import desnudo) falle en CI. No se creó el commit `fix(stella): align pilot scripts with Next environment loading` porque no hubo ninguna corrección de código: el hallazgo es que el archivo `.env.local` no contiene el valor que el propietario cree que contiene, no un defecto del cargador.

**Nota adicional:** el formato `AQ.` no corresponde al patrón estándar de una clave de API de Google (`AIza...`). Si el propietario copió ese valor desde Google AI Studio o Cloud Console, vale la pena confirmar que se trata efectivamente de una clave de API de Gemini (Generative Language API) y no de otro tipo de credencial (por ejemplo, un identificador de cliente OAuth, un token de sesión, o una clave de un servicio distinto) antes de volver a intentar pegarla en `.env.local`.

### 0.4 Séptima sesión — autenticación confirmada mediante aislamiento por capas (2026-07-27)

El propietario reemplazó manualmente la línea `GEMINI_API_KEY` en `.env.local` por la nueva Auth key (formato `AQ.`, compatible con la Gemini API según Google). Se verificó, sin describir la credencial: presente en `.env.local` (sí), distinta del valor previamente diagnosticado (sí — ya no coincide con el formato `AIza` anterior), sin conflicto de `GOOGLE_API_KEY` (no hay ninguno). Se aisló la cadena de autenticación en 4 capas independientes, deteniéndose de inmediato ante cualquier fallo:

1. **Preflight** (`pnpm stella:pilot:preflight`): **PASS** en todos los controles verificables por código.
2. **REST directo** — una única llamada `POST .../models/gemini-2.5-flash:generateContent` con `x-goog-api-key`, sin SDK, sin Stella: **HTTP 200 — éxito.** Primera confirmación exitosa en toda la investigación de esta clave.
3. **SDK directo** — una única llamada con `new GoogleGenAI({ apiKey })` (paquete `@google/genai` instalado), mismo modelo, mismo texto sintético, sin Stella: **éxito**, con metadatos de tokens disponibles.
4. **Smoke test de Stella** (`pnpm stella:pilot:smoke`, 3 llamadas reales autorizadas): **1 de 3 exitosa** (Llamada 1). Las llamadas 2 y 3 fallaron con `AUDIT_ERROR` — un código nuevo, distinto de `GEMINI_ERROR`/`API_KEY_INVALID` — es decir, Gemini respondió correctamente a las 3, y el fallo ocurrió DESPUÉS, al persistir la interacción.

**Causa raíz demostrada (no de autenticación, no de producción):** `stella_interactions.pipeline_step` es `varchar(100)` — en producción `step` es siempre una etiqueta corta ('outcomes', 'narrative', etc.). El propio smoke test explota que `buildAdvisorContext()` no valida `step` contra una lista fija (hallazgo ya documentado en §12.5) para transmitir las 3 preguntas sintéticas completas como valor de `step`. Dos de esas tres preguntas (111 y 139 caracteres) excedían el límite de 100 caracteres de la columna, y Postgres rechazaba el `INSERT`; la Llamada 1 (98 caracteres) sí cabía y persistió sin problemas. Verificado leyendo directamente la fila persistida de la Llamada 1 (sin ninguna llamada adicional a Gemini): `stella_role=advisor`, `model_used=gemini-2.5-flash`, `tokens_used=3049`, `prompt_version` y `context_schema_version` presentes, hash de contenido del prompt presente, manifiesto de contexto presente, respuesta presente — una sola fila, sin duplicación.

**Corrección aplicada:** se acortaron los 3 textos de `tests/smoke/stella-b0-real-smoke.test.ts` a 62/62/71 caracteres (muy por debajo del límite), conservando el sentido de cada caso. No se tocó el esquema (ensanchar la columna solo para acomodar un abuso del parámetro `step` en una prueba sería la dirección equivocada) ni ningún código de producción. No se volvió a ejecutar el smoke test tras la corrección: hacerlo habría significado 3 llamadas reales adicionales, excediendo el máximo autorizado en este encargo.

**Diagnóstico: `AUTHENTICATION_WORKING`.** La cadena completa de autenticación (variable correcta → REST → SDK → una interacción real completa de Stella con persistencia y trazabilidad íntegra) está confirmada. El hallazgo de `pipeline_step` es un defecto de fixture de prueba, ya corregido, no relacionado con la autenticación ni con el código de producción.

## 1. Resumen ejecutivo

Se implementó un modo de acceso restringido a Stella ("piloto") independiente y más angosto que los controles de gobernanza ya existentes (DR-001 a DR-007). El piloto permite ejercitar el flujo completo del rol Advisor — incluida una llamada real a la API paga de Gemini — únicamente para organizaciones y usuarios explícitamente autorizados, con una confirmación operativa personal obligatoria, un interruptor de emergencia, y sin ningún camino de bypass para `super_admin`. Etapa A3 (revisión legal) queda formalmente diferida, no cancelada.

## 2. Decisión del propietario que origina esta etapa

Registrada en `STELLA_DECISION_REGISTER.md#A3-DEFERRED-UNTIL-POST-PILOT` (2026-07-26): A3 no bloquea desarrollo, evaluaciones internas, Gemini pagado, ni el piloto restringido; A3 SÍ bloquea lanzamiento comercial abierto, acceso irrestricto cross-organización, y procesamiento deliberado de datos sensibles/identificables. Nueva secuencia: B0 → B1 → B2 → B3 → B4 → B5 → A3 → implementación de A3 → lanzamiento (`STELLA_REVISED_MASTER_PLAN.md`).

## 3. Alcance de esta etapa (y lo que deliberadamente NO se hizo)

**En alcance:** configuración centralizada del piloto; allowlist de organización y de usuario; fail-closed en todo; aviso visible del piloto; confirmación operativa personal; restricciones de datos (reutilizando DR-001/002/003, nunca relajándolas); configuración explícita del proveedor pagado; pruebas con proveedor simulado; intento de una llamada real limitada (bloqueado — ver §11); métricas sin contenido; interruptor de emergencia inmediato.

**Fuera de alcance, explícitamente no implementado:** el resto de Etapa B1 (copiloto contextual completo por pasos); Composer con Gemini real (Etapa B2/B3); habilitación global de Stella; habilitación de los seis roles; *grounding*, búsqueda de Google, Maps, File API o *caching* de contexto explícito; procesamiento de documentos reales; cualquier dato personal identificable real.

## 4. Modelo de configuración central del piloto

`lib/stella/pilot/config.ts` — `getStellaPilotConfig(env)`:

| Variable | Efecto | Default seguro |
|---|---|---|
| `STELLA_PILOT_MODE` | habilita el piloto (coincidencia exacta `'true'`) | deshabilitado |
| `STELLA_PILOT_KILL_SWITCH` | bloquea todo el piloto de inmediato | apagado |
| `STELLA_PILOT_PROVIDER_MODE` | `'disabled'` / `'mock'` / `'paid_gemini'` | `'disabled'` |
| `STELLA_PILOT_ORGANIZATION_IDS` | allowlist de organizaciones (UUIDs, csv) | vacía = nadie |
| `STELLA_PILOT_USER_IDS` | allowlist de usuarios (UUIDs, csv) | vacía = nadie |
| `STELLA_PILOT_ALLOW_ALL_ORG_USERS` | abre a todos los usuarios de una org permitida | apagado |
| `STELLA_PILOT_PAID_GEMINI_CONFIRMED` | confirmación externa del nivel pagado | falso |
| `STELLA_PILOT_NOTICE_VERSION` | versión del aviso mostrado | `'v1'` |
| `STELLA_PILOT_ENABLED_ROLES` | roles de Stella alcanzables por el piloto | solo `advisor` |

Todo valor no reconocido se descarta con `console.warn`, nunca lanza una excepción ni asume "permitir por defecto". El parámetro `env` usa un tipo `EnvLike = Record<string, string | undefined>` (no `NodeJS.ProcessEnv`) — mismo patrón ya probado en `db/guard.ts`, necesario porque Next.js aumenta ese tipo con `NODE_ENV` obligatorio, lo que habría forzado a cada prueba a construir un entorno completo solo para verificar una variable.

`PILOT_MEMBERSHIP_ROLE_ALLOWLIST = {organization_admin, impact_manager, analyst}` — comparación literal, sin jerarquía; `super_admin` queda deliberadamente fuera.

## 5. Confirmación operativa personal (distinta del consentimiento DR-005)

Tabla nueva `stella_pilot_confirmations` (migración `0048_stella_pilot_confirmations.sql`), append-only, por usuario+organización, `eventType` en `{'accepted','revoked'}`, `supersedesEventId` encadenado. Servicio `lib/stella/pilot/confirmation-service.ts` (`getStellaPilotConfirmationStatus` resuelve `valid`/`missing`/`revoked`/`outdated` por el evento más reciente; fail-closed a `missing` ante cualquier error). Server actions en `app/actions/stella/pilot-confirmation.ts` — **sin restricción de rol**, a diferencia de `acceptStellaConsent()` (exclusivo de `organization_admin`): cualquier miembro elegible confirma para sí mismo. La versión del aviso y el `organizationId`/`userId` se resuelven siempre en el servidor desde la sesión, nunca del cliente.

## 6. RLS de `stella_pilot_confirmations` — divergencia deliberada de DR-005

`db/policies/013_stella_pilot_confirmations_rls.sql`: `SELECT` para `authenticated`, aislado por organización (`organization_id = ANY(private.current_user_org_ids())`), **sin** la cláusula `OR private.current_user_is_super_admin()` presente en la política equivalente de `stella_ai_consent_events` (`009_stella_ai_consent_rls.sql`). Es intencional: el encargo de B0 prohíbe cualquier bypass de `super_admin`, incluida la lectura de confirmaciones de organizaciones ajenas. Sin política de `INSERT`/`UPDATE`/`DELETE` — denegado por RLS y, además, sin ese `GRANT` para `authenticated` desde la creación de la tabla (dos capas independientes, verificado con `has_table_privilege`).

## 7. Función central de decisión `getStellaPilotAccess()`

Única fuente de verdad (`lib/stella/pilot/access.ts`), 13 pasos evaluados en orden estricto, cortocircuito en el primer rechazo:

1. Interruptor de emergencia. 2. Piloto habilitado. 3. Stella habilitado globalmente. 4. Allowlist de organización. 5. Allowlist/opt-in de usuario. 6. Membresía activa. 7. Rol de piloto permitido. 8. Consentimiento DR-005. 9. DR-007 (no re-verificado aquí — ver nota inline en el código: cada rol de la allowlist del piloto ya es subconjunto de los roles de lectura de DR-007, así que duplicarlo sería redundante, no una brecha). 10. Confirmación operativa del piloto. 11. Rol específico habilitado (allowlist del piloto Y flag legado por rol). 12. Proveedor listo. 13. Cuota/límite de tasa — **deliberadamente no evaluados aquí**, responsabilidad exclusiva del llamador, solo después de `PILOT_ALLOWED`.

## 8. Códigos de decisión — refinados a granularidad completa

Se separaron los códigos colapsados de una versión anterior de este mismo trabajo para que cada causa de bloqueo tenga su propio remedio:

`PILOT_DISABLED · PILOT_KILL_SWITCH_ACTIVE · PILOT_ORGANIZATION_NOT_ALLOWED · PILOT_USER_NOT_ALLOWED · PILOT_MEMBERSHIP_INACTIVE · PILOT_ROLE_NOT_ALLOWED · PILOT_CONFIRMATION_REQUIRED · PILOT_CONFIRMATION_OUTDATED · PILOT_CONSENT_REQUIRED · PILOT_PAID_PROVIDER_NOT_CONFIRMED · PILOT_PROVIDER_NOT_READY · PILOT_ALLOWED`

Cada uno tiene un mensaje fijo, no filtrante (nunca un ID de organización, un nombre de variable de entorno, ni el tamaño de una allowlist), y se mapea 1:1 a un `StellaAdvisorErrorCode` en `app/actions/stella/advisor.ts` vía `PILOT_DECISION_ERROR_CODE`.

## 9. Proveedor simulado del piloto y sus escenarios de fallo

`lib/stella/pilot/mock-provider.ts` — `StellaPilotMockProvider implements StellaMockProvider` (misma interfaz que `getGeminiAdapter({ mockProvider })` ya acepta). Escenario `'success'` (default, el único usado en producción): respuesta fija `[RESPUESTA SINTÉTICA DE PILOTO]`, `modelUsed='stella-pilot-mock'`, `tokensUsed=0`. Escenarios adicionales para pruebas: `'timeout'`/`'cancelled'` → `StellaTimeoutError`; `'provider_error'`/`'token_overflow'` → `StellaGeminiError` (sin clase dedicada de sobrecarga de tokens, documentado); `'invalid_response'` → JSON válido que no satisface `AdvisorOutputSchema`, probando que `adapter.parseResponse()` falla cerrado a `StellaParseError`. Todos reutilizan las clases de error que `advisor.ts` ya maneja — ninguna rama nueva de manejo de errores fue necesaria.

## 10. Integración del gate en `advisor.ts`

Orden verificado: auth → resolución de organización/membresía → **gate del piloto** → consentimiento DR-005 (código preexistente, sin tocar; el solapamiento con el paso 8 de `getStellaPilotAccess()` se acepta como una lectura extra inofensiva) → cuota → construcción de contexto → **guardarraíl de datos sensibles** (independiente del resultado del gate del piloto) → límite de tasa → prompts → selección de adaptador (`mock` si `providerMode==='mock'`, real en cualquier otro caso permitido) → llamada → parseo → auditoría. Un rechazo del piloto retorna antes de consumir cuota o límite de tasa, y antes de que el proveedor (real o simulado) sea siquiera seleccionado.

## 11. Distinción: verificable por código vs. requiere confirmación externa

**Verificable por código** (y verificado en esta sesión, ver §17): modo de proveedor configurado, presencia de `GEMINI_API_KEY`, ausencia de *grounding*/*tools*/File API/*caching*, valor exacto de `STELLA_PILOT_PAID_GEMINI_CONFIRMED`. **NO verificable por código, requiere confirmación explícita del propietario fuera de este repositorio:** que la facturación paga esté realmente activa, que exista una cuenta de facturación válida, y los términos contractuales del nivel pagado. El script `scripts/stella-pilot-preflight.ts` distingue ambas categorías explícitamente en su salida (`NOT VERIFIED` para la segunda).

## 12. Cierre con smoke test real (sesión del 2026-07-26, continuación)

Esta sección documenta una segunda sesión, posterior a la primera entrega de B0, en la que el propietario confirmó explícitamente: *"La integración utiliza exclusivamente Gemini API en modalidad pagada"* — usada únicamente como señal para habilitar el gate local, nunca como verificación contractual, legal o de facturación. Objetivo: cerrar las reservas pendientes con un smoke test real acotado (máximo 3 llamadas).

### 12.1 Reconocimiento previo

Verificado antes de tocar nada: rama `feature/stella-generation-copilot`, sin commits (`HEAD` = `4c8a8ed`); stack local con 43 tablas y última migración `0048_stella_pilot_confirmations`; `STELLA_ENABLED=true`, `STELLA_ADVISOR_ENABLED=true` ya presentes; `GEMINI_API_KEY` presente (solo se verificó su existencia, nunca su valor); todos los `STELLA_PILOT_*` ausentes (piloto apagado, coincide con el cierre de la sesión anterior).

**Hallazgo no relacionado con B0 encontrado en este reconocimiento:** `STELLA_VALIDATOR_ENABLED` y `STELLA_COMPOSER_ENABLED` estaban en `true` en `.env.local` desde una sesión anterior. Como esos roles no tienen el gate del piloto integrado (solo Advisor lo tiene), de haber quedado en `true` habrían podido llamar a Gemini real sin pasar por ninguna allowlist mientras la API key estuviera activa. Se corrigieron a `false` para la duración del piloto (STL-B0-030).

### 12.2 Configuración local y organización/usuario sintéticos

Se creó un fixture 100% sintético con IDs fijos y deterministas (no secretos, solo identificadores locales): organización *"Fundación Horizonte Piloto (SINTÉTICO — B0)"* (`stellaMonthlyQuota=10`), usuario `organization_admin` sintético, proyecto *"Programa de fortalecimiento comunitario (SINTÉTICO)"* con una narrativa, un grupo de stakeholders (*"Organizaciones comunitarias participantes"*) y un outcome (*"Fortalecimiento de la capacidad organizacional"*) — todo texto organizacional, sin personas, sin PII, sin menores, sin salud. `.env.local` se configuró con `STELLA_PILOT_MODE=true`, `STELLA_PILOT_PROVIDER_MODE=paid_gemini`, `STELLA_PILOT_PAID_GEMINI_CONFIRMED=true`, allowlists apuntando exclusivamente a ese org/usuario, `STELLA_PILOT_ENABLED_ROLES=advisor`.

### 12.3 Preflight, pruebas previas, y el smoke test

`pnpm stella:pilot:preflight`: **PASS** en todos los controles verificables por código; el control de facturación quedó marcado `NOT VERIFIED` por diseño, con la confirmación del propietario anotada aparte (no como "verificado por código"). Antes de cualquier llamada real se re-ejecutaron 177 pruebas unitarias del piloto, 23 pruebas de integración (RLS + bootstrap) y el typecheck — todo en verde.

Se construyó `tests/smoke/stella-b0-real-smoke.test.ts` (`pnpm stella:pilot:smoke`, gateado por `STELLA_SMOKE_TEST_REAL==='true'`, mismo patrón que `STELLA_EVAL_REAL_MODEL`). Llama a `getStellaAdvisor()` **sin modificarlo**: la única pieza sustituida es `requireOrganizationAccess()` (inevitable fuera de una petición real de Next.js con cookies de navegador), reemplazada por el contexto sintético descrito en §12.2. Cada gate real (piloto, DR-005, confirmación, guardarraíles, cuota, límite de tasa, adaptador real, parseo, auditoría) se ejecutó sin reimplementar nada.

Las 3 llamadas usaron el propio parámetro `step` de Advisor (que no valida contra una lista fija — ver hallazgo en §12.5) para transmitir las 3 preguntas sintéticas del encargo textualmente, sin inventar ningún parámetro nuevo.

**Resultado: las 3 llamadas alcanzaron realmente a Gemini y Gemini las rechazó** — `400 API_KEY_INVALID`, *"API key not valid. Please pass a valid API key."* Verificado de forma reproducible 3 veces (9 llamadas reales en total, mientras se corregía un problema de idempotencia del fixture — nunca se reintentó la MISMA llamada dentro de una sola ejecución; cada ejecución respetó el máximo de 3). La clave nunca se imprimió, ni se reemplazó, ni se inventó una nueva — el error de Google en sí tampoco contiene la clave.

Se probó además el interruptor de emergencia contra el pipeline real (no contra mocks aislados): con `STELLA_PILOT_KILL_SWITCH=true` (y `providerMode=mock` como cinturón y tirantes), la solicitud se bloqueó de inmediato con `PILOT_KILL_SWITCH_ACTIVE`, sin tocar el proveedor y sin alterar el conteo de cuota de la organización sintética.

### 12.4 Naturaleza del bloqueo

`API_KEY_INVALID` es un rechazo de Google, no un error de configuración de este código: el adaptador ya construye la petición exactamente como se documentó en §11 (sin *grounding*, sin *tools*, sin File API, sin *caching*), y el error se propaga tal cual a través de `StellaGeminiError`, redactando la clave en los logs (`buildGeminiErrorLog`). La causa más probable, coherente con un incidente ya documentado en la memoria de este proyecto (rotación previa de clave de Gemini), es que la clave en `.env.local` está revocada, expirada, o nunca tuvo el nivel pagado activado en la consola de Google — algo que solo el propietario puede diagnosticar y corregir fuera de este repositorio.

### 12.5 Hallazgo adicional (P2, no bloqueante): `step` de Advisor sin lista de valores permitidos

`buildAdvisorContext()` acepta cualquier string como `step` (a diferencia de `buildValidatorContext()`, que sí valida contra un conjunto fijo y lanza `UNSUPPORTED_STEP`). Esto permitió usar el parámetro para transmitir las 3 preguntas del smoke test sin ningún cambio de código, pero también significa que ya existía, desde antes de esta etapa, que cualquier usuario autenticado puede invocar Advisor con un `step` arbitrario. No es una fuga de datos (el contexto sigue validado por organización), pero es una decisión de diseño pendiente de revisar en B1 — documentada aquí como hallazgo, no corregida en esta sesión por exceder su alcance.

## 13. UI del piloto

`components/stella/StellaAdvisorPanel.tsx` extendido con props opcionales (`pilotActive`, `pilotNoticeVersion`, `pilotConfirmationStatus`), todas con default `false`/`undefined` — los 36 tests preexistentes del panel siguen pasando sin cambios. Insignia "Piloto", aviso operativo con el texto exacto reproducido en `STELLA_PILOT_PARTICIPANT_NOTICE_DRAFT.md`, botón de confirmación cuando `needsPilotConfirmation` es verdadero, mensajes específicos (no genéricos) para cada código `PILOT_*`. `StellaAdvisorPanelWrapper.tsx` (servidor) resuelve el estado y lo pasa como props; desplegado en las 7 páginas del pipeline sin tocar `StellaValidatorPanel`/`StellaReviewerPanel`.

## 14. Retención, DR-007 y métricas — sin mecanismo nuevo

La política de retención de DR-004 aplica sin cambios a cualquier interacción generada durante el piloto (misma tabla `stella_interactions`, mismo motor de purga). El acceso de lectura sigue gobernado por DR-007 sin una ruta nueva. Las métricas del piloto se derivan de `stella_interactions`/`audit_logs` ya existentes — no se creó ninguna tabla de métricas con contenido duplicado.

## 15. Prueba explícita: la confirmación del piloto nunca sortea los guardarraíles de datos

`app/actions/stella/__tests__/advisor.test.ts` — caso dedicado: con `PILOT_ALLOWED` y consentimiento DR-005 válido, un contexto con un menor identificable sigue bloqueado con `SENSITIVE_INDIVIDUAL_DATA_BLOCKED`, sin llamar al proveedor ni consumir el límite de tasa. Esto prueba en código, no solo por diseño, que la atestación personal del piloto no es una excepción a DR-001/002/003.

## 16. Arnés de evaluación — pase mock-only antes de cualquier llamada real

`tests/eval/pilot-mock-eval.test.ts`: ejecuta el arnés existente (`engine.ts`/`rubric.ts`, sin modificar) contra el `StellaPilotMockProvider` REAL, no un doble de prueba genérico, limitado a los casos de rol `advisor` (único rol habilitado en B0). Resultado: 100% de aprobación en las categorías golden/negative/adversarial de ese subconjunto; la respuesta fija demostró ser inmune a los prompts adversariales por construcción (nunca refleja contenido del prompt).

## 17. Resultados exactos de la suite de validación (cierre, sesión del smoke test real)

- **Typecheck** (`npx tsc --noEmit`): 0 errores.
- **Suite unitaria** (`pnpm test:unit`, excluye `tests/integration/**`): **archivos: 123 aprobados + 1 omitido (124 total) — pruebas: 1789 aprobadas + 6 omitidas (1795 total) — pruebas fallidas: 0**. El archivo omitido es `tests/smoke/stella-b0-real-smoke.test.ts`, gateado por `STELLA_SMOKE_TEST_REAL` (ausente en una corrida normal de `test:unit`) — comportamiento esperado, no un fallo.
- **Suite de integración** (`pnpm test:integration`): **archivos ejecutados: 12 — pruebas ejecutadas: 144 — pruebas aprobadas: 144 — pruebas fallidas: 0** (incluye `stella-pilot-confirmations-rls.test.ts` 12/12 y `bootstrap-invariants.test.ts` 11/11 contra el stack local real de Supabase; la falla transitoria de reloj JWT observada en una corrida anterior de `stella-ai-consent-rls.test.ts` no se repitió en esta ejecución final).
- **ESLint** (`npx eslint .`): **0 errores**, 65 advertencias, ninguna en archivos de esta etapa (el smoke test terminó con 0 advertencias tras eliminar un import no usado detectado por el propio lint).
- **`drizzle-kit check`**: `Everything's fine`.
- **Build aislado** (`next build`): exitoso, incluidas las 7 páginas del pipeline con el wrapper del piloto.
- **`git diff --check`**: sin marcadores de conflicto ni errores de espacio en blanco (solo avisos informativos de fin de línea LF/CRLF, propios de Windows).
- **CSV** (`STELLA_REVISED_BACKLOG.csv`): 221 filas de datos, 18 columnas, 0 filas con conteo de columnas incorrecto, 0 IDs duplicados.
- **Smoke test real** (`pnpm stella:pilot:smoke`, `STELLA_SMOKE_TEST_REAL=true`): 6 pruebas — consentimiento DR-005 (verde), confirmación operativa del piloto (verde), interruptor de emergencia (verde), 3 llamadas reales a Gemini (rojas — `GEMINI_ERROR`/`API_KEY_INVALID`, ver §12.3-12.4). Fallo esperado y correctamente documentado, no una regresión.

## 18. Divergencias y decisiones de diseño documentadas (no defectos)

- `super_admin` sin acceso de lectura a `stella_pilot_confirmations` de organizaciones ajenas, a diferencia de DR-005 — intencional, ver §6 y `STELLA_THREAT_MODEL.md#E4`.
- El consentimiento DR-005 se revalida dentro de `getStellaPilotAccess()` Y en el código preexistente de `advisor.ts` — solapamiento aceptado para no arriesgar una refactorización de código ya probado.
- `token_overflow`/`cancelled` en el proveedor simulado no tienen clases de error dedicadas — se documentan como equivalentes a `StellaGeminiError`/`StellaTimeoutError` respectivamente, ya que no existe tal infraestructura en el adaptador real.

## 19. Gate final — APROBADO CON RESERVAS

La autenticación con Gemini pagado quedó **confirmada de forma definitiva** en §0.4 (REST directo, SDK directo, y una interacción real completa de Advisor con persistencia y trazabilidad íntegras). El gate se mantiene en reservas, no por la autenticación, sino por:

**Reservas:**
1. **UI no verificada visualmente en navegador** en esta sesión (misma reserva heredada de A2.3.2/A2.4).
2. **El smoke test no se re-ejecutó tras corregir el defecto de longitud de `pipeline_step`** (§0.4) — la corrección (acortar los 3 textos sintéticos a ≤100 caracteres) está aplicada y con typecheck limpio, pero confirmarla con una nueva ejecución de `pnpm stella:pilot:smoke` habría requerido 3 llamadas reales adicionales, excediendo el máximo autorizado en la sesión de cierre. Se recomienda una única re-ejecución de confirmación antes de declarar B0 plenamente `APROBADO`.
3. **Hallazgo no bloqueante**: `Advisor` no valida su parámetro `step` contra una lista fija (a diferencia de `Validator`) — documentado como decisión de diseño pendiente de revisar en B1 (§12.5). Es precisamente lo que permitió transmitir las preguntas sintéticas del smoke test, y también la causa indirecta del hallazgo de longitud en §0.4.

Ninguna reserva es un defecto de autenticación ni de la infraestructura del piloto — ambas están probadas end-to-end contra Gemini real.

**Estado seguro de cierre:** `.env.local` quedó con `STELLA_PILOT_MODE=false` (dejarlo activo restringiría el Advisor de TODAS las organizaciones locales a la única organización sintética de este smoke test); el resto de la configuración del piloto permanece documentada para reactivarla con `pnpm stella:pilot:smoke`. `STELLA_VALIDATOR_ENABLED`/`STELLA_COMPOSER_ENABLED` quedaron en `false`. El fixture sintético (organización, usuario, proyecto) permanece en el stack local, claramente etiquetado. Ningún script temporal de diagnóstico quedó en el repositorio.

## 20. Próximo bloque

**Etapa B1 — Copiloto metodológico contextual por pasos.** No se avanza automáticamente: se recomienda una única re-ejecución de `pnpm stella:pilot:smoke` (ahora con los textos corregidos) para confirmar 3/3 llamadas exitosas y declarar B0 `APROBADO` sin reservas, y luego decidir explícitamente si se sube la rama y se abre un PR de revisión antes de iniciar B1.

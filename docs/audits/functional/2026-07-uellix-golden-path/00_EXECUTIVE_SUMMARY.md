# Auditoría funcional Uellix — Golden Path

## Estado: NO INICIADA — bloqueada en el paso 1 (Login)

Fecha de intento: 2026-07-16
Rama: `fix/p1a-security-validation` @ `b97c8f0`
Auditor: Claude Code (autónomo)

Este documento registra por qué la auditoría **no llegó a ejecutarse**. No contiene
resultados funcionales, porque no se ejecutó ni un solo paso del recorrido sobre la
aplicación. Los archivos `02`–`05`, `07`–`12` y `audit-result.json` no se generaron
deliberadamente: emitirlos sin haber operado la plataforma produciría un informe de
auditoría sin auditoría.

## Bloqueo 1 — No hay sesión autenticada disponible (impide pasos 1–27)

El prompt asume una sesión de Chrome autenticada como `lorenzo@thebalancecorp.org`.
Verificado empíricamente:

| Comprobación | Resultado |
|---|---|
| Navegadores Chrome conectados (extensión) | `[]` — ninguno |
| Navegador interno → `https://www.uellix.com/login` | Alcanzable, HTTP 200, `document.cookie` vacío → **sin sesión** |
| Método de login | Email + contraseña (formulario, no magic link) |
| Deployment Preview (`...ib82wth9t...`) | HTTP 302 → `vercel.com/sso-api` — **protegido por Vercel SSO** |
| `UELLIX_AUDIT_EMAIL` / `UELLIX_AUDIT_PASSWORD` | No definidas en el entorno |

Sin sesión, el único camino sería introducir una contraseña en el formulario de login.
El agente no realiza esa acción bajo ninguna autorización previa. El fallback por
variables de entorno tampoco existe, porque no están definidas.

Nota: el Preview añade una **segunda** barrera (Vercel SSO) además del login de Uellix,
por lo que "usar Preview preferentemente" requiere resolver dos autenticaciones.

Corrección de un supuesto previo: la memoria del proyecto indicaba que el navegador MCP
no podía navegar a URLs externas y caía silenciosamente a `localhost:3000`. **Ya no es
cierto** — `mcp__Claude_Browser__` alcanzó `www.uellix.com` correctamente. La limitación
real hoy es la ausencia de sesión, no la de navegación.

## Bloqueo 2 — RESUELTO por decisión (2026-07-16)

El dataset está incompleto (ver abajo). Decisión de Lorenzo: **auditar con los Outcomes 2,
3 y 4 valuables**, cargando el Outcome 1 sin proxy. El rango de control 2,7:1–3,2:1 queda
**declarado no aplicable** y se sustituye por el control independiente **1,051:1 (r=3,5%)**.
Detalle y criterios en `06_SROI_CALCULATION_VALIDATION.md`.

## Bloqueo 2 (detalle) — El dataset de prueba está incompleto

**El Outcome 1 no tiene proxy value.** El prompt especifica cantidad (120 hogares,
3,3 h/semana ahorradas), duración y los cuatro filtros, pero **no asigna un valor
monetario a la hora ahorrada**. Sin ese dato el outcome no puede valorarse.

Su impacto no es marginal, es dominante. Con el modelo de control independiente
(ver `06_SROI_CALCULATION_VALIDATION.md`), excluyendo el Outcome 1:

| Escenario | SROI |
|---|---|
| Sólo Outcomes 2+3+4, r=0% | **1,079:1** |
| Sólo Outcomes 2+3+4, r=3,5% | **1,051:1** |

El rango de control esperado por el prompt es **2,7:1 – 3,2:1**. El Outcome 1 tendría que
aportar por sí solo ~2/3 del valor social neto para alcanzarlo. El proxy por hora
necesario sería de **~9.400–12.800 COP/hora** según la tasa de descuento.

Ese valor **no se ha inventado ni aplicado**: el prompt instruye "usa únicamente los datos
sintéticos establecidos" y "no fuerces el resultado para que coincida". Elegir un proxy
para aterrizar dentro del rango sería exactamente eso. Se requiere decisión humana.

**Tercer dato ausente:** el prompt no especifica **tasa de descuento**. El esquema
(`db/schema.ts:115`) permite `discount_rate_pct` nulo sin default, así que el valor a usar
es una decisión de la corrida, no un dato derivable.

**Ambigüedad adicional (Outcome 3):** "línea base 32%, resultado 78%" sobre 480 personas
admite al menos dos lecturas — cantidad = 480 × 0,46 = 220,8 personas (la usada), o
cantidad = 480 con el cambio reflejado en el proxy. Cambia el resultado y debe fijarse.

## Lo único que sí se produjo

- `06_SROI_CALCULATION_VALIDATION.md` — modelo de control independiente, ejecutable.
- `independent_sroi.mjs` — script del modelo, reproducible con `node independent_sroi.mjs`.

Ambos son válidos por sí mismos y se reutilizarán sin cambios cuando la auditoría se
desbloquee: sólo les falta la columna "valor observado en Uellix".

## Limitaciones declaradas

Independientemente del desbloqueo, la corrida prevista usa **una sola cuenta** y por tanto
**no valida aislamiento multirol ni colaboración entre usuarios**. Tampoco valida
aislamiento multi-tenant (RLS entre organizaciones), que requiere al menos dos cuentas en
organizaciones distintas.

## Recomendación

**NO-GO para emitir dictamen.** No hay evidencia funcional sobre la que fundamentar una
recomendación GO / GO CON CONDICIONES / NO-GO. Cualquier porcentaje de completitud
funcional, scorecard por módulo o evaluación de Stella que se emitiera hoy sería
fabricado. Se requiere resolver los bloqueos 1 y 2 y relanzar.

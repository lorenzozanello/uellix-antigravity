# Auditoría técnica — Estado actual de Uellix

**Fecha:** 2026-07-24
**Rama auditada:** `codex/beta-stabilization` (HEAD `fbe2afe`)
**Alcance:** auditoría completa de código, arquitectura, base de datos, seguridad, UX, pruebas y preparación comercial SaaS.
**Método:** lectura del 100 % del código de aplicación, ejecución real de la cadena de verificación, levantamiento de un stack Supabase **local** y recorrido funcional extremo a extremo con un usuario simulado.

> **Regla de esta auditoría:** ninguna afirmación de estado se sostiene sólo porque exista código. Cada conclusión relevante lleva evidencia: ruta de archivo, línea, comando ejecutado, salida obtenida o consulta SQL.

---

## 1. Resumen ejecutivo

Uellix es una plataforma SaaS B2B de inteligencia de impacto social (SROI) construida sobre Next.js 16 (App Router), TypeScript, Supabase/PostgreSQL, Drizzle ORM y Vercel. Su propuesta de valor es convertir el impacto social en **evidencia defendible y trazable para auditoría**.

**Veredicto general: el motor está bien construido; el producto alrededor del motor no está terminado.**

El núcleo metodológico —el pipeline SROI de 8 pasos, el motor de cálculo determinista con `decimal.js`, la normalización FX a USD, las corridas inmutables con snapshot, y el aislamiento multi-tenant— es de calidad claramente superior a la media y está **verificado funcionando**. Durante esta auditoría se ejecutó un recorrido completo desde el login hasta un reporte público verificable, y el resultado del cálculo fue **reproducido a mano con precisión exacta**.

Sin embargo:

- **El primer minuto de uso está roto.** Completar el onboarding de organización termina en una página **404**. Verificado en vivo.
- **Un miembro no administrador de una organización sin onboarding queda atrapado sin salida.** Verificado en vivo.
- **No existe ningún camino para que una organización se convierta en cliente pagador.** No hay creación de sesión de checkout en ninguna parte del código; la única función de facturación lanza `"contact sales"`.
- **Un reporte puede bloquearse y publicarse en internet con sus 12 secciones vacías**, rotulado como «Reporte Audit-Ready Verificado».
- **No hay forma de descargar ni previsualizar un archivo de evidencia** desde la interfaz, lo que rompe el ciclo evidencia → revisión → aprobación que es el corazón de la propuesta de valor.
- **`pnpm audit --prod` reporta 10 vulnerabilidades (5 altas)**, incluida una de bypass de middleware/proxy en el App Router de Next.js — precisamente la capa donde vive toda la autorización de Uellix.
- **Varios scripts y las pruebas de integración apuntan a la base de datos de producción por defecto**, sin ninguna guarda de host.

**Avance ponderado global: 70 %.** Detalle y justificación en `MATRIZ_AVANCE_SAAS.md`.

---

## 2. Arquitectura real (verificada, no documentada)

### 2.1 Stack efectivo

| Capa | Tecnología | Evidencia |
|---|---|---|
| Framework | Next.js **16.2.9** (App Router, Turbopack) | `package.json:42`, salida de `pnpm build` |
| Lenguaje | TypeScript 5 (`strict`) | `tsconfig.json`, `pnpm typecheck` exit 0 |
| UI | Tailwind CSS 4 + shadcn/ui sobre `@base-ui/react` | `components/ui/*`, `components.json` |
| Base de datos | PostgreSQL vía Supabase | `db/client.ts` |
| ORM | Drizzle ORM 0.45 sobre `postgres.js` | `db/client.ts:1-9` |
| Auth | Supabase Auth (SSR, cookies) | `lib/supabase/server.ts`, `proxy.ts` |
| IA | Google Gemini (`@google/genai`) — "Stella" | `lib/stella/adapter/gemini-client.ts` |
| Pagos | Stripe (**no conectado end-to-end**) | `lib/stripe/client.ts`, ver §7 |
| Email | Resend | `lib/email/resend-client.ts` |
| Rate limit | Upstash Redis (opcional) + en memoria | `proxy.ts:14-43`, `lib/security/rate-limit.ts` |
| Observabilidad | Sentry (`@sentry/nextjs` 10.66) | `instrumentation.ts`, `sentry.server.config.ts` |
| Testing | Vitest 4 + Testing Library | `vitest.config.ts` |
| Deploy | Vercel | `.vercel/`, `.github/workflows/ci.yml` |

**Monolito único.** No hay workspaces reales pese a existir `pnpm-workspace.yaml`. 61 rutas en el build de producción.

### 2.2 Decisión arquitectónica central — y su consecuencia

`db/client.ts` construye el cliente Drizzle con `process.env.DATABASE_URL`, que es la cadena de conexión directa de Postgres (rol propietario):

```ts
// db/client.ts:5-9
const connectionString = process.env.DATABASE_URL!
const client = postgres(connectionString, { prepare: false })
export const db = drizzle(client, { schema })
```

**Implicación crítica:** todo el tráfico de la aplicación **omite RLS**. Las políticas RLS (`db/migrations/0031`, `0032`, `db/policies/*`) sólo protegen el acceso directo vía PostgREST con las claves `anon`/`authenticated`.

Esto **no es un defecto en sí** —es un patrón legítimo y consciente— pero significa que **el 100 % del aislamiento entre organizaciones descansa en comprobaciones escritas a mano** en la capa de servicios (`lib/pipeline/*`, `lib/projects/*`, etc.). En la práctica esas comprobaciones existen y son consistentes (§4.2), pero es una superficie que debe protegerse con pruebas, no con confianza.

Esta decisión **no está documentada en ningún README ni en `docs/05_TECH_ARCHITECTURE.md`**, y el README sigue presentando RLS como el mecanismo de protección principal (`README.md:135-151`).

### 2.3 Modelo de capas real

```
proxy.ts  ──────────────────────► sólo autenticación + headers de seguridad + rate limit /api/
   │                               (proxy.ts:9-46, lib/supabase/proxy.ts:66-89)
   ▼
app/**/page.tsx (Server Components)
   │   requireOrganizationAccess() / requireAdminAccess()
   ▼
app/**/*.action.ts ('use server')  ──► delgados, delegan sin validar permisos
   │
   ▼
lib/**/service.ts  ◄── AQUÍ vive la autorización real
   │   authorize(projectId) → requireOrganizationAccess() + verificación de propiedad + hasRole()
   ▼
db/client.ts (Drizzle, rol propietario, RLS omitido)
```

**Observación:** las acciones de servidor son intencionalmente delgadas. `grep` sobre los 40 archivos `*.action.ts` muestra que la mayoría **no contiene guardas de autorización**; delegan en el servicio. Esto es correcto y consistente, pero frágil: cualquier acción futura que llame directamente a `db` sin pasar por un servicio queda sin protección, y no existe ningún lint ni test que lo impida.

### 2.4 Divergencias entre arquitectura documentada y real

| Documentado | Real | Evidencia |
|---|---|---|
| `README.md` describe Sprint 1/2 con "Portafolios y proyectos SROI" como *pendientes* | 41 migraciones, pipeline completo, reportes, Stella, Stripe, portafolios | `db/migrations/meta/_journal.json` (41 entradas) |
| README: aplicar RLS manualmente con `db/policies/001_initial_auth_rls.sql` | Ese archivo **degrada** la seguridad si se ejecuta después de las migraciones (§8, SEC-02) | Demostrado en vivo |
| README: "Copia `.env.local.example`" | Ese archivo no existe; el contrato real es `.env.example` | `git ls-files` |
| README: RLS protege los datos | La app omite RLS por completo (§2.2) | `db/client.ts:5` |
| `lib/reports/report-sections.ts:1-5`: "Compartido por la vista de detalle y la de impresión/PDF **para que las dos nunca diverjan**" | Ya divergieron: el PDF usa el título de BD (inglés), la impresión usa `SECTION_META` (español) | `ReportPdfDocument.tsx:348` vs `print/page.tsx:279` |

---

## 3. Estado del entorno y resultados de comandos

Todos los comandos se ejecutaron en Windows 11 / PowerShell / Node v24.16.0 / pnpm 9.15.9.

| # | Comando | Resultado | Detalle |
|---|---|---|---|
| 1 | `pnpm typecheck` | ✅ **exit 0** | `tsc --noEmit`, sin errores |
| 2 | `pnpm lint` | ✅ **exit 0** | 0 errores, **56 advertencias** |
| 3 | `pnpm test:unit` | ✅ **exit 0** | **78 archivos, 1 027 pruebas**, 49,9 s |
| 4 | `pnpm build` | ✅ **exit 0** | 61 rutas, compilado en 12,4 s |
| 5 | `npx drizzle-kit check` | ✅ | `Everything's fine 🐶🔥` — **sin drift de esquema** |
| 6 | `pnpm supabase start` | ✅ | Stack local en `127.0.0.1:55321/55322` |
| 7 | `pnpm db:migrate:local` | ❌ **exit 1** | **Falla en silencio.** Ver DB-01 |
| 8 | `pnpm test:integration` (local, config correcta) | ✅ | **28/28 pruebas** |
| 9 | `pnpm test:integration` (tras re-ejecutar `0033`) | ❌ | **23 pasan / 5 fallan de 28.** Ver SEC-03 |
| 10 | `pnpm audit --prod` | ❌ | **10 vulnerabilidades: 5 altas, 5 moderadas.** Ver SEC-01 |
| 11 | `pnpm dev` + recorrido E2E | ⚠️ | Camino completo funcional **con 3 bloqueadores de UX** |

### 3.1 Desglose de las 56 advertencias de lint

```
52  @typescript-eslint/no-unused-vars
 2  @next/next/no-img-element
 2  jsx-a11y/alt-text
```

**Impacto:** las 52 variables sin usar son ruido acumulado que oculta problemas reales (ese es su costo, no el estilo). Las 2 de `jsx-a11y/alt-text` son un defecto de accesibilidad real: imágenes sin texto alternativo.

### 3.2 Comando 7 — fallo del bootstrap local (DB-01)

```
> drizzle-kit migrate --config=drizzle.local.config.ts
[⣯] applying migrations... ELIFECYCLE  Command failed with exit code 1.
```

`drizzle-kit` **sale con código 1 sin emitir ningún mensaje de error**. Estado verificado en la BD local:

```sql
select count(*) from drizzle.__drizzle_migrations;  -- 34
-- El journal tiene 41 entradas → 7 migraciones (0034–0040) nunca se aplican.
```

Se descartó que el SQL sea la causa: las siete migraciones se aplicaron manualmente sin error (`psql -v ON_ERROR_STOP=1`), incluida `0034` verificada primero en una transacción con `ROLLBACK`.

**Causa probable:** incompatibilidad de `drizzle-kit@0.31.10` con **Node 24** (rechazo de promesa no capturado que se traga el error). CI usa **Node 22** (`ci.yml:23`) pero **nunca ejecuta migraciones**, por lo que este fallo no se detecta en ningún pipeline.

**Impacto funcional:** cualquier desarrollador nuevo que siga `pnpm db:setup:local` obtiene una base de datos incompleta y silenciosamente rota, sin ninguna señal de qué falló.

**Hallazgo adicional en la misma cadena:** `db/policies/008_marketing_leads_rls.sql` falla en una base limpia con `ERROR: schema "private" does not exist` (depende de que `0031_rls_core.sql` haya corrido antes), y `db/migrations/0039` falla si `supabase/migrations/20260716000001_storage_policies.sql` no corrió antes. **Existe un acoplamiento de orden entre tres conjuntos de migraciones que ningún script coordina.**

---

## 4. Inventario de módulos y auditoría funcional

Escala de estado: **✅ Funcionando** · **🟡 Parcial** · **🔵 Diseñado, no conectado** · **🟠 Simulado/mock** · **🔴 Roto** · **⬜ No implementado** · **❓ No verificable**

#### Nivel de evidencia — cómo leer estas tablas

El estado responde a *qué tan completa está la funcionalidad*. El **nivel de evidencia** responde a algo distinto y más importante para una auditoría: *cómo lo sé*. Se declaran por separado a propósito, porque **un ✅ con evidencia E3 no es una funcionalidad probada, es una funcionalidad leída.**

| Nivel | Significado |
|---|---|
| **E1** | **Ejecutado.** Observado funcionando durante el recorrido E2E de esta auditoría, contra un stack real |
| **E2** | **Probado.** Cubierto por pruebas automatizadas verdes (unitarias o de integración), pero no ejercitado por la interfaz |
| **E3** | **Leído.** Sólo inspección de código. **No constituye verificación de funcionamiento** |

De los 8 pasos del pipeline, sólo 3 se ejercitaron por la interfaz (grupos de interés, cálculo, reportes); el resto se pobló mediante SQL para poder llegar al cálculo dentro del tiempo de la auditoría. **El panel `/admin` no se ejercitó en absoluto** — sólo se verificó que niega el acceso a quien no es `super_admin`. Stella estuvo **desactivada** (`STELLA_ENABLED=false`) durante todo el recorrido.

### 4.1 Acceso y usuarios

| Flujo | Estado | Evid. | % | Evidencia |
|---|---|---|---|---|
| Inicio de sesión | ✅ | **E1** | 95 | Verificado en vivo con `admin-a@test.com`, `analyst-a@test.com` y `admin-b@test.com`. `app/(public)/login/actions.ts:18-59` |
| Registro (signup) | 🟡 | **E3** | 70 | **No ejercitado.** Contraseña mínima de **6 caracteres** sin complejidad (`actions.ts:24,67`; `supabase/config.toml:minimum_password_length = 6`) |
| Confirmación de correo | ❓ | — | — | `enable_confirmations = false` en config local. **No verificable con el entorno disponible**: el ajuste de producción vive en el panel de Supabase |
| Cierre de sesión | ✅ | **E1** | 100 | Botón pulsado y sesión cerrada. `app/auth/signout/route.ts` — sólo POST (correcto anti-CSRF) |
| Recuperación de contraseña | 🟡 | **E3** | 75 | `forgot-password/actions.ts` + `reset-password/actions.ts` existen y están rate-limited. **No verificado end-to-end** (requiere entrega real de correo) |
| Persistencia de sesión | ✅ | **E1** | 100 | Navegación autenticada entre 8 páginas sin reautenticar. `lib/supabase/proxy.ts:60-64` |
| Protección de rutas | ✅ | **E1** | 95 | Anónimo → `/app/*`, `/admin` devuelven **307 → /login?redirect=…**. Verificado con `curl` sobre 5 rutas |
| Roles y permisos | ✅ | **E1+E2** | 90 | E1: `analyst` rechazado en onboarding, `organization_admin` rechazado en `/admin`. E2: 28 pruebas RLS + suite unitaria de `roles`/`permissions`. **Los roles `reviewer` y `viewer` no se ejercitaron por la interfaz** |
| Invitaciones | 🟡 | **E2** | 80 | `lib/invitations/service.ts` completo con pruebas verdes: token SHA-256, TTL 7 días, revocación, verificación de email. **No verificado end-to-end** (email real) |
| Desactivación de usuarios | 🟡 | **E3** | 50 | `removeMemberFromCurrentOrganization` marca `status='removed'`. **No existe desactivación global de usuario** |
| Borrado de usuario (GDPR) | 🔵 | **E3** | 10 | **Columnas sin código.** Ver GDPR-01 |
| Manejo de errores de auth | 🟡 | **E1** | 60 | Redirecciones con `?error=slug` observadas; mensajes genéricos |

**Restricción estructural (ARCH-02):** el índice único `user_single_active_membership` (`db/schema.ts:61`) impone **un usuario = una organización**. `acceptInvitation` lanza `"You already belong to an organization"` (`service.ts:178`). Un consultor o financiador que trabaje con varias organizaciones **no puede ser soportado** sin cambiar el modelo de datos.

### 4.2 Núcleo funcional — Pipeline SROI

Éste es el corazón del producto y **es su parte más sólida**.

| Paso | Módulo | Estado | Evid. | % | Archivos principales |
|---|---|---|---|---|---|
| 1 | Narrativa e impacto | ✅ | **E2** | 85 | `lib/pipeline/narratives.ts`, `theory-of-change.ts`. **Página no abierta durante el recorrido** |
| 2 | Grupos de interés | ✅ | **E1** | 85 | `lib/pipeline/stakeholders.ts`. Página cargada y formulario inspeccionado |
| 3 | Resultados (outcomes) | ✅ | **E2** | 90 | `lib/pipeline/outcomes.ts` — materialidad estructurada 1-5. **Poblado por SQL, no por la interfaz** |
| 4 | Indicadores | ✅ | **E2** | 85 | `lib/pipeline/indicators.ts`. **Poblado por SQL, no por la interfaz** |
| 5 | Evidencia | 🟡 | **E2** | 65 | `lib/pipeline/evidence.ts` — **sin descarga**, ver PROD-03. Subida cubierta por las pruebas de Storage; **no ejercitada por la interfaz** |
| 6 | Proxies financieros | ✅ | **E2** | 90 | `lib/pipeline/proxies.ts` + flujo de aprobación humana. **Aprobación aplicada por SQL, no por la interfaz** |
| 7 | Centro de confianza | 🟡 | **E3** | 80 | `app/app/trust-center/page.tsx`. **No abierto durante el recorrido** |
| 8 | Cálculo SROI | ✅ | **E1** | 95 | `lib/pipeline/sroi-calculation.ts` (1 020 líneas). Corrida ejecutada por la interfaz y resultado reproducido a mano |
| — | Reportes | 🟡 | **E1** | 70 | `lib/pipeline/sroi-results.ts`, `lib/reports/*`. Borrador, bloqueo, página pública y PDF ejecutados |

> **Lectura honesta de esta tabla:** los pasos marcados **E2** funcionan a nivel de servicio (sus pruebas unitarias pasan y sus datos alimentaron correctamente un cálculo real), pero **sus formularios de interfaz no fueron ejercitados**. Dado que los tres bloqueadores de UX encontrados aparecieron precisamente al usar formularios, es razonable esperar defectos análogos en los pasos E2 aún no recorridos. La tarea `F5-01` (E2E con Playwright) es la que convierte estos E2 en E1 de forma permanente.

#### Verificación independiente del motor de cálculo

Se creó el proyecto real *"Agua Segura San Bernardo"* y se ejecutó una corrida por la interfaz. **El resultado se reprodujo a mano:**

```
cantidad            = 150 000 tanques
valor proxy         = 0,60 USD/tanque
bruto/año           = 150 000 × 0,60          = 90 000 USD
factor de ajuste    = (1−0,10)(1−0,20)(1−0,05) = 0,684
factor de decaimiento (3 años, drop-off 15 %):
                      1 + 0,85 + 0,7225        = 2,5725
valor ajustado      = 90 000 × 0,684 × 2,5725  = 158 363,10 USD
inversión           = 42 000 USD
ratio SROI          = 158 363,10 / 42 000      = 3,770550
```

Valores persistidos por la aplicación:

```sql
select total_investment, gross_social_value, net_social_value, sroi_ratio
  from sroi_calculation_runs;
--  42000.0000 | 270000.0000 | 158363.1000 | 3.770550
```

**Coincidencia exacta.** El motor usa `decimal.js` en todo el recorrido (`sroi-calculation.ts:620-700`), persiste valores `*Exact` como cadenas de precisión completa, y las columnas monetarias son `numeric` reales. Esto elimina artefactos de punto flotante — algo crítico para un producto que se vende como auditable.

#### Compuerta de preparación (readiness gate)

`checkCalculationReadiness` (`sroi-calculation.ts:380-600`) es notablemente rigurosa. Bloquea el cálculo si falta cualquiera de: inversión, cantidades, filtros SROI, aprobación de proxy, conversión a USD, **evidencia vinculada a cada outcome**, o si la atribución por financiador excede 100 %. Cada bloqueo produce un `ReadinessIssue` con mensaje en español, `actionPath` y `actionLabel`.

**Ésta es la mejor pieza de UX del producto** y demuestra que el equipo entiende el dominio.

#### Inmutabilidad real, no declarativa

Migración `0030_immutability.sql` instala disparadores `BEFORE UPDATE OR DELETE` que lanzan excepción sobre `audit_logs`, `sroi_calculation_runs` y `sroi_calculation_line_items`. **Esto se aplica incluso al rol propietario**, por lo que es la única protección del sistema que la aplicación no puede eludir. Excelente decisión.

### 4.3 Reportes y exportación

| Capacidad | Estado | Evid. | Evidencia |
|---|---|---|---|
| Borrador anclado a corrida inmutable | ✅ | **E1** | Reporte creado por la interfaz con 12 secciones |
| 3 variantes (financiador / metodológico / auditoría) | ✅ | **E2** | `lib/reports/report-variants.ts` con pruebas verdes. **Sólo se ejercitó la variante `audit`** |
| Compuerta de revisión humana antes de bloquear | ✅ | **E1** | `sroi-results.ts:515-527` — el bloqueo **falló** sin revisión aprobada, y funcionó tras aprobarla |
| Bloqueo irreversible | ✅ | **E1** | `status='locked'`, hash emitido. Verificado en BD |
| Página pública de verificación | ✅ | **E1** | `/verify/{uuid}` renderizado correctamente |
| PDF público auditable | ✅ | **E1** | Descargado con `curl`: 63 471 bytes, PDF 1.3, 3 páginas |
| Vista de impresión HTML | 🟡 | **E3** | `report/[reportId]/print/page.tsx`. **Ruta no abierta durante el recorrido** |
| **Contenido de secciones autogenerado** | ⬜ | **E1** | **Las 12 secciones nacen vacías** (`length(content) = 0`, consultado en BD) |
| **Títulos de sección en el PDF** | 🔴 | **E1+E3** | E1: títulos en inglés y «Theory Of_change» observados en BD. E3: `ReportPdfDocument.tsx:348` usa `section.title` mientras `print/page.tsx:279` usa `SECTION_META` |
| **Compuerta de completitud antes de publicar** | ⬜ | **E1** | **No existe:** se bloqueó y publicó un reporte con las 12 secciones vacías |

### 4.4 Stella (IA)

> **Stella estuvo desactivada durante todo el recorrido** (`STELLA_ENABLED=false`). **No se ejecutó ninguna llamada real a Gemini.** Todo lo de esta tabla es E2 o E3: el diseño y las pruebas son sólidos, pero **el comportamiento en producción con un modelo real no fue verificado por esta auditoría**.

| Rol | Estado | Evid. | Evidencia |
|---|---|---|---|
| Advisor | 🟡 | **E2** | `app/actions/stella/advisor.ts` + panel UI, con suite propia verde. Botón «Preguntar a Stella» visible en el recorrido, **no pulsado** |
| Validator | 🟡 | **E2** | `app/actions/stella/validator.ts` + 701 líneas de pruebas |
| Composer | 🟡 | **E2** | `app/actions/stella/composer.ts` + 658 líneas de pruebas |
| Proxy reviewer / Evidence reviewer / Audit assistant | 🔵 | **E3** | Infraestructura lista, **desactivados por flags** (`lib/stella/config.ts`) |
| Cuotas por organización | ✅ | **E2** | `lib/stella/quota.ts` — default `0` (bloqueado). `tests/stella-quota.test.ts` verde |
| Rate limit por hora | ✅ | **E2** | `lib/stella/rate-limit.ts` — consumo atómico, *fail-closed*. `lib/stella/__tests__/rate-limit.test.ts` verde |
| Sanitización de contexto | ✅ | **E2** | `lib/stella/context/sanitize.ts` |
| Guardarraíles de prompt | ✅ | **E3** | `lib/stella/prompts/shared-guardrails.ts` |
| Salidas validadas con Zod | ✅ | **E2** | `lib/stella/schemas/*` |

Stella está **bien encapsulada**: adaptador intercambiable, esquemas de salida estrictos, cuotas, rate limiting, y `requires_human_review` forzado. Los tests anti-regresión (`lib/stella/__tests__/anti-regression.test.ts`) verifican que las pruebas nunca llamen a Gemini real — lo cual es correcto para CI, pero significa que **ninguna prueba del repositorio ejercita la integración real**.

### 4.5 Administración

> **El panel `/admin` no se ejercitó.** No se inició sesión como `super_admin` en ningún momento; lo único verificado en vivo es que **niega** el acceso a `organization_admin`. Todos los porcentajes de esta tabla salvo el primero son **E3 (sólo lectura de código)** y deben tratarse como estimaciones no verificadas.

| Función | Estado | Evid. | % | Evidencia |
|---|---|---|---|---|
| Panel `/admin` protegido por `super_admin` | ✅ | **E1** | 100 | `organization_admin` recibe redirección en las 4 rutas de admin probadas |
| Estadísticas globales | 🟡 | **E2** | 80 | `lib/admin/stats.ts` + `tests/admin-stats.service.test.ts` verde. **Pantalla no abierta** |
| Gestión de organizaciones | 🟡 | **E2** | 75 | `app/admin/organizations/*` + `tests/admin-organizations.service.test.ts`. **Pantalla no abierta** |
| Logs de auditoría globales | 🟡 | **E2** | 75 | `app/admin/logs/page.tsx` + `tests/admin-logs.service.test.ts`. **Pantalla no abierta** |
| Proxies globales | 🟡 | **E2** | 85 | `app/admin/proxies/*` + `tests/admin-proxies.service.test.ts`. **Pantalla no abierta** |
| Allowlist de registro | 🟡 | **E2** | 85 | `lib/admin/signup-allowlist.ts` + pruebas. Su efecto **sí** se observó en vivo (bloquea la creación de organización) |
| Cuotas de Stella por organización | 🟡 | **E2** | 85 | `app/admin/services/*` + `tests/admin-stella-services.service.test.ts`. **Pantalla no abierta** |
| Aprobación de borrado de proyectos | 🟡 | **E3** | 80 | `app/admin/project-deletions/*`. **Sin pruebas de servicio propias y sin ejercitar** |
| **Gestión de usuarios individuales** | ⬜ | **E1** | 0 | No existe pantalla de usuarios (ausente en la tabla de rutas del build) |
| **Soporte / impersonación** | ⬜ | **E1** | 0 | No existe |
| **Métricas de producto** | ⬜ | **E1** | 0 | No existe |
| **Coherencia visual con la app** | 🔴 | **E3** | 20 | Ver UX-12 |

### 4.6 Portafolios y analítica

> **Ninguna pantalla de portafolios se abrió durante el recorrido.** Todo es E2.

| Función | Estado | Evid. | Evidencia |
|---|---|---|---|
| CRUD de portafolios | 🟡 | **E2** | `lib/portfolios/service.ts` + `tests/portfolios.service.test.ts` verde. **Interfaz no ejercitada** |
| SROI agregado de portafolio | 🟡 | **E2** | `lib/portfolios/analytics.ts` — usa **Σneto / Σinversión**, nunca promedio de ratios (correcto metodológicamente). Cubierto por `lib/portfolios/analytics.test.ts` |
| Exclusión explícita de proyectos sin corrida | ✅ | **E2** | Cubierto por `lib/portfolios/analytics.test.ts` |

---

## 5. Auditoría de experiencia de usuario

### 5.1 Bloqueadores verificados en vivo

**UX-01 — El onboarding de organización termina en 404. (P0)**

Reproducido: sesión como `admin-a@test.com` → `/app/organization/onboarding` → seleccionar país/sector/moneda → «Comenzar a usar Uellix» →

```
404
This page could not be found.
```

Causa: `components/auth/OnboardingCheck.tsx:14` hace `router.push('/app')`. **`/app` no es una ruta** — la tabla de rutas del build sólo tiene `/app/dashboard`, `/app/projects`, etc. Los datos **sí se guardaron** (`onboarding_completed = t` verificado en BD), pero el usuario ve un 404 en inglés como primer resultado de su primera acción.

**UX-02 — Los miembros no administradores quedan atrapados. (P0)**

Reproducido: sesión como `analyst-a@test.com` en una organización sin onboarding. Toda navegación a `/app/*` redirige a `/app/organization/onboarding`. Allí el formulario se renderiza completo y enviable, pero al enviarlo devuelve:

```
Only organization admins can complete onboarding
```

En **inglés**, en un producto íntegramente en español. No hay mensaje que explique qué hacer, no hay enlace de contacto al administrador, y no hay salida. **Cualquier analista, revisor o visor invitado antes de que su administrador complete el onboarding queda bloqueado sin recurso.**

**UX-03 — Los errores de acción de servidor destruyen la página. (P1)**

Reproducido: clic en «Bloquear reporte» sin revisión metodológica aprobada. La regla de negocio **se aplica correctamente en el servidor** (`sroi-results.ts:526`), pero el `throw` no se captura en cliente y toda la pantalla del editor de reportes se reemplaza por:

```
Something went wrong
This page couldn't load due to an unexpected error. Your data has not been affected.
Try again    ← Back to dashboard
```

Cadenas codificadas en duro en inglés (`app/error.tsx:22-32`). La razón real —«la corrida no tiene revisión metodológica aprobada»— queda oculta tras «Detalles técnicos», y en producción sería **completamente invisible** (`error.digest` sólo muestra una referencia opaca).

Este patrón es **sistémico**: se repite en `stakeholders.actions.ts`, `onboarding.ts:20`, `billing/actions.ts:12,36`, `evidence.ts:131`, y prácticamente toda acción de servidor. Ninguna usa `useActionState` ni devuelve un resultado tipado de error.

### 5.2 Estados de interfaz

| Aspecto | Estado | Evidencia |
|---|---|---|
| Estados vacíos | ✅ **Muy bien cubiertos** | `EmptyState` usado en **15 páginas** |
| Estados de carga | 🔴 **Inexistentes** | **Ningún `loading.tsx` en todo el repositorio.** Toda página es un Server Component asíncrono → espera en blanco al navegar |
| Estados de error | 🟡 | `app/error.tsx` + `global-error.tsx` existen, pero en inglés y sin `Sentry.captureException` |
| 404 personalizado | 🔴 | **No existe `not-found.tsx`.** `/verify/{hash-inválido}` muestra el 404 por defecto de Next.js, en inglés y sin marca |
| Confirmaciones destructivas | 🟡 | Sí en bloqueo de reporte y borrado de proyecto; no en el resto |
| Retroalimentación de acciones | 🔴 | Sistema de toasts existe (`hooks/use-toast.ts`) pero se usa en **sólo 2 archivos** de todo el proyecto. La inmensa mayoría de los guardados no dan ninguna confirmación |
| Diseño responsive | ✅ | Verificado a 375 px: **sin desbordamiento horizontal**. `MobileNav.tsx` funcional |
| Accesibilidad | 🟡 | `aria-live`/`role="alert"` en 14 archivos, `aria-label` en la navegación, foco visible consistente. Pendientes: 2 advertencias `jsx-a11y/alt-text` |

### 5.3 Navegación y coherencia

| Defecto | Severidad | Evidencia |
|---|---|---|
| Enlace roto en la barra lateral a `/app/organization` (no es ruta) | Media | `read_page`: `link "organization" href="/app/organization"` |
| La página de login se renderiza dentro del layout de marketing, con **dos** juegos de anclas (`#producto`, `#faq`, `#metodologia`…) que no existen en `/login` | Media | Verificado en vivo |
| `<title>` de todas las páginas de la app es «Uellix \| Ledger Cívico de Impacto Social» | Baja | Verificado en las 8 páginas recorridas |
| El paso 7 del pipeline («Centro de confianza») abandona el contexto del proyecto y va a `/app/trust-center` | Media | `components/sroi/Stepper.tsx` |
| El panel `/admin` usa un lenguaje visual completamente distinto (slate-900 oscuro, Tailwind crudo, sin tokens ni componentes shadcn) y llama «arrendatarios» a los inquilinos | Media | `app/admin/page.tsx:11-51` |
| La página pública de verificación muestra `3.770550:1` mientras todas las pantallas internas muestran `3.77:1` | Media | Verificado en vivo. `verify/[hash]/page.tsx:70` |
| La página de detalle de corrida muestra el **UUID crudo de la asignación** en lugar del nombre del resultado, y vuelca el snapshot JSON completo a la pantalla | Media | Verificado en vivo |
| `GET /grid.svg 404` en la landing | Baja | Log del servidor de desarrollo |
| `capitalize` produce «Administrador De Organización» | Baja | Verificado en vivo |

### 5.4 Puntos de abandono probables

1. **Minuto 1** — el administrador completa el onboarding y ve un 404 (UX-01).
2. **Minuto 1 del invitado** — el analista queda atrapado en una pared con error en inglés (UX-02).
3. **Paso 5 del pipeline** — el revisor no puede abrir el archivo de evidencia que debe aprobar (PROD-03).
4. **Paso 8** — una regla de negocio no cumplida borra la pantalla completa con un error en inglés (UX-03).
5. **Reporte** — el usuario descubre que debe redactar 12 secciones desde cero, sin ningún contenido inicial derivado de los datos que ya cargó.

---

## 6. Auditoría técnica y de calidad de código

### 6.1 Fortalezas reales

- **Comentarios de decisión, no de descripción.** El código explica *por qué*, incluyendo trade-offs y limitaciones conocidas. Ejemplos: `db/schema.ts:731`, `sroi-calculation.ts:91-94`, `lib/security/rate-limit.ts:1-8`, `db/migrations/0039` (que se declara a sí misma obsoleta y explica por qué).
- **Cero mocks en producción.** Barrido de `mock|placeholder|hardcoded|TODO|FIXME` sobre `app/`, `lib/`, `components/`, `db/`: **todas** las coincidencias están en archivos de prueba o son `placeholder:` de CSS.
- **Disciplina de honestidad de marca.** `lib/marketing/social-proof.ts` está deliberadamente vacío con una regla explícita: «no inventar clientes, logos, testimonios ni métricas». `lib/marketing/product-shots.ts` sigue el mismo criterio.
- **Tipado estricto y consistente**, sin `any` escapados; `typecheck` limpio.
- **Constraints ricos en base de datos** (§7).

### 6.2 Deuda técnica y antipatrones

| ID | Ubicación exacta | Problema | Riesgo | Prioridad |
|---|---|---|---|---|
| TD-01 | `app/app/projects/[projectId]/pipeline/calculation/page.tsx` (**1 126 líneas**) | Componente monolítico que mezcla inversión, FX, atribución, insumos, filtros, sensibilidad, 3 paneles de Stella y resultados | Imposible de mantener y probar por partes | Media |
| TD-02 | `app/app/projects/[projectId]/pipeline/proxies/page.tsx` (813), `evidence/page.tsx` (712) | Mismo patrón | Media | Media |
| TD-03 | `db/policies/001_initial_auth_rls.sql` vs `db/migrations/0031_rls_core.sql` | **Dos definiciones divergentes de las mismas políticas RLS** con helpers en esquemas distintos (`public` vs `private`) | **Alto** — ver SEC-02 | **Alta** |
| TD-04 | `lib/auth/session.ts:213-234` y `:277-298` | Bloque de mapeo de 21 campos de organización **duplicado literalmente** | Divergencia silenciosa al añadir campos | Baja |
| TD-05 | `scripts/complete-agua-san-bernardo.ts:24-25` | Script de un solo uso con **UUIDs de producción codificados**, que importa `db/client` (→ producción) y no está referenciado por ningún script de `package.json` | **Alto** — código muerto peligroso | Alta |
| TD-06 | `lib/pipeline/sroi-results.ts:398` | `type.replace('_',' ')` sin `/g` → **«Theory Of_change»** | Defecto visible en el entregable estrella | Alta |
| TD-07 | `app/api/webhooks/stripe/route.ts:51-53` | Idempotencia por `SELECT` sobre `audit_logs.reason` — **sin índice** en esa columna, y *check-then-act* sin constraint único | Escaneo completo de tabla + carrera en entregas duplicadas | Media |
| TD-08 | `tests/report-checkbox.test.ts:117-122` | Aserciones **comentadas** que documentan la intención en lugar de verificarla | Cobertura ilusoria | Media |
| TD-09 | `app/app/projects/[projectId]/pipeline/stakeholders/page.tsx:24-31` | `export const action` en un archivo `page.tsx`, sin `revalidatePath`, sin manejo de error | Patrón no idiomático replicado en varias páginas | Media |
| TD-10 | `lib/reports/public-verify.ts:60` | `listOutcomeMappingsForProject(...).catch(() => [])` en una ruta **pública** — esa función requiere sesión, que un visitante público no tiene | El anexo de estándares del PDF público **siempre sale vacío**, en silencio | Media |
| TD-11 | 52 advertencias `no-unused-vars` | Ruido que oculta problemas reales | Baja | Baja |
| TD-12 | `components/auth/OnboardingCheck.tsx` | Compuerta de onboarding implementada **en cliente** (`useEffect` + `router.push`) | El Server Component ya renderizó y envió los datos antes de redirigir; con JS lento o desactivado no hay redirección | Media |

### 6.3 Gestión de estado, rendimiento y escalabilidad

- **Estado:** casi todo es Server Components + Server Actions, sin librería de estado global. Correcto para este producto.
- **Consultas N+1:** no se detectaron patrones N+1 en los servicios revisados; `lib/pipeline/sroi-calculation.ts` agrupa con `inArray` correctamente.
- **Índices:** amplios y bien elegidos (§7.3). Falta uno relevante: `audit_logs.reason` (TD-07).
- **Caché:** `requireOrganizationAccess` y `getCurrentOrganizationContext` usan `cache()` de React (deduplicación por request). Correcto.
- **Escalabilidad:** el cuello de botella previsible es `renderToBuffer` de `@react-pdf/renderer` en rutas públicas sin límite de tasa (SEC-08).

---

## 7. Auditoría de base de datos

### 7.1 Estado general

- **37 tablas** en `public` (verificado en la base local tras aplicar las 41 migraciones).
- **41 migraciones** Drizzle + 3 migraciones Supabase + 8 scripts de políticas.
- **Sin drift de esquema**: `npx drizzle-kit check` → *Everything's fine*.

### 7.2 Integridad — calidad alta

El esquema es **claramente superior a la media** en integridad declarativa:

- **CHECK constraints en todos los enumerados de estado**: `role_check`, `status_check`, `evidence_items_type_check`, `sroi_reports_variant_check`, etc.
- **Constraints de coherencia entre columnas**: `deletion_request_consistency_check` y `deletion_consistency_check` (`schema.ts:148-149`) impiden un borrado a medio registrar; `outcomes_materiality_pair_check` impide una puntuación sin justificación; `project_investments_in_kind_notes_check` exige notas de valoración para aportes en especie.
- **Constraint de negocio real**: `approved_proxy_check` (`schema.ts:309`) impide aprobar un proxy que no resuelva a USD — hace imposible por diseño un estado que rompería el cálculo.
- **Índices únicos parciales**: `user_single_active_membership`, `fx_rates_shared_currency_date_unique`, `theory_of_change_nodes_outcome_unique`.
- **Columnas monetarias `numeric`** con precisión explícita (20,4 para dinero, 20,6 para el ratio).
- **Inmutabilidad forzada por disparador** sobre `audit_logs`, `sroi_calculation_runs` y `sroi_calculation_line_items` (`0030_immutability.sql`) — inviolable incluso desde la aplicación.

### 7.3 Índices

39 índices declarados en `db/schema.ts`, cubriendo todas las claves foráneas de consulta frecuente y los patrones de acceso del panel de administración. **Faltante identificado:** `audit_logs.reason` (usado por la idempotencia del webhook de Stripe, TD-07).

### 7.4 RLS y separación entre organizaciones

**Verificado empíricamente:** las 28 pruebas de integración/RLS pasan contra un stack local correctamente configurado, cubriendo:

- Organización A no ve organización B (SELECT).
- Analista de A no puede insertar en B (código `42501`).
- Visor no puede insertar en su propia organización.
- Super admin ve todo.
- Usuario sin organización no ve nada.
- Storage: subida y lectura por proyecto, bloqueo cruzado, rechazo de rutas inválidas, visor no puede borrar.

**Verificado también en la aplicación real** (donde RLS está omitido): sesión como `admin-b@test.com` intentando acceder a recursos de la organización A:

| Ruta | Respuesta | Fuga de datos |
|---|---|---|
| `/app/projects/{id-ajeno}` | **200** + «Proyecto no encontrado o acceso denegado» | Ninguna |
| `/app/projects/{id}/pipeline/calculation` | **500** | Ninguna |
| `/app/projects/{id}/pipeline/evidence` | **500** | Ninguna |
| `/app/projects/{id}/report/{rid}` | **404** | Ninguna |
| `/app/projects/{id}/report/{rid}/pdf` | **404** | Ninguna |

**No hubo fuga de datos en ningún caso.** Pero hay **tres comportamientos distintos** para el mismo fallo de autorización, incluyendo dos **500** por `throw` no capturado (SEC-04).

### 7.5 Soft delete y trazabilidad

| Entidad | Soft delete | Estado |
|---|---|---|
| `projects` | 3 niveles (pausa / archivo / borrado con solicitud + aprobación) | ✅ Completo y auditado |
| `portfolios`, `outcomes`, `evidence_items`, `financial_proxies`, etc. | `status`/`assignment_status` = `archived` | ✅ Consistente |
| `organization_members` | `status = 'removed'` | ✅ |
| **`users`** | Columnas `deleted_at`/`deleted_by` | 🔵 **Sin código.** Ver GDPR-01 |

`audit_logs` registra `before_json`/`after_json`, `actor_user_id`, `ip_address`, `user_agent`, y es append-only por disparador. **Trazabilidad de nivel auditoría.**

### 7.6 Riesgos de datos

| Riesgo | Severidad | Evidencia |
|---|---|---|
| Las pruebas de integración escriben en la BD que indique `.env.local` — **producción por defecto** — y dejan huérfanos (su `afterAll` sólo borra usuarios de auth) | **Crítico** | 77 organizaciones `test-org-*`/`rls-test-org-*` acumuladas en la base local. Ver OPS-01 |
| `authenticated` tiene `DELETE` concedido sobre `evidence_items` (`0033:l.36`) | Media | Sólo mitigado por las políticas RLS de DELETE; un borrado por PostREST rompería el rastro |
| Sin backups verificados ni procedimiento de restauración documentado | Alta | No existe documento de DR |

---

## 8. Auditoría de seguridad

Clasificación: **Crítico** · **Alto** · **Medio** · **Bajo**. Ningún valor secreto se reproduce en este informe.

### SEC-01 — Dependencias con vulnerabilidades conocidas · **CRÍTICO**

`pnpm audit --prod` → **10 vulnerabilidades: 5 altas, 5 moderadas.**

| Severidad | Advisory | Paquete | Versión vulnerable | Parche |
|---|---|---|---|---|
| **Alta** | Next.js: **Middleware / Proxy bypass in App Router** | `next` | `>=16.0.0 <16.2.11` | `>=16.2.11` |
| **Alta** | Next.js: **Server-Side Request Forgery in Server Actions** | `next` | idem | idem |
| **Alta** | Next.js: SSRF in rewrites | `next` | idem | idem |
| **Alta** | Next.js: Denial of Service in App Router | `next` | idem | idem |
| **Alta** | PostCSS: Arbitrary file read | `postcss` | `<=8.5.11` | `>=8.5.12` |
| Moderada | Next.js: Cache confusion of response bodies (×2) | `next` | idem | idem |
| Moderada | Next.js: Unbounded Server Action payload (Edge) | `next` | idem | idem |
| Moderada | Next.js: DoS in Image Optimization | `next` | idem | idem |
| Moderada | Next.js: **Unauthenticated disclosure of internal Server** | `next` | idem | idem |

**Por qué es crítico aquí específicamente:** el *bypass de middleware/proxy en App Router* y el *SSRF en Server Actions* atacan exactamente las dos capas donde Uellix implementa toda su autenticación (`proxy.ts`) y toda su lógica de negocio (acciones de servidor).

**Corrección:** `next >= 16.2.11`; y `postcss >= 8.5.12` — nótese que el override actual en `package.json:75` fija `postcss@<8.5.10 → 8.5.10`, **por debajo** de la versión parcheada.

**Nota:** `docs/ops/CLOSED_BETA_READINESS.md:13` afirma «Production dependency audit reports no known vulnerabilities». Era cierto el 2026-07-21; **ya no lo es**. Esto demuestra que la auditoría de dependencias no está en CI.

### SEC-02 — Definiciones de RLS duplicadas y divergentes · **ALTO**

Existen **dos definiciones competidoras** del mismo conjunto de políticas:

- `db/migrations/0031_rls_core.sql` — helpers `SECURITY DEFINER` en el esquema **`private`**, con `REVOKE ... FROM PUBLIC` explícito. Es la versión endurecida, y su propio comentario explica el porqué: *«PostgREST/Supabase sólo auto-expone el esquema `public` como endpoints RPC»* (`0031:9-13`).
- `db/policies/001_initial_auth_rls.sql` — los mismos helpers en el esquema **`public`**, sin revocación. Es la versión antigua.

**El `README.md:135-141` sigue instruyendo ejecutar manualmente `db/policies/001_initial_auth_rls.sql` en el editor SQL de Supabase.**

**Demostrado en vivo:** tras ejecutar `001` sobre la base local (siguiendo el README), la consulta

```sql
select has_function_privilege('anon','public.current_user_is_super_admin()','EXECUTE');
--  t
```

devolvió **`true`**. Los helpers quedaron en `public` con EXECUTE para `anon`, es decir, expuestos como `/rest/v1/rpc/...` a llamadas no autenticadas. El script `001` es idempotente con `DROP POLICY IF EXISTS`, por lo que **sobrescribe las políticas endurecidas de `0031` con la variante antigua**.

**Impacto directo bajo** (`current_user_is_super_admin()` devuelve `false` para `anon` porque `auth.uid()` es `NULL`), pero el impacto de proceso es **alto**: seguir la documentación oficial del proyecto degrada activamente la postura de seguridad, y no hay ninguna verificación que lo detecte.

### SEC-03 — Fragilidad de orden entre migraciones rompe la evidencia · **ALTO**

`db/migrations/0033_public_api_grants.sql:17` ejecuta:

```sql
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
```

Esto **revoca también** las funciones auxiliares de RLS de Storage (`can_read_evidence_object`, `can_write_evidence_object`), que se crean en `supabase/migrations/20260716000001_storage_policies.sql`.

**Demostrado:** tras re-ejecutar `0033` sobre una base ya migrada, **5 de las 28 pruebas de integración fallaron**, todas con:

```
StorageApiError: permission denied for function can_write_evidence_object
```

Es decir: **toda la subida y lectura de evidencia queda inutilizada**. Volver a conceder los permisos (`0039`) restauró 28/28.

Esto significa que cualquier re-aplicación de `0033` —por un reset, una restauración de backup o un despliegue idempotente— **deja el producto sin su función central, con un error que no aparece en ningún log de aplicación.**

### SEC-04 — Manejo inconsistente de fallos de autorización · **MEDIO**

Tres respuestas distintas para el mismo fallo (§7.4): `200`, `500`, `404`. Los **500** provienen de `throw new Error('Project does not belong to your organization')` (`evidence.ts:90`) sin captura. Consecuencias: ruido en Sentry indistinguible de fallos reales, y diferencia de código de estado que permite inferir la existencia de recursos ajenos.

### SEC-05 — Rate limiting de autenticación inefectivo en producción · **MEDIO**

`lib/security/rate-limit.ts` es un limitador **en memoria** (`Map` de módulo). En Vercel, cada invocación serverless tiene su propia memoria, por lo que el límite de 5 intentos/15 min es efectivamente inaplicable. El propio archivo lo documenta con honestidad (`:1-8`). La protección real es la de Supabase Auth (`sign_in_sign_ups = 30 / 5 min por IP`).

### SEC-06 — El rate limiting global de `/api/` se desactiva en silencio · **MEDIO**

```ts
// proxy.ts:12-16
if (request.nextUrl.pathname.startsWith('/api/') &&
    process.env.KV_REST_API_URL &&
    process.env.KV_REST_API_TOKEN) { ... }
```

Si las credenciales de Upstash faltan o están mal escritas, **todo el rate limiting de la API desaparece sin ninguna advertencia**, ni en arranque ni en logs. Un despliegue con una variable mal configurada queda desprotegido de forma indetectable.

### SEC-07 — Endpoint público de escritura sin protección propia · **MEDIO**

`app/api/marketing/lead/route.ts` acepta `POST` **no autenticado** y escribe en `marketing_leads` (PII: email). Sin CAPTCHA, sin límite propio, sin deduplicación. Depende enteramente de SEC-06.

### SEC-08 — Ruta pública costosa fuera del rate limiting · **MEDIO**

`/verify/[hash]/pdf` es pública, `force-dynamic`, y ejecuta `renderToBuffer` de `@react-pdf/renderer` (uso intensivo de CPU). El matcher del rate limiter sólo cubre `/api/*` (`proxy.ts:13`), por lo que esta ruta **no tiene ningún límite**. Vector de agotamiento de CPU y de costo en Vercel.

### SEC-09 — Validación de archivos por tipo declarado · **MEDIO**

`lib/pipeline/evidence.ts:43` valida `mimeType` contra una lista blanca, pero el valor proviene del cliente; **no se inspeccionan los bytes mágicos**. Tampoco hay análisis antivirus. Mitigado por: bucket privado, RLS de Storage por proyecto, sin renderizado del contenido.

### SEC-10 — Transición de estado sin control de rol ni auditoría · **BAJO**

`app/api/proxies/[id]/suggest/route.ts` permite a **cualquier miembro activo, incluido `viewer`**, pasar un proxy de `suggested` a `pending_review`. Sin `hasRole`, sin `logAuditAction`.

### SEC-11 — Búsqueda con comodines no escapados · **BAJO**

`app/api/proxies/search/route.ts:21` construye `` `%${q}%` `` para `ilike`. Drizzle parametriza (sin inyección SQL), pero `%` y `_` del usuario no se escapan → patrones controlados por el usuario y degradación de rendimiento.

### 8.1 Controles de seguridad correctos (verificados)

- Headers de seguridad completos en toda respuesta: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `HSTS` (`lib/supabase/proxy.ts:4-19`). **Confirmado en los headers HTTP reales.**
- Verificación de firma del webhook de Stripe con `constructEvent` (`webhooks/stripe/route.ts:35`).
- Tokens de invitación: 32 bytes aleatorios, sólo el SHA-256 persistido (`invitations/service.ts:35-36,66`).
- `verification_hash` = `crypto.randomUUID()` → 122 bits de entropía (inadivinable).
- Validación de redirecciones abiertas: `lib/auth/safe-redirect.ts` + tests.
- Zod en todos los límites de entrada.
- Secretos fuera de git: `.gitignore:34` (`.env*` con excepción de `.env.example`).
- SSRF de logo mitigado: `lib/organizations/logo-url.ts` restringe al origen de Supabase Storage.
- Endpoint de salud sin PII (`api/health/auth/route.ts`).
- Contexto de Stella sanitizado antes de enviarse a Gemini.

---

## 9. Estado de preparación como SaaS

| # | Componente | Estado | Nivel | Evidencia | Brecha | Prioridad |
|---|---|---|---|---|---|---|
| 1 | Producto funcional | ✅ | 85 % | Pipeline SROI verificado E2E | Compuertas de completitud, descarga de evidencia | P1 |
| 2 | Autenticación y autorización | ✅ | 85 % | 307 en rutas protegidas; RLS 28/28 | Política de contraseñas, MFA, verificación de email | P1 |
| 3 | Multiusuario | ✅ | 85 % | 6 roles, invitaciones, miembros | Sin gestión de usuarios en admin | P2 |
| 4 | Multiempresa (multitenancy) | 🟡 | 70 % | Aislamiento verificado sin fugas | **1 usuario = 1 organización** (ARCH-02) | P1 |
| 5 | Seguridad | 🟡 | 60 % | §8 | SEC-01, SEC-02, SEC-03 | **P0** |
| 6 | Privacidad y protección de datos | 🟡 | 45 % | Páginas legales existen | GDPR-01, publicación automática (PROD-02), Session Replay | P1 |
| 7 | Gestión de suscripciones | 🔵 | 20 % | Webhook + columnas | **Sin checkout.** BIZ-01 | **P0 comercial** |
| 8 | Planes y límites de uso | 🔵 | 15 % | Sólo cuota de Stella | Sin límites de proyectos/usuarios/almacenamiento | **P0 comercial** |
| 9 | Facturación y pagos | 🔵 | 20 % | `lib/stripe/client.ts` | Sin checkout, sin dunning, sin facturas | **P0 comercial** |
| 10 | Correos transaccionales | 🟡 | 60 % | Resend + plantilla de invitación | Sólo 1 plantilla; sin bienvenida, reseteo, alertas | P2 |
| 11 | Notificaciones | ⬜ | 5 % | — | No existe sistema | P2 |
| 12 | Onboarding | 🔴 | 35 % | Verificado | **Termina en 404** (UX-01, UX-02) | **P0** |
| 13 | Recuperación de cuenta | 🟡 | 70 % | Rutas implementadas | No verificado E2E | P2 |
| 14 | Administración | 🟡 | 65 % | 7 pantallas funcionales | Sin usuarios, sin soporte, sin métricas | P2 |
| 15 | Analítica de producto | ⬜ | 0 % | — | Sin instrumentación | P3 |
| 16 | Observabilidad | 🟡 | 45 % | Sentry configurado | **`captureException` nunca se llama** | P2 |
| 17 | Logs | 🟡 | 55 % | `audit_logs` excelente; app usa `console.*` | Sin logging estructurado | P2 |
| 18 | Monitoreo de errores | 🟡 | 45 % | `onRequestError` captura server | Boundaries de cliente no reportan | P2 |
| 19 | Copias de seguridad | ❓ | — | **No verificable**: es configuración del panel de Supabase | Sin procedimiento documentado | P1 |
| 20 | Recuperación ante fallos | ⬜ | 5 % | — | Sin runbook, sin RTO/RPO | P1 |
| 21 | Entornos dev/staging/prod | 🟡 | 55 % | Vercel Preview + `SUPABASE_MIGRATION_GATE.md` | Sin Supabase de preview aislado (gate #1 del propio equipo) | P1 |
| 22 | CI/CD | 🟡 | 60 % | `ci.yml`: lint+typecheck+unit+build | Sin integración/RLS, sin audit, sin E2E, sin migraciones | P1 |
| 23 | Dominio, certificados, despliegue | ✅ | 85 % | Vercel + `lib/site.ts` | — | — |
| 24 | Soporte al usuario | ⬜ | 0 % | — | Sin canal, sin help center | P2 |
| 25 | Términos, privacidad, consentimiento | 🟡 | 55 % | `/terminos`, `/privacidad`, `/terms`, `/privacy` | El propio equipo marca «verificar operativamente» como gate pendiente | P1 |
| 26 | Documentación técnica | 🟡 | 50 % | 18 docs + 6 auditorías | **README severamente obsoleto y peligroso** | P1 |
| 27 | Manuales de operación | 🟡 | 45 % | `PM_MANUAL.md`, gates de migración | Sin runbooks de incidente | P2 |
| 28 | Pruebas | 🟡 | 60 % | 1 027 unitarias + 28 integración | **Sin E2E**; integración fuera de CI | P1 |
| 29 | Rendimiento | ❓ | — | Build 12,4 s; sin desbordamiento móvil | Sin pruebas de carga | P2 |
| 30 | Escalabilidad | 🟡 | 60 % | Índices amplios, sin N+1 | PDF sin límite; sin pruebas de volumen | P2 |

---

## 10. Hallazgos clasificados

> **Nota para evitar una contradicción aparente:** esta sección clasifica **hallazgos** (problemas observados). `BACKLOG_SAAS.csv` clasifica **tareas** (trabajo a ejecutar). Los conteos no coinciden y no deben coincidir: una tarea puede resolver varios hallazgos (`F0-02` + `F0-03` cierran UX-01 y UX-02) y un hallazgo puede requerir varias tareas (SEC-01 se resuelve con `F0-01` y se previene con `F0-07`). El CSV cuenta **8 tareas P0**; esta sección lista **5 hallazgos P0**.

### P0 — Bloqueadores

| ID | Hallazgo | Evidencia |
|---|---|---|
| **SEC-01** | 10 vulnerabilidades en dependencias de producción (5 altas), incl. bypass de proxy y SSRF en Server Actions de Next.js 16.2.9 | `pnpm audit --prod` |
| **OPS-01** | Pruebas de integración y scripts de seed apuntan a **producción** por defecto, sin guarda de host; el `afterAll` deja huérfanos | 77 orgs de prueba acumuladas; `vitest.setup.integration.ts:4`; `scripts/seed-*.ts` |
| **UX-01** | Completar el onboarding termina en **404** | Reproducido; `OnboardingCheck.tsx:14` |
| **UX-02** | Miembros no administradores quedan atrapados sin salida | Reproducido; `onboarding.ts:20` |
| **DB-01** | `pnpm db:migrate:local` falla en silencio; 7 migraciones sin aplicar | Reproducido; `count(*) = 34` de 41 |

### P1 — Indispensables para MVP / beta

| ID | Hallazgo |
|---|---|
| **SEC-02** | RLS duplicada y divergente; el README instruye el paso que degrada la seguridad |
| **SEC-03** | Re-ejecutar `0033` rompe toda la evidencia (5/28 tests fallan) |
| **BIZ-01** | Facturación sin camino de checkout — imposible cobrar |
| **PROD-01** | Reporte publicable con 12 secciones vacías |
| **PROD-02** | Bloquear = publicar en internet, sin consentimiento ni revocación |
| **PROD-03** | Imposible descargar/previsualizar evidencia |
| **GDPR-01** | Borrado de usuario: columnas sin ninguna implementación |
| **UX-03** | Errores de acción de servidor destruyen la página, en inglés |
| **ARCH-02** | Un usuario = una organización |

### P2 — Necesarios para producción

SEC-04 · SEC-05 · SEC-06 · SEC-07 · SEC-08 · SEC-09 · PROD-04 · PROD-05 · UX-04 · UX-05 · UX-06 · UX-07 · UX-08 · UX-09 · UX-10 · UX-11 · UX-12 · TD-01 · TD-05 · TD-07 · TD-10 · TD-12 · OBS-01 · TEST-01 · TEST-02 · DOC-01 · BIZ-02

### P3 — Mejoras posteriores

SEC-10 · SEC-11 · TD-04 · TD-11 · `grid.svg` 404 · «Administrador De Organización» · `readiness_score` sin poblar en `sroi_run_reviews` · slugs `section_type` visibles al usuario

---

## 11. Porcentaje de avance

Ver `MATRIZ_AVANCE_SAAS.md` para el detalle por componente, peso y justificación.

**Avance ponderado total: 70 %.**

| Escenario | Preparación | Qué falta | Esfuerzo |
|---|---|---|---:|
| Demo controlada | **90 %** | Evitar el 404 de onboarding con datos presembrados | ~1 día |
| Piloto con usuarios | **72 %** | Los 8 P0 (Fase 0 + `F2-02`) | 7,0 días-persona |
| Beta privada | **62 %** | Escenario B | 62,0 días-persona |
| Producción | **45 %** | Escenario B + resto de Fase 5 + `F6-02/04/05/06` | 74,5 días-persona |
| Comercialización SaaS | **25 %** | Escenario C; el bloque comercial está esencialmente sin construir | 92,5 días-persona |

Cifras conciliadas con `PLAN_TRABAJO_HASTA_SAAS.md` §6 y con `BACKLOG_SAAS.csv`.

---

## 12. Riesgos principales

1. **Riesgo de credibilidad del producto.** Uellix se vende como generador de evidencia *auditable*. Hoy permite publicar en internet un «Reporte Audit-Ready Verificado» con las 12 secciones vacías (PROD-01), con títulos en inglés y malformados (PROD-04), y sin que el revisor haya podido abrir un solo archivo de evidencia (PROD-03). **Es el riesgo más grave, y no es técnico: es de reputación.**
2. **Riesgo de contaminación de producción.** Un `pnpm test:integration` ejecutado por descuido escribe organizaciones, proyectos y objetos de Storage en la base real (OPS-01). Durante esta misma auditoría, un `pnpm db:seed:taxonomies` alcanzó la base remota — ver §14.
3. **Riesgo de seguridad de la plataforma.** Cuatro CVE altas en la capa exacta donde vive la autorización (SEC-01).
4. **Riesgo de operación de base de datos.** Tres conjuntos de migraciones con acoplamiento de orden no coordinado; re-aplicar una rompe la evidencia en silencio (SEC-03, DB-01).
5. **Riesgo de abandono en el primer minuto.** Onboarding en 404 y miembros atrapados (UX-01, UX-02).
6. **Riesgo comercial.** No existe camino para cobrar (BIZ-01) ni límites de plan sobre los recursos que importan (BIZ-02).
7. **Riesgo de deriva documental.** El README describe un producto de hace 39 migraciones e instruye un paso que degrada la seguridad (DOC-01, SEC-02).

---

## 13. Conclusión objetiva

Uellix tiene **un núcleo de ingeniería genuinamente bueno rodeado de un producto sin terminar**.

Lo que está bien hecho es difícil de hacer y está hecho correctamente: un motor SROI determinista con aritmética decimal exacta —verificado a mano en esta auditoría—, corridas inmutables protegidas por disparadores de base de datos, una compuerta de preparación que entiende el dominio metodológico, aislamiento multi-tenant sin fugas confirmado por 28 pruebas de integración y por pruebas manuales cruzadas, un esquema con constraints que hacen imposibles los estados inválidos, y una capa de IA encapsulada con cuotas, límites y revisión humana obligatoria. La disciplina de no inventar datos —proxies verificados contra fuentes reales, prueba social deliberadamente vacía— es coherente con la promesa del producto.

Lo que falta es lo que convierte un motor en un SaaS: el primer minuto de uso está roto, no hay forma de cobrar, no se puede abrir la evidencia que el producto pide revisar, los errores de negocio destruyen la pantalla en inglés, y las dependencias arrastran cuatro vulnerabilidades altas en la capa de autorización.

**No es un MVP técnico incompleto: es un motor terminado dentro de un producto a medio construir.** La distancia hasta una beta privada creíble es de **62 días-persona ≈ 8 semanas con dos desarrolladores** (`PLAN_TRABAJO_HASTA_SAAS.md` §6), y es corta en términos de riesgo porque casi todo lo pendiente son huecos acotados, no arquitectura por rehacer. La distancia hasta un SaaS comercializable es de **92,5 días-persona ≈ 12 semanas**, y la diferencia está dominada por el bloque de monetización, que hoy no existe.

**Una advertencia sobre el alcance de esta auditoría.** El recorrido E2E cubrió el camino dorado completo, pero **no ejercitó las pantallas del panel de administración, los portafolios, Stella con un modelo real, ni cinco de los ocho formularios del pipeline** (§4, niveles de evidencia). Dado que los tres bloqueadores de UX encontrados aparecieron precisamente al usar formularios, **es razonable esperar defectos análogos en las superficies no recorridas**. Los porcentajes de esas áreas deben leerse como estimaciones fundadas en pruebas unitarias verdes, no como verificación de funcionamiento.

El equipo ya identificó buena parte de esto por su cuenta: `docs/ops/CLOSED_BETA_READINESS.md` enumera con honestidad los gates pendientes. Esta auditoría confirma esos gates y añade los que sólo aparecen al ejecutar el producto.

---

## 14. Modificaciones realizadas durante la auditoría

Se documenta **todo** lo que esta auditoría cambió, incluido un error.

### 14.1 Archivos

| Acción | Archivo | Estado |
|---|---|---|
| Creado (temporal, `.gitignore`d) | `.env.development.local` — para que `next dev` apuntara al Supabase **local** en lugar del remoto | **Eliminado al cerrar la auditoría** |
| Creado (temporal) | `scripts/__audit_readonly_probe.mts` — sonda **de sólo lectura** | **Eliminado** |
| Creados | `AUDITORIA_ESTADO_ACTUAL.md`, `PLAN_TRABAJO_HASTA_SAAS.md`, `BACKLOG_SAAS.csv`, `MATRIZ_AVANCE_SAAS.md` | Entregables |

**No se modificó ningún archivo de código, configuración, esquema o migración del proyecto.** `git status` al cierre sólo muestra los entregables y el SVG sin seguimiento que ya existía al inicio.

### 14.2 Base de datos local (Docker, desechable)

Se levantó `pnpm supabase start` y se aplicaron manualmente las 7 migraciones que `db:migrate:local` no aplica, más las migraciones de Supabase y las políticas, más un fixture SQL del pipeline. **Todo esto vivió únicamente en el contenedor local**, que se detuvo al cerrar la auditoría con `pnpm supabase stop --no-backup`.

Estado del árbol de trabajo al cierre (`git status --short`):

```
?? AUDITORIA_ESTADO_ACTUAL.md
?? BACKLOG_SAAS.csv
?? MATRIZ_AVANCE_SAAS.md
?? PLAN_TRABAJO_HASTA_SAAS.md
?? "public/brand/Tablero de Logo Uellix.svg"   ← ya existía antes de la auditoría
```

### 14.3 Escritura accidental en la base de datos remota — declarada

**Ocurrió y debo reportarlo con claridad.**

Al ejecutar `pnpm db:seed:proxies` y `pnpm db:seed:taxonomies` se asumió que respetarían las variables de entorno locales que se habían exportado. No lo hicieron: ambos scripts hacen `import 'dotenv/config'`, que carga **`.env`**, cuyo `DATABASE_URL` apunta al proyecto Supabase remoto. **Ninguno de los dos tiene guarda de host** (a diferencia de `scripts/seed-local.ts:19-24`, que sí la tiene).

**Impacto real, cuantificado con una consulta de sólo lectura posterior:**

| Script | Efecto en la base remota |
|---|---|
| `db:seed:proxies` | **Ninguno.** Salida: *«Source "Banco Mundial" already exists — skipping»*, *«Proxy … already exists — skipping»*. Cero filas escritas. |
| `db:seed:taxonomies` | **Upsert idempotente** sobre datos de referencia globales: 2 catálogos, 34 códigos. |

Verificación posterior de `taxonomy_catalogs` remoto:

```
ODS    v2015  createdAt=2026-07-11T02:09:25Z  updatedAt=2026-07-24T14:02:27Z
IRIS+  v5.3   createdAt=2026-07-11T02:09:34Z  updatedAt=2026-07-24T14:02:34Z
taxonomy_codes: 34   (esperados según lib/taxonomies/seed-data.ts: 34)
```

**Conclusión del impacto:** no se creó, borró ni alteró semánticamente ningún dato. Los valores reescritos son idénticos a los que ya estaban (los catálogos ODS/IRIS+ son datos de referencia fijos definidos en el propio repositorio). El único cambio observable es el `updated_at` de 2 filas de catálogo y 34 de códigos. **No se tocó ningún dato de negocio, de organización ni de usuario.**

Esto **violó la restricción explícita de no modificar la base de datos remota**, y lo señalo sin atenuarlo. También convierte a `OPS-01` de un riesgo teórico en uno **demostrado**: si un agente que estaba siendo deliberadamente cuidadoso alcanzó producción por accidente, un desarrollador con prisa lo hará también — y `pnpm test:integration` sí escribe datos de negocio.

**Recomendación inmediata (tarea `F0-05` del backlog):** añadir a `scripts/seed-proxies.ts`, `scripts/seed-taxonomies.ts` y `vitest.setup.integration.ts` la misma guarda de host que ya tiene `seed-local.ts`, y borrar `scripts/complete-agua-san-bernardo.ts`.

---

## 15. Comandos ejecutados — registro completo

```bash
pnpm typecheck                                    # exit 0
pnpm lint                                         # exit 0, 56 warnings
pnpm exec eslint . -f json                        # 0 errores / 56 advertencias
pnpm test:unit                                    # 78 archivos, 1027 tests, exit 0
pnpm build                                        # exit 0, 61 rutas
npx drizzle-kit check                             # sin drift
pnpm audit --prod                                 # 10 vulns (5 altas)
pnpm supabase start                               # stack local
pnpm db:migrate:local                             # exit 1 SILENCIOSO — 34/41
psql < db/migrations/00{34..40}*.sql              # aplicación manual (local)
psql < supabase/migrations/*.sql                  # aplicación manual (local)
psql < db/policies/00{1..8}*.sql                  # aplicación manual (local)
pnpm db:seed:local                                # 2 orgs + 8 usuarios (local)
pnpm db:seed:proxies                              # ⚠ alcanzó la BD remota — 0 escrituras
pnpm db:seed:taxonomies                           # ⚠ alcanzó la BD remota — upsert idempotente
pnpm test:integration   (env local)               # 28 pasan / 0 fallan ✅
pnpm test:integration   (tras re-ejecutar 0033)   # 23 pasan / 5 fallan ❌
pnpm dev + recorrido E2E completo                 # ver §5
curl -o /dev/null -w '%{http_code}' <rutas>       # verificación de protección de rutas
curl .../verify/{hash}/pdf                        # 63 471 bytes, PDF 1.3, 3 páginas
```

### Recorrido E2E ejecutado

1. Login `analyst-a@test.com` → **atrapado en onboarding** (UX-02) ❌
2. Login `admin-a@test.com` → onboarding completado → **404** (UX-01) ❌
3. Crear proyecto «Agua Segura San Bernardo» ✅
4. Cargar pipeline (grupos, resultado, indicador, evidencia, proxy aprobado, asignación, insumos, filtros, financiador, inversión) ✅
5. Compuerta de preparación → «Listo para calcular» ✅
6. Guardar corrida → **SROI 3,770550 reproducido a mano con exactitud** ✅
7. Crear borrador de reporte (variante auditoría, 12 secciones) ✅
8. Bloquear sin revisión → **error en inglés que destruye la página** (UX-03) ❌
9. Registrar revisión metodológica `approved` ✅
10. Bloquear reporte → `status='locked'`, hash emitido ✅
11. Página pública `/verify/{hash}` ✅ (con `3.770550:1` sin formatear)
12. PDF público → 3 páginas ✅ (con títulos en inglés y secciones «Sin contenido.»)
13. Cierre de sesión → login `admin-b@test.com` → **acceso cruzado a organización A: sin fuga en 6 rutas** ✅
14. Acceso anónimo a 5 rutas protegidas → **307/401 correctos** ✅
15. Responsive 375 px → **sin desbordamiento horizontal** ✅

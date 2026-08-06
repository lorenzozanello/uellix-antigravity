# STELLA — Matriz de entorno hosted (staging)

> Compañero de [`STELLA_TRAIN_5A_READINESS.md`](STELLA_TRAIN_5A_READINESS.md).
> Cubre las Fases 2, 4 y 6 de `STELLA_TRAIN_5A_HOSTED_STAGING_READINESS_AUDIT`.
> HEAD `2de1050`. **Sólo nombres de variables — ningún valor fue leído.**

---

## 1. Fase 4 — Identificación del entorno (resultado: NO EXISTE)

| Señal exigida por la instrucción | Presente en el árbol | Evidencia |
|---|---|---|
| Identificador de proyecto hosted distinto | **NO** | `supabase/config.toml:8` `project_id = "uellix-stella-g2-local-rehearsal"` es el stack local de la CLI (puertos 5632x, `LOCAL_STAGING_G2_REHEARSAL.md:31`). No hay `supabase/.temp/project-ref` |
| Dominio distinto | **NO** | única URL en `.env.example`: `http://localhost:3000`. El único dominio hosted del árbol es el fallback de **producción** `https://uellix-antigravity.vercel.app` (`lib/site.ts:26`) — no es señal de staging, y es un riesgo (**M10** del registro) |
| Configuración de deployment distinta | **NO** | sin `vercel.json`, sin `.vercel/` |
| Base distinta | **NO** | ninguna cadena, host ni ref en el árbol |
| Secretos distintos | **NO** | los workflows de `.github/` no declaran `environment:`, `secrets.*` ni `vars.*` |
| Organización o cuenta de pruebas | **NO** | sin referencia |

**Cero de seis.** La instrucción exige **dos señales independientes**.
`STELLA_TRAIN_5A_BLOCKED_STAGING_ISOLATION`.

> **Advertencia explícita, tal como pide la instrucción:** la palabra «staging»
> aparece en `db/safety/database-access.ts` como *entorno lógico* aceptado por
> las capacidades `controlled_remote_*`, y en `LOCAL_STAGING_G2_REHEARSAL.md`
> como *ensayo local*. **Ninguna de las dos es un entorno aprovisionado.** El
> propio `G2_PACKAGE.md` (§Aclaración sobre A1) prohíbe reportar el ensayo local
> como staging.

### 1.1 Aislamiento respecto de producción

**Indemostrable.** Del lado de **producción** el árbol sí contiene un fragmento
de identidad —el nombre del proyecto Vercel `uellix-antigravity`, hardcodeado en
`lib/site.ts:26`—, pero del lado de **staging** no hay absolutamente nada, y no
se puede demostrar que dos entornos son distintos cuando uno de los dos no
existe. Lo único vigente es la
arquitectura fail-closed de `db/safety/*`, que **clasifica** destinos pero no
sabe cuál es cuál — `DATABASE_TARGET_SAFETY.md` §2 lo declara: *«que sea
`managed_remote` no significa por sí mismo "producción"»*.

---

## 2. Fase 2 — Inventario de variables

Leyenda: **Secreta** = su valor es credencial. **Fail-closed** = la ausencia
produce rechazo explícito; **fallback** = la ausencia produce un valor por
defecto silencioso.

### 2.1 Conexión de base de datos

| Variable | Consumidor | Staging | Build | Runtime | Secreta | Comportamiento | Riesgo si falta |
|---|---|---|---|---|---|---|---|
| `UELLIX_RUNTIME_DATABASE_URL` | `db/safety/resolve-capability-database-url.ts:38`, `db/client.ts:364` | **SÍ, obligatoria** | no | **sí** | **sí** | **fail-closed** — exige declarar el rol `uellix_app` | La aplicación no abre ninguna conexión. **No está en `.env.example`** |
| `UELLIX_MIGRATOR_DATABASE_URL` | `resolve-capability-database-url.ts:39`, `scripts/db-migrate-local.ts` | sólo si se migra con tooling propio | no | no | **sí** | fail-closed (rol `uellix_migrator`) | Sin migraciones por tooling. **No está en `.env.example`** |
| `UELLIX_AUDITOR_DATABASE_URL` | `resolve-capability-database-url.ts:40`, `db:audit:readonly` | opcional (auditoría) | no | no | **sí** | fail-closed (rol `uellix_auditor`, sesión read-only) | Sin auditoría estructural. **No está en `.env.example`** |
| `DATABASE_URL` | **ninguno efectivo** | **no** | no | no | **sí** | **ignorada con aviso** (`resolve-capability-database-url.ts:107-121`) | Trampa: es la única declarada en `.env.example` y ya no gobierna nada |
| `UELLIX_LOCAL_DATABASE_URL` | `resolve-local-database-url.ts:27` | no (sólo local) | no | no | sí | fail-closed (debe clasificar local y estar en el puerto esperado) | — |
| `UELLIX_STRIPE_DATABASE_URL` | CAP-03, handler del webhook | opcional | no | sí (si CAP-03) | **sí** | fail-closed — sin ella el handler responde **503** y no intenta nada | CAP-03 inoperante, de forma anunciada |

### 2.2 Autorización de destino y entorno

| Variable | Consumidor | Staging | Secreta | Comportamiento | Riesgo si falta |
|---|---|---|---|---|---|
| `UELLIX_APP_ENV` | `db/safety/database-access.ts:303` | **SÍ, obligatoria** | no | **fail-closed peligroso**: un valor **no reconocido resuelve a `production`**, no al default | Sin declararla, `NODE_ENV=production` de Vercel ⇒ entorno `production` ⇒ las capacidades `controlled_remote_migration`/`_write` (sólo staging) quedan denegadas. **No está en `.env.example`** |
| `UELLIX_DB_ALLOW_CONTROLLED_REMOTE_MIGRATION` | `database-access.ts:253` | sólo para el día en que exista tooling remoto | no | fail-closed; comparación `===` contra el literal exacto `controlled_remote_migration` | Hoy **ningún entry point usa estas capacidades** — inerte |
| `UELLIX_DB_ALLOW_CONTROLLED_REMOTE_READ` | `database-access.ts:268` | ídem | no | ídem, literal `controlled_remote_read` | ídem |
| `UELLIX_DB_ALLOW_CONTROLLED_REMOTE_WRITE` | `database-access.ts:282` | ídem | no | ídem, literal `controlled_remote_write` | ídem |
| `UELLIX_DB_LOCAL_RESET_CONFIRM` | `scripts/guard-local-reset.ts:30` | **no** (local, destructivo) | no | fail-closed, comparación exacta | — |

### 2.3 Supabase / autenticación

| Variable | Consumidor | Staging | Build | Runtime | Secreta | Comportamiento | Riesgo si falta |
|---|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | cliente y servidor Supabase, `proxy.ts` | **sí** | **sí** (inlined) | sí | no (pública) | sin ella no hay sesión | Auth caída; **es la señal que identificaría el proyecto hosted** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ídem | **sí** | **sí** (inlined) | sí | no por diseño (RLS la gobierna) | ídem | Auth caída |
| `SUPABASE_SERVICE_ROLE_KEY` | `scripts/create-test-user.ts` | **NO en staging** | no | no | **sí, crítica** | bypassa RLS por completo | **Regla del plan: no se aprovisiona.** Ningún camino de producto la necesita |

### 2.4 Proveedor generativo

| Variable | Consumidor | Staging | Build | Runtime | Secreta | Comportamiento | Riesgo si falta |
|---|---|---|---|---|---|---|---|
| `GEMINI_API_KEY` | `lib/stella/config.ts:17` | sólo para CHECKPOINT E | no | sí | **sí, crítica** | **fail-closed**: `canUseStella = isEnabled && apiKey.length > 0` | Stella inerte, que es el estado deseado hasta la rotación de ámbito staging |
| `GEMINI_MODEL` | `config.ts:21` | opcional | no | sí | no | **fallback** `gemini-2.5-flash` | Bajo: modelo por defecto explícito |
| `NEXT_PUBLIC_GEMINI_API_KEY` | referenciada en el árbol | **NUNCA** | — | — | **sí** | — | **Prohibida**: cualquier valor aquí se inlinea en el bundle del navegador |

### 2.5 Feature flags Stella (los nueve, todos `false`)

Todos con la misma semántica: `process.env.X === 'true'`. Cualquier otro valor
—incluido `1`, `TRUE`, vacío o ausente— es `false`. **Fail-closed por defecto**.

| Variable | Consumidor | Debe llegar a staging como | Riesgo si se enciende antes de tiempo |
|---|---|---|---|
| `STELLA_ENABLED` | `config.ts:25` | `false` | Gate global; enciende toda la superficie |
| `STELLA_ADVISOR_ENABLED` | `config.ts:26` | `false` | Exige **G1 aprobado** (G4 §3) |
| `STELLA_VALIDATOR_ENABLED` | `config.ts:27` | `false` | Primer rol del rollout G4 |
| `STELLA_COMPOSER_ENABLED` | `config.ts:28` | `false` | Exige guard numérico cableado |
| `STELLA_PROXY_REVIEWER_ENABLED` | `config.ts:30` | `false` | Rol 5b |
| `STELLA_EVIDENCE_REVIEWER_ENABLED` | `config.ts:31` | `false` | Rol 5b |
| `STELLA_AUDIT_ASSISTANT_ENABLED` | `config.ts:32` | `false` | Rol 5b |
| `STELLA_DECISIONS_PERSISTENCE_ENABLED` | `config.ts:36` | `false` | **La tabla no existe** hasta que G2 aplique `stella_0003`; encenderla rompe cada decisión |
| `STELLA_GROUNDED_QUERY_ENABLED` | `config.ts:43` | `false` | **Las tablas no existen** hasta `grounding_0002/0003`; el adaptador fallaría en cada consulta |

### 2.6 Cuotas y límites

| Variable | Consumidor | Staging | Secreta | Comportamiento | Riesgo si falta |
|---|---|---|---|---|---|
| `STELLA_RATE_LIMIT_PER_HOUR` | `config.ts:57` | recomendada | no | **fallback** `100` | Límite por defecto más alto del deseable para un piloto |
| `STELLA_MAX_OUTPUT_TOKENS` | `config.ts:50` | opcional | no | **fallback** `4096` | **No está en `.env.example`** |
| `STELLA_TEMPERATURE` | `config.ts:52` | opcional | no | **fallback** `0.2` (rechaza fuera de `[0,2]`) | **No está en `.env.example`** |
| `STELLA_MAX_PROMPT_CHARS` | `config.ts:55` | opcional | no | **fallback** `120000` | **No está en `.env.example`** |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | limitador distribuido | **sí** | token: **sí** | **fail-closed al usuario** (`RATE_LIMIT_UNAVAILABLE`) con fallback en memoria **por instancia** avisado once-per-process (RK-24) | Rate limit efectivo por instancia serverless, no global |

> La **cuota** de Stella no es una variable de entorno: vive en la base
> (`stella_monthly_quota` por organización, por defecto **0** = bloqueado) y se
> gobierna por el protocolo de tickets de `stella_0013…0018`.

### 2.7 Observabilidad

| Variable | Consumidor | Staging | Build | Runtime | Secreta | Comportamiento | Riesgo si falta |
|---|---|---|---|---|---|---|---|
| `NEXT_PUBLIC_SENTRY_DSN` | `instrumentation-client.ts`, `sentry.*.config.ts` | **sí** | sí | sí | no (público por diseño) | **fallback silencioso**: sin DSN Sentry no reporta y nada avisa | **Ceguera de observabilidad** en el entorno donde más se necesita |
| `SENTRY_ORG` / `SENTRY_PROJECT` | subida de sourcemaps en build | recomendadas | **sí** | no | no | fallback | Stacks sin symbolicar |
| `SENTRY_AUTH_TOKEN` | build | recomendada | **sí** | no | **sí** | fallback | Ídem |

### 2.8 Otras

| Variable | Consumidor | Staging | Secreta | Comportamiento |
|---|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | enlaces de email | **sí** | no | fallback a localhost ⇒ **enlaces rotos o cruzados entre entornos** |
| `NEXT_PUBLIC_SITE_URL` | `lib/site.ts:17` → `metadataBase`, canonicals, OpenGraph, JSON-LD, `robots.txt`, `sitemap.xml` | **SÍ, obligatoria en staging** | **sí** | no | Cadena de fallback: `NEXT_PUBLIC_SITE_URL` → `VERCEL_PROJECT_PRODUCTION_URL` → `VERCEL_URL` → **literal `https://uellix-antigravity.vercel.app`**. Sin declararla en un staging Vercel, el sitio publicaría canonicals y `sitemap.xml` apuntando al dominio de **producción** (M10) |
| `VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL` | resolución de URL | inyectadas por la plataforma | no | — |
| `RESEND_API_KEY`, `EMAIL_FROM`, `RESEND_FROM_EMAIL` | invitaciones | sí | key: **sí** | **Riesgo de staging: correo real a destinatarios reales** si se comparte la clave con producción |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | CAP-03 | modo test | **sí** | **Riesgo de staging: cobros reales** si se usa una clave `live` |
| `NODE_ENV`, `NEXT_RUNTIME`, `CI` | plataforma / `resolveEnvironment` | — | no | — |

### 2.9 Identificador hosted

**No existe ninguna variable de identificador de proyecto hosted en el árbol.**
Las capacidades `controlled_remote_*` exigen un `expectedProjectId` que hoy
**ningún entry point les pasa** (`DATABASE_TARGET_SAFETY.md` §6: *«Hoy ningún
entry point las usa»*). Aprovisionar staging exige inventar y versionar esa
variable, y es trabajo INTEGRATION-OWNED.

---

## 3. Fase 2 — Validadores de configuración existentes

| Validador | Qué impone |
|---|---|
| `db/safety/database-target.ts` | Clasifica destinos con parseo WHATWG real; rechaza autoridad ambigua (`#`, coma, múltiples `@`, cambio bajo `decodeURIComponent`), octetos ambiguos y parámetros de query inyectados |
| `db/safety/database-access.ts` | Matriz capacidad × destino × entorno × señales; sin `ALLOW_REMOTE` global; confirmaciones ligadas a proyecto y operación |
| `db/safety/resolve-capability-database-url.ts` | Una URL por rol; `DATABASE_URL` ignorada con aviso |
| `db/client.ts` | Único constructor de conexión; fija `ssl: 'verify-full'` para `controlled_remote_*`; rechaza claves que determinen destino |
| `db/prepared-package-order.ts` + `db/migrator.ts` | `assertPreparedPackageOrder` como **precondición dentro de la transacción**; `DB_MIGRATOR_PACKAGE_ORDER_VIOLATION` |
| `scripts/ci-assert-local-targets.ts` | Comprueba destinos locales con el clasificador, no con greps |

**Hueco relevante para staging:** `db/migrator.ts:234` solicita la capacidad
`local_migration`, que **sólo acepta loopback/contenedor**. Por tanto **ninguna
herramienta de este repositorio puede aplicar un paquete preparado a una base
hosted**; la única vía prevista es `psql` manual, ejecutada por el operador
humano (`db/prepared/README.md` regla 2, `G2_PACKAGE.md` §Aplicación).

---

## 4. Fase 6 — Compatibilidad con la base hosted

Clasificación exigida: **confirmada localmente · requiere verificación hosted ·
no disponible · opcional · bloqueante**.

| Dependencia | Uso real | Clasificación |
|---|---|---|
| **Superusuario (`rolsuper`)** | Guarda `IF NOT (SELECT rolsuper …)` en los **10** paquetes de la cadena | **NO DISPONIBLE en Supabase gestionado · BLOQUEANTE** (`DATABASE_ROLE_MODEL.md` §5.0) |
| **PostgreSQL ≥ 17** | `stella_0004:120` aborta si `server_version_num < 170000` (manejo de `MAINTAIN`) | **Requiere verificación hosted · bloqueante si el proyecto es PG15/16** |
| **PostgreSQL ≥ 13** | `gen_random_uuid()` como builtin de `pg_catalog`; `stella_0014:160` aborta si `to_regprocedure` no lo resuelve | Confirmada localmente; trivialmente satisfecha en hosted |
| **`pg_catalog.sha256`** | derivación de `chunk_id`, digests, nonces | Confirmada localmente. **No requiere pgcrypto** — los propios scripts lo documentan (`stella_0013:515`, `grounding_0003:924`) |
| **pgcrypto** | ninguno | **No requerida** (dependencia deliberadamente evitada para no referenciar el esquema `extensions` desde funciones con `search_path` vacío) |
| **pgvector** | Sólo `grounding_0001`, **superseded, NO APLICAR**. `grounding_0003` es pgvector-free por diseño | **Opcional** — la decisión G5 P3 sigue abierta y la cadena vigente no la fuerza |
| **`auth.uid()`** | 12 usos en `stella_0013`, 17 en `stella_0014`, presente en 8 de los 10 paquetes | **Requiere verificación hosted · bloqueante vía RR-09**: los `SECURITY DEFINER` propiedad de `uellix_owner` exigen `USAGE ON SCHEMA auth`, y `postgres` no puede concederlo en hosted (`auth` es de `supabase_auth_admin`). Sin ese grant **toda la RLS del producto** falla con `permission denied for schema auth` |
| **`auth.jwt()`** | sin uso directo en la cadena | No aplica |
| **Roles `uellix_*`** | `uellix_owner`, `_migrator`, `_app`, `_writer`, `_auditor` + 4 roles de capacidad (`uellix_cap_grounding`, `_cap_stella_quota`, `_cap_stella_ticket`, `_cap_stripe`) | **Bloqueante**: los crea `stella_0004`, que no arranca en hosted |
| **Propietarios (ownership)** | 38 tablas + 8 funciones de `public` → `uellix_owner` | Requiere verificación hosted; el owner actual debe ser miembro del nuevo owner (posible como `postgres`), pero depende de `stella_0004` |
| **Privilegios / `MAINTAIN`** | `REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN` | Requiere PG17 |
| **`pg_default_acl` de `supabase_admin`** | corrección exigida por `stella_0004` (RR-03) | **NO DISPONIBLE en hosted** |
| **`ADMIN OPTION` de `postgres`** | RR-02: en hosted `postgres` retiene `ADMIN OPTION` sobre todo rol que cree | **No disponible cerrar** — la separación owner/runtime queda como obstáculo auditable, no barrera |
| **RLS** | Todos los paquetes; `stella_0017` §5 (5) exige RLS activo en `stella_interactions` (segunda barrera contra `COPY … FROM`) | Confirmada localmente · requiere verificación hosted |
| **Advisory locks (`pg_advisory_xact_lock`)** | serialización de cuota por organización; presente en 7 paquetes | Confirmada localmente · disponible en hosted (builtin) |
| **`SECURITY DEFINER`** | 8-12 funciones por paquete | Confirmada localmente · disponible en hosted |
| **`search_path`** | `SET search_path = public` a nivel de script; `search_path = ''` en todas las funciones | Confirmada localmente. Nota histórica: `SET search_path = public` rompía la resolución del tipo `vector` en hosted (donde pgvector vive en `extensions`) — irrelevante para la cadena vigente, que no usa `vector` |
| **`GENERATED ALWAYS`** | `operation_tickets.period_month` (`stella_0016`) | Confirmada localmente · disponible (PG12+) |
| **pg_cron** | **ninguno.** Los paquetes lo dicen explícitamente: *«There is no pg_cron in this project»* (`stella_0014:95, 1212`); la expiración vive en el predicado de liveness, no en un reaper | **No requerida** |
| **pg_net** | ninguno | **No requerida** |
| **Funciones del proveedor hosted** (`supabase_functions`, webhooks, etc.) | ninguna | **No requerida** |

### 4.1 Conclusión de la fase

`STELLA_TRAIN_5A_BLOCKED_HOSTED_COMPATIBILITY`.

La cadena preparada asume un PostgreSQL 17 **con superusuario** y con capacidad
de conceder `USAGE ON SCHEMA auth`. Supabase gestionado no ofrece ninguna de las
dos. No es un ajuste de runbook: `DATABASE_ROLE_MODEL.md` §5.0 ya declaró que
una variante remota **sería un script distinto, con otro modelo de confianza y
su propia revisión**.

**Ninguna consulta se ejecutó contra ninguna base hosted para producir esta
matriz.** Todo lo anterior sale del SQL preparado y de la documentación
existente. Las filas marcadas «requiere verificación hosted» son exactamente el
contenido del CHECKPOINT A del plan de migración.

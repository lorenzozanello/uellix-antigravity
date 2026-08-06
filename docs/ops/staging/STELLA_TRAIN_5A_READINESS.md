# STELLA TRAIN 5A — Readiness para despliegue hosted de staging

> **Auditoría estrictamente read-only.** Cero escrituras remotas, cero
> escrituras a base de datos, cero migraciones, cero llamadas a proveedor,
> cero lectura de valores de secretos, cero push, cero fetch/pull.
>
> - **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-staging`
> - **Branch:** `codex/stella-staging`
> - **HEAD (inicial y final del análisis):** `2de1050059068e7bb8bc4395b47a002e0ea668d1`
> - **Fecha:** 2026-08-06
> - **Resultado previo:** `STELLA_TRAIN_5_WORKTREES_READY_FOR_HOSTED_STAGING`

> **ACTUALIZACIÓN — Train 5B (2026-08-06).** El bloqueador **B1** de este informe
> («paquetes incompatibles con la plataforma hosted») **ya no es estructural**:
> existe una ruta hosted completa, documentada en
> [`STELLA_MANAGED_SUPABASE_COMPATIBILITY.md`](STELLA_MANAGED_SUPABASE_COMPATIBILITY.md).
> **B2** (staging no aislado) y **B3** (rotación de clave) siguen abiertos y
> siguen siendo suficientes por sí solos: el resultado de esta auditoría **no
> cambia**. Lo que cambia es que dejó de haber un bloqueador que exigía elegir
> otra plataforma o reescribir la cadena — ver §10.

**Resultado de esta auditoría: `STELLA_TRAIN_5A_BLOCKED_STAGING_ISOLATION`.**

Tres bloqueadores independientes, cada uno suficiente por sí solo para impedir
el inicio de la aplicación real. El más profundo no es el de aislamiento: es que
**la cadena completa de paquetes exige superusuario de PostgreSQL, y Supabase
gestionado no lo ofrece** (§5 de este documento y
[`STELLA_HOSTED_ENVIRONMENT_MATRIX.md`](STELLA_HOSTED_ENVIRONMENT_MATRIX.md) §4).

---

## 1. Fase 1 — Preflight local

| Comprobación | Esperado | Observado | Resultado |
|---|---|---|---|
| Ruta | `…\uellix-stella-staging` | `/c/Users/Lorenzo/Documents/uellix-stella-staging` | **OK** |
| Branch | `codex/stella-staging` | `codex/stella-staging` | **OK** |
| HEAD completo | `2de1050…668d1` | `2de1050059068e7bb8bc4395b47a002e0ea668d1` | **OK** |
| Working tree limpio | sin cambios | `git status --porcelain -uall` vacío | **OK** |
| Staging (índice) vacío | sí | vacío | **OK** |
| Untracked vacío | sí | vacío | **OK** |
| Ausencia de upstream | sin upstream | `fatal: no upstream configured for branch 'codex/stella-staging'` | **OK** |
| Commits de Train 4 presentes | sí | `2de1050`, `6e4876a`, `b742899`, `5429d3f`, `76b8aaf` en `git log` | **OK** |
| `stella_0013…0018` presentes | 6 forward + 6 rollback | los 12 archivos existen en `db/prepared/` | **OK** |
| Package order completo | cadena + supersesiones | `db/prepared-package-order.ts`: cadena `0013→0018` + **8** reglas de supersesión | **OK** |
| Feature flags en `false` | sí | `.env.example`: los 9 flags `STELLA_*` en `false` (`STELLA_RATE_LIMIT_PER_HOUR=100` no es flag) | **OK** |
| `local-runtime-ready=true` | sí | declarado en `STELLA_PARALLEL_WORKSTREAMS.md` §Tren 4.3c y `workstreams/RELEASE.md:2678` | **OK, con matiz — ver §1.1** |
| `runtime-reserved-quota-verified=true` | sí | mismo origen | **OK, con matiz — ver §1.1** |
| `staging-blocked` | `true` | `tests/eval/stella-release/local-release-gate.ts:572` → `stagingBlocked: true` **incondicional** | **OK** |
| `hosted-blocked` | `true` | `local-release-gate.ts:573` → `hostedBlocked: true` **incondicional** | **OK** |
| Gates pesados en ejecución | ninguno | `Get-CimInstance Win32_Process`: sólo servidores MCP (`server-pdf`, `context7-mcp`); ningún `vitest`, `pnpm`, `psql`, `pg_dump` | **OK** |

Preflight local: **sin diferencias**. No aplica `STELLA_TRAIN_5A_BLOCKED_LOCAL_STATE`.

### 1.1 Matiz obligatorio sobre los dos gates de runtime

`local-runtime-ready` y `runtime-reserved-quota-verified` **no son propiedades
estáticas del árbol**. `computeLocalReleaseGateReport`
(`tests/eval/stella-release/local-release-gate.ts:488-501`) sólo puede
devolverlos `true` si recibe un `LocalRuntimeEvidence` producido por una
ejecución real de `scripts/stella-ticket-e2e.sh` / `stella-multicategory-quota-e2e.sh`
contra una base PostgreSQL desechable. Sin esa evidencia —que es el estado de
cualquier checkout limpio, y el de esta auditoría, que no ejecutó nada— el
reductor devuelve `false` con las razones enumeradas verbatim.

Por tanto lo verificable hoy es: **existe evidencia registrada de una ejecución
que los puso en `true` (tren 4.3c, 2026-08-06), y el productor de esa evidencia
es único y nombrado.** Esta auditoría **no** reprodujo esa ejecución (habría
exigido Docker, prohibido). Se registra como afirmación heredada del ledger, no
como medición propia.

### 1.2 Docker

Docker Desktop está **corriendo como aplicación de escritorio**, sin contenedor
de gate asociado a este trabajo (ningún proceso `psql`/`pnpm`/`vitest` vivo).
No se ejecutó ningún comando `docker`, ni siquiera de sólo lectura, por la
prohibición absoluta de la instrucción.

---

## 2. Fase 3 — Rotación de la clave de proveedor

### Evidencia encontrada (sin leer ningún valor)

| Hecho | Evidencia |
|---|---|
| Hubo una exposición de `GEMINI_API_KEY` | `docs/AUDIT_2026-07-06.md` — hallazgo CRITICAL, ubicación `.env.local` línea 3, hoy con el marcador `[REDACTED — GEMINI_API_KEY ROTATED]` |
| Hubo una rotación real | `docs/ops/gates/G4_PACKAGE.md` P6: «rotated 2026-07-10 after the leak incident»; `docs/ops/runbooks/STELLA_INCIDENTS.md` §A.2: «precedente real: incidente 2026-07-10, key filtrada/bloqueada, 403 PERMISSION_DENIED — la rotación en Vercel resolvió» |
| Existe procedimiento de revocación | `STELLA_INCIDENTS.md` §Kill-switch capa 3: «rotar/retirar `GEMINI_API_KEY` en Vercel»; el adapter no cachea cliente, así que surte efecto en la siguiente request |
| Existe redacción en logs | `buildGeminiErrorLog` (prefijo `[stella]`, clave redactada); la campaña corre las suites con `env -u GEMINI_API_KEY` |

### Lo que NO existe

| Requisito de la Fase 3 | Estado |
|---|---|
| Revocar la clave expuesta | **evidenciado** (2026-07-10, ámbito Vercel/producción) |
| Crear una clave nueva **para staging** | **ausente** — no hay procedimiento ni referencia a una clave de ámbito staging |
| Almacenarla en el gestor de secretos **de staging** | **ausente** — no existe gestor de secretos de staging porque no existe entorno de staging (§3) |
| Impedir que aparezca en terminales y logs | **parcial** — hay redacción en el path de error del adapter y práctica de `env -u`; no hay procedimiento escrito de higiene de terminal para el operador humano |
| Probar que la clave anterior ya no es válida | **ausente** — ningún documento define esta comprobación, y esta auditoría tiene prohibido probar claves |

**Resultado de fase: `STELLA_TRAIN_5A_BLOCKED_PROVIDER_KEY_ROTATION`.**

Consecuencia acotada, tal como pide la instrucción: la ausencia de proveedor
**no** bloquearía por sí sola la aplicación de SQL en staging; sí bloquea
cualquier gate hosted que invoque generación real (G1, G8, G9 y el
CHECKPOINT E del plan).

---

## 3. Fase 4 — Identificación del entorno staging

**Búsqueda exhaustiva de señales de entorno hosted en el árbol en `2de1050`:**

| Señal buscada | Resultado |
|---|---|
| Project ref / identificador hosted | **ninguno.** `supabase/config.toml` `project_id = "uellix-stella-g2-local-rehearsal"` — es el nombre del stack **local** de la CLI, no una referencia de proyecto hosted (puertos 5632x, documentados como locales en `LOCAL_STAGING_G2_REHEARSAL.md`) |
| Proyecto Supabase enlazado | **ninguno.** `supabase/.temp/` no existe; `supabase/` sólo contiene `.gitignore`, `config.toml`, `migrations/` |
| Organización / cuenta | **ninguna** referencia en el árbol |
| Nombre de entorno | Existe el **valor** `staging` como entorno lógico en `db/safety/database-access.ts` (`resolveEnvironment`, políticas de capacidad). Es una etiqueta que el clasificador acepta, **no** un entorno aprovisionado |
| URL / dominio **de staging** | **NO.** `.env.example` fija `NEXT_PUBLIC_APP_URL`/`NEXT_PUBLIC_SITE_URL` a `http://localhost:3000`. **Sí existe, en cambio, una identidad de producción hardcodeada:** `lib/site.ts:26` devuelve `https://uellix-antigravity.vercel.app` como último recurso de `resolveSiteUrl()`, consumido por `app/layout.tsx`, `app/robots.ts`, `app/sitemap.ts` y las dos rutas públicas. Es señal de **producción**, no aporta ninguna señal de staging — y crea un riesgo propio, registrado como **M10** |
| Deployment target | **ninguno.** No hay `vercel.json`, no hay `.vercel/` (además `.gitignore:43` lo excluye) |
| Secretos de CI | **ninguno.** `.github/workflows/ci.yml` y `p1a-validation.yml` no declaran `environment:`, `secrets.*` ni `vars.*` |
| Base distinta de producción | **indemostrable desde el repo** — no hay ninguna cadena, host ni referencia |
| Archivos `.env` locales | **ninguno** salvo `.env.example` (verificado por listado de nombres; no se abrió ningún `.env*` real) |

### Veredicto

El repositorio **no contiene ni una sola señal independiente** de un entorno
hosted de staging, y mucho menos las **dos señales independientes** que la
instrucción exige. Las únicas menciones a «staging» son (a) el nombre de un
entorno lógico en la política de capacidades y (b) el **ensayo local**
documentado en `LOCAL_STAGING_G2_REHEARSAL.md`, que el propio `G2_PACKAGE.md`
§«Aclaración sobre A1» declara explícitamente que **no es staging y no debe
reportarse como tal**.

**Resultado de fase: `STELLA_TRAIN_5A_BLOCKED_STAGING_ISOLATION`.**

Este es el resultado global de la auditoría por ser el bloqueador que impide
incluso el CHECKPOINT A (inspección hosted de sólo lectura): no hay adónde
conectarse.

---

## 4. Fase 2 — Inventario de configuración (sin secretos)

Inventario completo en
[`STELLA_HOSTED_ENVIRONMENT_MATRIX.md`](STELLA_HOSTED_ENVIRONMENT_MATRIX.md) §2.

**El hallazgo estructural de esta fase:** `.env.example` está **desincronizado
con el runtime real desde el cutover de identidad de 2026-08-02**. Declara
`DATABASE_URL`, que `db/safety/resolve-capability-database-url.ts:107-121`
**ignora deliberadamente** y sobre la que emite un aviso de inercia, y **no
declara** ninguna de las cuatro variables que el sistema sí consume hoy:

- `UELLIX_RUNTIME_DATABASE_URL` (rol `uellix_app`),
- `UELLIX_MIGRATOR_DATABASE_URL` (rol `uellix_migrator`),
- `UELLIX_AUDITOR_DATABASE_URL` (rol `uellix_auditor`),
- `UELLIX_APP_ENV` (resuelve el entorno; **un valor no reconocido resuelve a
  `production`**, no al valor por defecto).

Un operador que aprovisione staging leyendo `.env.example` obtendría un entorno
que no arranca (runtime sin URL) o que se auto-clasifica como producción.
Registrado como **MAJOR** en
[`STELLA_STAGING_RISK_REGISTER.md`](STELLA_STAGING_RISK_REGISTER.md).

---

## 5. Fase 6 — Compatibilidad hosted (resumen; detalle en la matriz)

**Medición decisiva:** los **diez** paquetes que staging necesitaría abortan si
`current_user` no tiene `rolsuper`:

```
grounding_0002 · grounding_0003 · grounding_0004
stella_0004 · stella_0013 · stella_0014 · stella_0015 · stella_0016
stella_0017 · stella_0018
```

(verificado por la presencia de la guarda
`IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)` en los
diez archivos.)

En Supabase gestionado el rol más alto disponible es `postgres`, que **no** es
superusuario. `docs/ops/DATABASE_ROLE_MODEL.md` §5.0 lo dice sin rodeos: *«El
script no es "aplicable con precauciones" en remoto: no arranca.»*

A eso se suman tres limitaciones estructurales ya registradas (RR-09, RR-03,
RR-02, `G2_PACKAGE.md` §43-60) y el requisito de **PostgreSQL 17+** de
`stella_0004` (`server_version_num < 170000` ⇒ aborta).

**Resultado de fase: `STELLA_TRAIN_5A_BLOCKED_HOSTED_COMPATIBILITY`** (segundo
bloqueador independiente).

---

## 6. Fase 7 — R6h y datos históricos

Contrato del CHECK `stella_interactions_governed_identity_check`
(`db/prepared/stella_0017_governed_stella_consumption.sql:355-367`):

```sql
CHECK (idempotency_key IS NOT NULL) NOT VALID
```

Detalle completo, consultas de auditoría preparadas y el conflicto que la
instrucción no anticipaba, en
[`STELLA_STAGING_MIGRATION_PLAN.md`](STELLA_STAGING_MIGRATION_PLAN.md) §4.

**Resumen del conflicto:** la Fase 7 pide determinar «qué resultados permitirían
`VALIDATE CONSTRAINT`». La respuesta es: **ninguno debe usarse para validarlo.**
La autoverificación §5 (4) del propio `stella_0017` **aborta** si encuentra la
constraint validada, con el motivo textual de que una constraint validada sobre
este ledger sólo puede significar que se borraron filas de una tabla append-only.
Validarla en staging rompería la re-aplicabilidad del paquete.

---

## 7. Fases 8-11

- **Contratos pendientes (Fase 8):**
  [`STELLA_STAGING_RISK_REGISTER.md`](STELLA_STAGING_RISK_REGISTER.md) §2.
- **Gates (Fase 9):**
  [`STELLA_STAGING_GATE_PLAN.md`](STELLA_STAGING_GATE_PLAN.md).
- **Plan por checkpoints (Fase 10):**
  [`STELLA_STAGING_MIGRATION_PLAN.md`](STELLA_STAGING_MIGRATION_PLAN.md) §5.
- **Matriz de riesgos (Fase 11):**
  [`STELLA_STAGING_RISK_REGISTER.md`](STELLA_STAGING_RISK_REGISTER.md) §3.

---

## 8. Qué haría falta para levantar el bloqueo

> **Reescrito tras Train 5B.** El punto 1 original decía «decidir la plataforma»
> y ofrecía tres salidas, de las que la tercera —reescribir la cadena como
> variante hosted— era «un tren de trabajo completo». **Ese tren se ejecutó:**
> Train 5B, 2026-08-06. La decisión arquitectónica fue Supabase gestionado
> independiente, y la ruta existe. El punto 1 ya no es una decisión pendiente.

En este orden, y ninguno es trabajo de agente:

1. ~~Decidir la plataforma de staging~~ → **HECHO** (Train 5B): proyecto Supabase
   gestionado independiente. La cadena se aplica por artefactos derivados
   (`db/prepared/hosted/`) sobre un bootstrap sin superusuario. Ver
   [`STELLA_MANAGED_SUPABASE_COMPATIBILITY.md`](STELLA_MANAGED_SUPABASE_COMPATIBILITY.md).
2. **Aprovisionar el entorno** siguiendo
   [`STELLA_STAGING_PROVISIONING_REQUIREMENTS.md`](STELLA_STAGING_PROVISIONING_REQUIREMENTS.md),
   incluida la fila de centinela y el llenado del veto de producción. Esto es lo
   que cierra **B2**.
3. **Sincronizar `.env.example`** con las cuatro variables `UELLIX_*` reales
   (§4) y dejar `NEXT_PUBLIC_SITE_URL` marcada como obligatoria por entorno
   (M10). Es INTEGRATION-OWNED (`STELLA_PARALLEL_WORKSTREAMS.md` §7).
4. **Documentar la rotación de proveedor con ámbito staging**, incluida la
   prueba de invalidez de la clave anterior (§2). Cierra **B3**.
5. Recién entonces: CHECKPOINT A del plan de migración / gate **G12**, que es
   además donde RR-09 deja de ser una hipótesis y pasa a medirse.

## 9. Fase 12 — Revisión adversarial de sólo lectura

Revisor independiente (Sonnet, razonamiento alto, sólo lectura), instruido para
**demostrar** que el plan podría tocar producción, imprimir secretos, usar
`service_role`, aplicar paquetes fuera de orden, omitir R6h, activar flags antes
del E2E, llamar al proveedor antes de la rotación, escribir durante un gate
read-only, confundir staging con local, declarar PASS sin rollback, dejar datos
de prueba o ignorar los contratos pendientes.

**Resultado: 0 BLOCKER · 1 MAJOR · 0 MINOR · 1 NIT.** Los doce vectores de
ataque quedaron sin hallazgo, cada uno con verificación propia contra el árbol.

| # | Sev. | Hallazgo | Acción |
|---|---|---|---|
| 1 | **MAJOR** | La afirmación «ninguna URL hosted en el árbol» era **falsa**: `lib/site.ts:26` hardcodea `https://uellix-antigravity.vercel.app` como último recurso de `resolveSiteUrl()`, y `siteUrl` alimenta `metadataBase`, canonicals, OpenGraph, JSON-LD, `robots.txt` y `sitemap.xml` | **Corregido.** Verificado de forma independiente antes de aceptar. Afirmación reescrita en §3 y en la matriz §1/§1.1/§2.8; el riesgo derivado se registra como **M10** (un staging sin `NEXT_PUBLIC_SITE_URL` se publicaría bajo la identidad de producción) |
| 2 | NIT | `STELLA_RATE_LIMIT_PER_HOUR` citado como `config.ts:58`; la línea real es `57` | **Corregido** |

El veredicto global **no cambia**: la señal encontrada es de **producción**, y
la Fase 4 exige dos señales independientes de **staging**, de las que sigue
habiendo cero.

## 10. Constancia de no-efectos

| Acción prohibida | Ejecutada |
|---|---|
| push / fetch / pull | **no** |
| escritura en base remota | **no** |
| migraciones | **no** |
| funciones SQL remotas | **no** |
| creación/modificación de proyectos hosted | **no** |
| `supabase start` | **no** |
| Docker (cualquier comando) | **no** |
| llamadas a Gemini o a cualquier proveedor | **no** |
| lectura de valores de secretos | **no** — sólo nombres de variables y nombres de archivo |
| apertura de `.env.local` | **no** — no existe en este worktree |
| modificación de código, `.env*` o configuración | **no** |
| habilitación de feature flags | **no** |
| cambio de branch | **no** |

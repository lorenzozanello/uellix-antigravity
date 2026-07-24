# Implementación de las ocho tareas P0

**Fecha:** 2026-07-24 · **Rama:** `fix/p0-stabilization` (desde `fbe2afe`)
**Alcance:** exclusivamente F0-01…F0-07 y F2-02. **No se implementó ninguna tarea P1, P2 o P3.**

---

## 1. Resumen ejecutivo

Las ocho tareas P0 están implementadas y verificadas. La cadena completa está en verde: `typecheck`, `lint` (0 errores), **1 074 pruebas unitarias**, **39 de integración/RLS**, `build`, `drizzle-kit check` sin drift y `pnpm audit --prod` sin vulnerabilidades conocidas.

Tres resultados merecen mención por encima del resto:

1. **El diagnóstico de la auditoría sobre `db:migrate:local` era incorrecto.** No era Node 24. Se reprodujo con el mismo Node v24.16.0 sobre una base limpia y las migraciones se aplicaron sin error. El fallo era dependiente del estado de la base preexistente, y lo que lo hizo indiagnosticable es que **`drizzle-kit migrate` se traga el error de Postgres** y sale con código 1 sin imprimir nada. El bootstrap nuevo usa el migrador de `drizzle-orm`, que sí propaga el error real.

2. **La guarda de host tenía un fallo de seguridad que las propias pruebas destaparon.** `new URL()` no falla ante una contraseña con `@` y `/` sin escapar: devuelve un **hostname equivocado**. Si ese host erróneo hubiera sido `localhost`, la guarda habría dejado pasar una conexión remota. Ahora la extracción es posicional y **falla cerrada** ante cualquier ambigüedad.

3. **SEC-03 se reprodujo, se automatizó y se autorrepara.** Reaplicar `0033_public_api_grants.sql` —lo que ocurre en una restauración de backup— revoca los permisos de los helpers de Storage y deja la evidencia inutilizada en silencio. Ahora el bootstrap lo repara y CI lo verifica como regresión explícita.

**Ninguna conexión de esta sesión alcanzó una base de datos remota.** Evidencia en §7.

---

## 2. Estado de cada tarea

| Tarea | Estado | Evidencia | Pruebas | Commit | Observaciones |
|---|---|---|---|---|---|
| **F0-05** | ✅ Completada | `pnpm db:seed:taxonomies` y `db:seed:proxies` abortan con exit 1 mostrando **sólo el hostname**, antes de abrir conexión. `db:clean:test-data` también | 26 pruebas nuevas (`tests/db-guard.test.ts`) | `ff156dd`, `e92d622` | Se implementó primero, como exigía el orden. Corrigió un fallo de extracción de host que podía dejar pasar un destino remoto |
| **F0-01** | ✅ Completada | `pnpm audit --prod` → **No known vulnerabilities found** (antes: 10, de ellas 5 altas) | 1 074 unitarias + build | `c3cd5c3` | `next` y `eslint-config-next` 16.2.9→**16.2.11** (parche, misma línea menor). Override de `postcss`: `<8.5.10→8.5.10` (vulnerable) → `<8.5.12→8.5.12` |
| **F0-02** | ✅ Completada | Log del servidor: `POST /app/organization/onboarding 200` → `GET /app/dashboard 200`. **Sin 404** | 5 pruebas de destino de redirección | `51f3858`, `21fbccf` | Había **dos** redirecciones al segmento base, no una: `OnboardingCheck` y el propio formulario |
| **F0-03** | ✅ Completada | `analyst-b@test.com` en organización sin onboarding ve la pantalla de espera en español, con administrador de contacto, y cierra sesión correctamente | 22 pruebas: 2 roles admin + 4 no admin | `93c4559` | El mensaje en inglés de la acción de servidor se tradujo; la comprobación de autorización se mantiene |
| **F0-04** | ✅ Completada | Base limpia → 42 migraciones, 37 tablas, 11 invariantes OK. Segunda ejecución idempotente | 11 invariantes automatizados | `d5e849c`, `21fbccf` | Diagnóstico real documentado en §3. Ya **no** hace falta ejecutar `db/policies/*.sql` a mano |
| **F2-02** | ✅ Completada | SEC-03 reproducido a propósito (`can_write=false`) y **autorreparado** por el bootstrap | Regresión explícita en CI + 11 invariantes | `d5e849c` | Migración correctiva `0041`, sin editar historia. Priorizada como P0 por ser el escenario de una restauración de backup |
| **F0-06** | ✅ Completada | Script eliminado tras confirmar 0 referencias. Limpieza ejecutada: **65 organizaciones y 170 filas**, disparador append-only reactivado y verificado | Verificado que aborta contra destino remoto | `ff48a1b` | El procedimiento de limpieza es el único lugar donde se desactiva el disparador de inmutabilidad, y sólo en local |
| **F0-07** | ✅ Completada | `pnpm audit --prod --audit-level high` → exit 0. Workflow reescrito | Guardas + doble bootstrap + 39 integración en CI | `27a525b` | El bootstrap **sí** cabe en CI: el workflow ya levantaba Supabase efímero. No quedó ningún paso manual |

---

## 3. Diagnóstico de F0-04 (obligatorio: no asumir Node 24)

**Hipótesis de la auditoría:** incompatibilidad de `drizzle-kit@0.31.10` con Node 24.

**Refutada.** Con el mismo `node v24.16.0`, sobre una base limpia:

```
node --unhandled-rejections=strict node_modules/drizzle-kit/bin.cjs migrate --config=drizzle.local.config.ts
[✓] migrations applied successfully!   EXIT=0
→ 41 migraciones registradas, 37 tablas, esquema `private` con sus 3 helpers
```

**Causa real, en dos partes:**

1. **Dependiente del estado.** El `drizzle.__drizzle_migrations` de la base local preexistente tenía 34 filas cuyo último `created_at` (`2026-07-16 00:02:14`) **no correspondía** a la entrada 33 del journal (`when = 1784160200000` → `00:03:20`). El migrador selecciona lo pendiente comparando ese timestamp con el journal, de modo que el conjunto pendiente empezaba en `0033_public_api_grants.sql`, no en `0034` como sugería el conteo.

2. **`drizzle-kit` oculta el error.** Sale con código 1 sin imprimir mensaje, `sqlstate` ni sentencia. Ésa es la razón de que el fallo fuera indiagnosticable, y es la parte que no se puede arreglar desde el repositorio.

**Remedio:** el bootstrap no invoca `drizzle-kit migrate`. Usa `migrate()` de `drizzle-orm/postgres-js/migrator`, que propaga el error con `message`, `sqlstate`, `detail` y `hint`, y añade un remedio accionable.

---

## 4. Archivos modificados

### Nuevos

| Archivo | Propósito |
|---|---|
| `db/guard.ts` | Guarda de host reutilizable (F0-05) |
| `db/migrations/0041_bootstrap_closure.sql` | Migración correctiva: RLS de `marketing_leads` + permisos de Storage (F0-04, F2-02) |
| `scripts/bootstrap-local.ts` | Procedimiento único de bootstrap con 11 invariantes (F0-04, F2-02) |
| `scripts/clean-test-data.ts` | Limpieza de datos de prueba, guardada y local-only (F0-06) |
| `tests/db-guard.test.ts` | 26 pruebas de la guarda (F0-05) |
| `tests/integration/cleanup.ts` | Limpieza compartida por las suites (F0-05) |
| `tests/integration/bootstrap-invariants.test.ts` | 11 invariantes tras el doble bootstrap (F0-04, F2-02) |
| `app/app/organization/onboarding/onboarding-form.tsx` | Formulario extraído (F0-03) |
| `app/app/organization/onboarding/onboarding-pending.tsx` | Pantalla de espera para no administradores (F0-03) |

### Modificados

| Archivo | Cambio |
|---|---|
| `package.json` / `pnpm-lock.yaml` | `next` 16.2.11, `eslint-config-next` 16.2.11, override `postcss` 8.5.12; scripts `db:bootstrap:local` y `db:clean:test-data` |
| `db/migrations/meta/_journal.json` | Entrada 41 para la migración correctiva |
| `vitest.setup.integration.ts` | Deja de leer `.env.local`; lee `.env.test.local` y valida el host |
| `scripts/seed-proxies.ts`, `seed-taxonomies.ts`, `seed-local.ts`, `create-test-user.ts` | Guarda de host centralizada |
| `components/auth/OnboardingCheck.tsx` | Redirección a `/app/dashboard` |
| `app/app/organization/onboarding/page.tsx` | Server Component que decide por rol |
| `app/actions/onboarding.ts` | Mensajes en español |
| `lib/organizations/members.ts` | `listOrganizationAdminsForCurrentOrganization()` |
| `tests/integration/rls.test.ts`, `investments.service.test.ts` | Limpieza completa de organizaciones, proyectos y Storage |
| `tests/onboarding-page.test.tsx` | 22 pruebas por rol |
| `.github/workflows/ci.yml` | Auditoría bloqueante de dependencias |
| `.github/workflows/p1a-validation.yml` | Doble bootstrap + regresión SEC-03 + integración |

### Eliminados

| Archivo | Motivo |
|---|---|
| `scripts/complete-agua-san-bernardo.ts` | UUIDs de producción codificados; 0 referencias en código, `package.json`, CI o documentación |

---

## 5. Migraciones creadas

**`0041_bootstrap_closure.sql`** — correctiva, idempotente, **sin editar ninguna migración histórica**.

1. **RLS de `marketing_leads`.** Era el único fichero de `db/policies/` sin migración equivalente: una base creada sólo con la cadena dejaba **PII (correos de leads) sin protección**. Usa `private.current_user_is_super_admin()`, no la copia de `public`.
2. **Permisos de los helpers de Storage.** Los reafirma al final de la cadena, en un bloque condicional que avisa si las funciones aún no existen, de modo que el estado final deja de depender del orden de aplicación.

El bootstrap **reaplica este fichero en cada ejecución**, al margen del registro de migraciones: el registro impide que se repita, pero el escenario que rompe los permisos sí puede repetirse.

---

## 6. Comandos ejecutados y resultados

### Verificación final, en el orden exigido

| # | Comando | Resultado |
|---|---|---|
| 1 | `pnpm typecheck` | ✅ sin errores |
| 2 | `pnpm lint` | ✅ **0 errores**, 55 advertencias preexistentes (eran 56; F0-06 eliminó una) |
| 3 | `pnpm test:unit` | ✅ **1 074 pruebas** (antes 1 027; +47) |
| 4 | Bootstrap desde base limpia | ✅ 42 migraciones (0 → 42), 37 tablas, **11/11 invariantes** |
| 5 | Segunda aplicación | ✅ idempotente, 11/11 invariantes |
| 6 | `pnpm test:integration` | ✅ **39 pruebas** (antes 28; +11) |
| 7 | `npx drizzle-kit check` | ✅ `Everything's fine` |
| 8 | `pnpm build` | ✅ compilado en 30,3 s |
| 9 | `pnpm audit --prod` | ✅ **No known vulnerabilities found** |
| 9b | `pnpm audit --prod --audit-level high` | ✅ exit 0 (control de CI) |

### Recorrido manual

| Paso | Resultado |
|---|---|
| `admin-a@test.com` inicia sesión | ✅ llega al formulario de configuración |
| Completa el onboarding | ✅ `POST … 200` → `GET /app/dashboard 200`. **Sin 404** |
| Llega al panel | ✅ «Panel — Organización A · Administrador De Organización» |
| `analyst-b@test.com` (organización sin onboarding) | ✅ pantalla **«Configuración pendiente»** en español |
| La pantalla nombra al administrador | ✅ `admin-b@test.com` con enlace `mailto:` |
| No se muestra el formulario | ✅ verificado en el DOM (`formularioVisible: false`) |
| Cierra sesión | ✅ vuelve a `/login`, sin bucle de redirecciones |
| Texto en inglés | ✅ ninguno en los recorridos |

### Regresión SEC-03 (reproducida a propósito)

```
0033 reaplicado  → can_read=false, can_write=false   (evidencia rota)
pnpm db:bootstrap:local → 11/11 invariantes OK        (autorreparado)
```

---

## 7. Evidencia de que todas las conexiones fueron locales

| Control | Evidencia |
|---|---|
| Guarda activa antes de cualquier comando de datos | F0-05 fue la primera modificación y el primer commit (`ff156dd`) |
| Los scripts que alcanzaron producción en la auditoría hoy abortan | `pnpm db:seed:taxonomies` y `db:seed:proxies` → exit 1, hostname mostrado, **sin conexión abierta** |
| Sólo se mostró el hostname | Ningún comando de esta sesión imprimió usuario, contraseña, token ni URL completa. Verificado además por 3 pruebas automatizadas |
| Las pruebas de integración no pueden leer la configuración remota | `vitest.setup.integration.ts` ya **no** lee `.env.local` |
| Destino real de las pruebas | `.env.test.local`, generado por el bootstrap desde `supabase status`: `127.0.0.1:55321` (API) y `127.0.0.1:55322` (Postgres) |
| Toda escritura fue local | Contenedor Docker `supabase_db_uellix-antigravity`, detenible con `pnpm supabase stop --no-backup` |
| No se intentó revertir la escritura accidental de la auditoría | Confirmado: no se ejecutó ninguna operación contra el proyecto remoto |
| Mecanismo de escape | `UELLIX_ALLOW_REMOTE_DB` **nunca se activó** |

---

## 8. Riesgos pendientes

| # | Riesgo | Severidad | Nota |
|---|---|---|---|
| 1 | **`.claude/settings.local.json` contiene la contraseña de la base de producción en texto plano** (4 entradas de la lista de permisos) | **Crítico** | Detectado al inventariar puntos de entrada. El archivo está en `.gitignore` y **no** llegó a git, pero existe en disco sin cifrar y quedó expuesto en la sesión. **Requiere rotación de la credencial por una persona.** No se reproduce su valor aquí. No se editó el archivo por ser configuración local del usuario |
| 2 | Las entradas de esa lista pre-autorizan ejecutar scripts contra producción, incluido el ya eliminado | Alto | Conviene depurarlas junto con la rotación |
| 3 | `supabase start` falla en esta máquina por un problema de montaje de Docker Desktop en el contenedor **Studio** | Bajo | Ambiental, no del código. Se completó todo con `pnpm supabase start -x studio`. Studio no interviene en migraciones, pruebas ni aplicación. En CI (Linux) no aplica |
| 4 | El escenario SEC-03 sigue siendo posible en **producción** | Medio | El bootstrap sólo repara en local. Producción necesita un procedimiento equivalente — fuera del alcance P0 |
| 5 | 55 advertencias de lint preexistentes | Bajo | Es `F5-08`, prioridad P3 |
| 6 | `pnpm dev` contra el stack local sigue requiriendo crear `.env.development.local` a mano | Bajo | No se automatizó a propósito: sobrescribirlo podría pisar la configuración deliberada de un desarrollador |

---

## 9. Cambios que requieren revisión humana

1. **Rotar la credencial de producción** expuesta en `.claude/settings.local.json` y depurar esas entradas. **Es lo más urgente de esta lista.**
2. **Confirmar la eliminación de `scripts/complete-agua-san-bernardo.ts`.** Se verificó que no está referenciado, pero podría tener valor histórico para alguien del equipo.
3. **Revisar la política de RLS de `marketing_leads`** de la migración `0041`: se trasladó literalmente desde `db/policies/008`, incluido el `INSERT` anónimo. Conviene validar que esa apertura es la deseada.
4. **Decidir qué hacer con `db/policies/*.sql`.** Ya no son necesarios y `001` **degrada** la seguridad si se ejecuta. Retirarlos o marcarlos como históricos es la tarea `F2-01` (P1), fuera de este alcance. Mientras tanto, el `README` los sigue recomendando.
5. **Confirmar el cambio de disparador del workflow** `p1a-validation.yml`: pasó de `pull_request: branches: [main]` a todos los PR. Se conservó el job id `validate-p1a` para no romper la protección de rama.
6. **Verificar que `psql` está disponible** en el runner de CI (viene preinstalado en `ubuntu-latest`); lo usa el paso de regresión SEC-03.

---

## 10. Diferencias frente al backlog original

| Diferencia | Motivo |
|---|---|
| **42 migraciones, no 41** | El backlog decía «Registre las 41 migraciones esperadas». Se añadió `0041_bootstrap_closure.sql` porque la instrucción de no editar migraciones históricas obliga a una correctiva. El bootstrap deriva el número esperado del propio journal, así que no vuelve a quedar codificado |
| **El diagnóstico de F0-04 cambió** | El backlog registraba «hipótesis: drizzle-kit con Node 24». Refutada (§3). La causa real es distinta y el remedio también: no bastaba con arreglar el comando, había que dejar de depender de él |
| **F0-05 creció más de lo estimado** | Además de las guardas, hubo que corregir la limpieza de **dos** suites de integración y descubrir que `audit_logs`, al ser append-only, impide borrar organizaciones — lo que motivó el diseño de F0-06 |
| **F0-06 pasó de «eliminar un script» a «construir un procedimiento»** | El backlog ya lo pedía, pero no anticipaba el bloqueo por inmutabilidad: hay que desactivar el disparador dentro de una transacción, y por eso el procedimiento es más elaborado |
| **F0-02 tenía dos causas, no una** | La auditoría identificó `OnboardingCheck`; el formulario tenía la misma redirección |
| **Se descubrió un fallo de seguridad en la propia guarda** | `new URL()` devuelve un host equivocado, no un error, ante contraseñas con `@` y `/`. No estaba previsto en el backlog |

---

## 11. Commits realizados

Rama `fix/p0-stabilization`, 9 commits desde `fbe2afe`:

| Commit | Tarea | Descripción |
|---|---|---|
| `ff156dd` | F0-05 | Guarda de host en scripts y pruebas de integración |
| `e92d622` | F0-05 | Limpieza de organizaciones, proyectos y Storage en la suite |
| `c3cd5c3` | F0-01 | Parche de Next.js y PostCSS |
| `51f3858` | F0-02 | Redirección de onboarding al panel |
| `93c4559` | F0-03 | Pantalla de espera en español para no administradores |
| `d5e849c` | F0-04, F2-02 | Bootstrap reproducible y autorreparable |
| `ff48a1b` | F0-06 | Eliminación del script y limpieza guardada |
| `27a525b` | F0-07 | CI: auditoría bloqueante y prueba del bootstrap |
| `21fbccf` | F0-02, F0-04 | Sufijo de título y conteo sobre base limpia |

---

## 12. Criterios de aceptación demostrados

**F0-05** — Todo script de seed y toda prueba de integración aborta con mensaje explícito si el host no es loopback ✅ · Prueba automatizada del rechazo remoto ✅ (26) · La limpieza cubre organizaciones, proyectos y objetos de Storage ✅ *(las organizaciones con rastro de auditoría son indelebles por diseño; las cubre `db:clean:test-data`)*

**F0-01** — `pnpm audit --prod` sin severidad alta ni crítica ✅ · Build verde ✅ · 1 074 pruebas verdes ✅ · Recorrido manual sin regresión ✅

**F0-02** — Completar el onboarding lleva al panel ✅ · Ninguna ruta redirige al segmento base ✅ *(verificado por grep y por 5 pruebas)*

**F0-03** — Pantalla de espera en español que nombra al administrador y ofrece contacto ✅ · Puede cerrar sesión ✅ · El formulario no se muestra a quien no puede enviarlo ✅ · Sin bucle de redirecciones ✅ · Datos de onboarding intactos ✅ · Pruebas para los 2 roles admin y los 4 no admin ✅

**F0-04** — `pnpm db:setup:local` funciona desde base vacía en un comando ✅ · 42 migraciones registradas ✅ · `drizzle-kit check` sin drift ✅ · Los fallos emiten mensaje accionable ✅

**F2-02** — Aplicar el conjunto dos veces deja el sistema funcional ✅ · Prueba en CI con bootstrap limpio, doble aplicación y suite de integración ✅ · Dependencias de orden explícitas ✅ · **Evidencia funcionando tras la segunda ejecución** ✅

**F0-06** — Script eliminado tras verificar 0 referencias ✅ · Procedimiento documentado de limpieza ✅ · Usa las mismas guardas ✅ · Sin borrar datos de producción ✅

**F0-07** — CI falla ante vulnerabilidad alta o crítica ✅ · Prueba de las guardas en CI ✅ · Bootstrap doble en CI ✅ · Integración/RLS contra entorno efímero ✅ · **Sin pasos manuales pendientes**

---

## 13. Estado y siguiente paso

**Detenido tras los ocho P0, como se solicitó. No se inició la Fase 1.**

El stack local queda levantado (sin Studio) para facilitar la revisión. Para detenerlo:

```bash
pnpm supabase stop --no-backup
```

La rama `fix/p0-stabilization` está lista para revisión humana. Ningún commit se ha enviado a remoto.

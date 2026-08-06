# STELLA — Requisitos de aprovisionamiento de staging

> Lista ejecutable para **Lorenzo**. Ningún agente puede hacer nada de esto:
> exige crear un proyecto, leer un dashboard y manejar secretos.
>
> Cierra el bloqueador **B2** ([staging no aislado](STELLA_STAGING_RISK_REGISTER.md))
> cuando se complete. Hasta entonces, B2 sigue abierto.

---

## 1. El proyecto

| # | Requisito | Por qué, y qué falla si no |
|---|---|---|
| P1 | **Proyecto Supabase nuevo y dedicado**, jamás una rama ni un esquema del de producción | El aislamiento debe ser de proyecto: credenciales, base y URL distintas |
| P2 | **PostgreSQL 17 o superior** | El paquete local `stella_0004` exige 17+ por el manejo de `MAINTAIN`. El bootstrap hosted no lo exige, pero el gate `hosted_capability_report()` lo reporta y el resto de la cadena asume el mismo servidor. Elegir 15 obliga a re-auditar |
| P3 | **Organización o cuenta separada de producción**, si el plan lo permite | Segunda señal de aislamiento independiente del nombre |
| P4 | **Cero datos de producción.** Ni restauración, ni copia, ni «sólo el esquema con unas filas» | Un staging con datos reales es producción con otro nombre |
| P5 | Anotar el **project ref** (20 letras minúsculas) | Lo necesitan el centinela, la declaración del operador y el veto de producción |

## 2. Antes de aplicar nada

| # | Requisito |
|---|---|
| A1 | Migraciones base `0000`…`0039` aplicadas |
| A2 | `db/policies/001`…`008` aplicadas |
| A3 | Backup verificado como **restaurable por un humano**, no sólo «configurado» |
| A4 | Los **nueve** flags `STELLA_*` confirmados en `false` en TODO entorno que apunte a esta base |
| A5 | La fila de centinela escrita (§3) |

## 3. El centinela — el paso que sólo un humano puede dar

`stella_hosted_0001` crea la tabla y **deja la fila vacía a propósito**: un
bootstrap que acuñara su propio centinela se estaría certificando a sí mismo.

Después de aplicar el bootstrap, con el project ref leído del dashboard:

```sql
INSERT INTO uellix_bootstrap.staging_sentinel
  (environment, project_ref, bootstrap_version, owner_separation)
VALUES
  ('staging', '<project-ref-de-20-letras>', 'stella_hosted_0001',
   'auditable-obstacle: RR-02 applies, postgres retains ADMIN OPTION over uellix_owner');
```

No contiene ningún secreto: un project ref de Supabase es público en toda URL que
el proyecto sirve. Los tres CHECK de la tabla rechazan `environment <> 'staging'`,
un ref malformado y una segunda fila.

## 4. Variables de entorno

### 4.1 Las cuatro que `.env.example` NO declara y el runtime SÍ exige

Hallazgo **B4** del Train 5A, todavía abierto: `.env.example` declara
`DATABASE_URL`, que `db/safety/resolve-capability-database-url.ts:107-121`
**ignora con aviso**, y omite las que gobiernan de verdad desde el cutover de
identidad de 2026-08-02.

| Variable | Rol que debe declarar | Obligatoria |
|---|---|---|
| `UELLIX_RUNTIME_DATABASE_URL` | `uellix_app` | **sí** |
| `UELLIX_MIGRATOR_DATABASE_URL` | `uellix_migrator` | sólo para migrar con tooling |
| `UELLIX_AUDITOR_DATABASE_URL` | `uellix_auditor` | opcional |
| `UELLIX_APP_ENV` | — | **sí**, valor `staging`. Un valor no reconocido resuelve a **`production`** |

> Sincronizar `.env.example` es INTEGRATION-OWNED (`STELLA_PARALLEL_WORKSTREAMS.md` §7).
> Este train no lo tocó: la instrucción prohíbe modificar `.env*`.

### 4.2 Las que deben ser DISTINTAS de producción

| Variable | Riesgo si se comparte |
|---|---|
| `RESEND_API_KEY` | **correo real a destinatarios reales** desde staging |
| `STRIPE_SECRET_KEY` | una clave `live` **cobra de verdad**. Usar modo test |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | límites compartidos entre entornos |
| `NEXT_PUBLIC_SENTRY_DSN` | eventos de staging contaminando producción |

### 4.3 `NEXT_PUBLIC_SITE_URL` — obligatoria, y el motivo no es cosmético

**M10** del registro de riesgos. `lib/site.ts:16-27` cae en cadena a
`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` y por último al literal
`https://uellix-antigravity.vercel.app`. `siteUrl` alimenta `metadataBase`,
canonicals, OpenGraph, el JSON-LD de Organization, `robots.txt` y `sitemap.xml`.

Un staging sin esta variable **publicaría un sitemap y canonicals apuntando a
producción**. Declararla, y además servir `noindex`.

### 4.4 Prohibidas

| Variable | Motivo |
|---|---|
| `NEXT_PUBLIC_GEMINI_API_KEY` | cualquier valor se inlinea en el bundle del navegador |
| `SUPABASE_SERVICE_ROLE_KEY` | ninguna ruta de producto la necesita; `stella_0017` revoca el ledger a `service_role`. **No aprovisionar** |

## 5. Proveedor — bloqueado hasta la rotación

**B3** sigue abierto. Antes de cualquier llamada real (CHECKPOINT E / gate G1):

1. crear una clave Gemini **nueva y dedicada a staging**, con cuota propia;
2. guardarla en el gestor de secretos del entorno de staging, nunca en el repo;
3. no escribirla en ninguna terminal (usar el UI del gestor, no `export`);
4. **probar que la clave anterior ya no es válida** y archivar la evidencia;
5. dejar `STELLA_ENABLED=false` de todos modos: la clave no enciende nada.

## 6. Llenar el veto de producción

`db/hosted/target-identity.ts` → `KNOWN_PRODUCTION_IDENTIFIERS.projectRefs` está
**vacío** y un test lo fija así deliberadamente, para que llenarlo sea un acto
consciente con un test detrás.

Al aprovisionar, añadir el project ref del proyecto Supabase de **producción**
(no el de staging) y actualizar ese test. Una lista vacía retira un veto; no
retira ninguna de las tres señales positivas, que siguen siendo obligatorias.

## 7. Orden de aplicación

```
1. bootstrap:  SET uellix.bootstrap_environment = 'staging'
               psql -1 -v ON_ERROR_STOP=1 -f db/prepared/hosted/stella_hosted_0001_managed_role_bootstrap.hosted.sql
2. centinela:  el INSERT de §3
3. cadena:     los nueve artefactos de db/prepared/hosted/, en el orden del manifiesto
```

Un paquete por invocación, `-1` siempre. El planificador
(`db/hosted/hosted-migrator.ts`) rechaza una primera provisión que no aplique las
diez, y rechaza cualquier orden que no sea el del manifiesto.

## 8. Qué NO hace este documento

No autoriza aplicar nada. Aplicar exige, además de todo lo anterior, la
inspección hosted de sólo lectura (CHECKPOINT A / gate G12) con resultado PASS y
la aprobación explícita de Lorenzo.

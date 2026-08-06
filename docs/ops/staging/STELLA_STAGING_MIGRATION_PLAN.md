# STELLA — Plan de migración a staging hosted

> Fases 5, 7 y 10 de `STELLA_TRAIN_5A_HOSTED_STAGING_READINESS_AUDIT`.
> HEAD `2de1050`. **Ningún paquete fue ejecutado. Ninguna consulta se ejecutó
> contra ninguna base.** Este documento es un plan, no un registro.
>
> **ACTUALIZADO POR TRAIN 5B (2026-08-06).** El aviso original decía que este
> plan «no es ejecutable contra Supabase gestionado» porque los diez paquetes
> exigían superusuario. **Ya lo es**, por una vía distinta: los artefactos
> derivados de `db/prepared/hosted/` sobre el bootstrap
> `stella_hosted_0001_managed_role_bootstrap.sql`. Ver
> [`STELLA_MANAGED_SUPABASE_COMPATIBILITY.md`](STELLA_MANAGED_SUPABASE_COMPATIBILITY.md).
>
> Lo que sigue vigente sin cambios: la cadena canónica de §1, el orden, los
> rollbacks, el contrato R6h de §3 y los seis checkpoints de §4. Lo que cambia es
> **qué archivo se envía** y **con qué identidad**, resumido en §1.6.

---

## 1. Fase 5 — Manifiesto de paquetes

### 1.0 Baseline mínimo requerido

Antes de cualquier paquete preparado, la base debe tener la cadena Drizzle
`0000 … 0039` (`db/migrations/`) y las políticas de `db/policies/`. Las
precondiciones **duras** que los paquetes comprueban por sí mismos:

| Exigencia | Origen | Comprobado por |
|---|---|---|
| `public.uellix_forbid_mutation()` | `0030_immutability.sql` | `stella_0002` (aborta) |
| `public.current_user_org_ids()` y `current_user_is_super_admin()` existen y son `EXECUTE`-ables por `authenticated` | `0031_rls_core.sql` + `0039_grant_rls_helper_execution.sql` | `grounding_0002:118-124` (aborta) |
| Grants de API pública | `0033_public_api_grants.sql` | `stella_0002` |
| `public.stella_interactions` | `0012_stella_interactions.sql` | `stella_0013` |
| RLS activo en `stella_interactions` con sólo la política SELECT | `db/policies/002_stella_interactions_rls.sql` | precondición humana de `G2_PACKAGE.md` |

### 1.1 Cadena canónica forward

```
stella_0004  (roles)          ← precondición de todo lo demás
   ├── grounding_0002 → grounding_0003 → grounding_0004      [unidad indivisible]
   └── stella_0013 → 0014 → 0015 → 0016 → 0017 → 0018        [cadena de tickets]
```

`db/prepared-package-order.ts:88-95` fija la cadena de tickets como dato.
`db/prepared/README.md` §AVISO OPERATIVO fija que la cadena de grounding se
aplica **entera como unidad**.

### 1.2 Ficha por paquete

| Paquete | Precondiciones | Rol requerido | Objetos creados | Datos modificados | Aditivo | Rollback | Reapply | Guard de orden | Riesgo operativo |
|---|---|---|---|---|---|---|---|---|---|
| `stella_0004_role_separation` | **superusuario**, **PG ≥ 17**, baseline completo | superusuario (local: `supabase_admin`) | 5 roles; ownership de 38 tablas + 8 funciones → `uellix_owner`; 4 entradas globales de `pg_default_acl`; `USAGE ON SCHEMA auth` | ninguno (sólo privilegios) | no (transfiere ownership) | `stella_0004_rollback.sql` | sí | — | **BLOQUEANTE en hosted** (RR-09/RR-03/RR-02). Un fallo a mitad deja el producto sin RLS funcional |
| `grounding_0002_document_versions` | superusuario; `stella_0004` aplicado (roles `uellix_owner`/`_app`/`_auditor`); helpers RLS | superusuario → `SET ROLE uellix_owner` | rol `uellix_cap_grounding`; esquema `uellix_grounding`; tabla `evidence_document_versions` (14 col) + 2 índices + 3 UNIQUE + 5 CHECK + 3 policies + 2 triggers append-only + 2 funciones `SECURITY DEFINER` | ninguno | **sí** | `grounding_0002_rollback.sql` — **exige `SET grounding.rollback_confirm='true'` de sesión si la tabla tiene filas** y rechaza autorización persistida vía `ALTER DATABASE/ROLE` | sí | Se niega si `evidence_chunks` mantiene su FK. La historia de versiones **no es regenerable** desde Storage |
| `grounding_0003_evidence_chunks` | superusuario; `grounding_0002` aplicado **primero** | ídem | tabla `evidence_chunks` (23 col) + 3 índices + índice único parcial de dedup + 2 UNIQUE + 7 CHECK + 4 policies + 2 triggers + 3 funciones `SECURITY DEFINER`. **Sin pgvector** | ninguno | **sí** | `grounding_0003_rollback.sql` — **sin confirmación** (cada fila es reproducible); **se niega** si `chunks_in_scope_attested` sigue instalada | sí | **Re-aplicarlo solo revierte en silencio las dos reparaciones de `grounding_0004`** (reabre INT-CAP-002 y deja las lecturas gobernadas en conjunto vacío). Nunca sin re-aplicar `0004` a continuación |
| `grounding_0004_runtime_attestation` | superusuario; `0002` y `0003` en ese orden | ídem | `chunks_in_scope_attested` (SECURITY DEFINER); 3 CHECK nuevos sobre `evidence_chunks`; re-crea 2 policies SELECT nombrando `uellix_cap_grounding`; `REVOKE SELECT … FROM authenticated` | ninguno | **sí** | `grounding_0004_rollback.sql` — **REABRE INT-CAP-002 y lo anuncia con `RAISE WARNING`** | sí | El rollback degrada seguridad de forma declarada |
| `stella_0013_grounded_query_quota` | superusuario; baseline (`0012`, `0030`, `0031`); `stella_0004` | superusuario → `SET ROLE uellix_owner` | rol `uellix_cap_stella_quota`; esquema `uellix_stella`; columna `stella_interactions.idempotency_key` + 2 CHECK + índice único parcial; CHECK de `stella_role` ampliado a **7** valores; policy definer INSERT; `consume_stella_quota(...)` | **ALTERA `stella_interactions`** (columna nueva, nullable) | **sí** | `stella_0013_rollback.sql` — **puede NEGARSE legítimamente**: estrechar el CHECK a 6 valores sobre un ledger con filas `grounded_query` es imposible en una tabla append-only. Las cuenta y explica | sí | Primer paquete que toca el ledger de producción |
| `stella_0014_operation_tickets` | superusuario; `stella_0013` aplicado (precondición dura §0) | ídem | rol `uellix_cap_stella_ticket`; tabla `uellix_stella.operation_tickets` (8 CHECK, **cero** columnas de payload); índice parcial de reserva viva; función de transición + 2 triggers `ENABLE ALWAYS`; RLS con 3 policies (**sin DELETE**); **6** funciones `SECURITY DEFINER` | ninguno | **sí** | `stella_0014_rollback.sql` — **falla** si las funciones de `0015`+ siguen vivas (`DROP ROLE`) | **SÍ — supersedido por `0015`**: re-aplicarlo republicaría 4 firmas ciegas al proyecto | R2a: la reaplicación fuera de orden reabre el defecto de atribución |
| `stella_0015_project_bound_operation_tickets` | superusuario; `0013` + `0014` | ídem | **no crea rol/tabla/trigger/policy**: reemplaza 4 de las 6 funciones por firmas con `p_expected_project_id uuid` sin DEFAULT y **DROPea** las 4 antiguas. SQLSTATE `U0110` | ninguno | **no — sustituye** | `stella_0015_rollback.sql` — deja superficie **cerrada, no degradada**; no republica las firmas ciegas | **SÍ — supersedido por `0016`, `0017` y `0018`** | Postcondición: exactamente 6 funciones en `uellix_stella_ops` |
| `stella_0016_reserved_quota_semantics` | superusuario; `0013`…`0015`; **ausencia** de las firmas sin proyecto | ídem | 3 funciones nuevas en `uellix_stella` (`stella_capacity`, `consume_stella_capacity`, `settle_reserved_quota/5`); republica `bind`/`complete` **en el sitio**; columna `period_month` `GENERATED ALWAYS`; 4.ª policy; grant SELECT **por columna** excluyendo `charge_nonce` y `query_hash`. SQLSTATE `U0111` | ninguno | parcialmente (republica cuerpos) | `stella_0016_rollback.sql` — **DROPea** `bind`/`complete` en vez de revertirlos; **ningún cargo se borra** | **SÍ — supersedido por `0017` y `0018`** | Re-aplicar `0015` encima restaura la aritmética que cuenta sólo filas cobradas, **sin cambio de firma que lo delate** |
| `stella_0017_governed_stella_consumption` | superusuario; `0013`…`0016` | ídem | `REVOKE INSERT/UPDATE/DELETE/TRUNCATE ON stella_interactions` de 9 principales; **CHECK `stella_interactions_governed_identity_check` NOT VALID**; `settle_reserved_quota/10`; `complete_operation_ticket/7`. **7.ª** función | **impone constraint sobre el ledger** | **sí** | `stella_0017_rollback.sql` — **NO restaura la escritura directa y NO retira el CHECK**; §1 se niega si `stella_capacity` ya no existe | **SÍ** | «Lo que esto rompe, dicho en voz alta»: las 5 acciones hermanas y `scripts/seed-stella-local.ts` dejan de poder escribir el ledger |
| `stella_0018_category_bound_operation_tickets` | superusuario; `0013`…`0017` | ídem | `bind_operation_ticket/4` con capacidad esperada obligatoria (SQLSTATE `U0112`); la firma de 3 argumentos pasa a `U0106` y pierde `EXECUTE` para `uellix_app`; `REVOKE EXECUTE ON consume_stella_capacity FROM uellix_app`. **8.ª** función | ninguno | **sí** | `stella_0018_rollback.sql` | — (último de la cadena) | Cierra R6a (atribución falsa entre categorías, **medida**) y R6b (consumo sin ticket, **medido**, clasificado BLOCKER) |

### 1.3 Guards de orden (`db/prepared-package-order.ts`)

Ocho reglas de supersesión, ejecutadas por `applyPreparedScript` como
**precondición dentro de la misma transacción** que aplicaría el script, de
modo que la negativa hace rollback y las firmas inseguras no se publican ni un
instante (`DB_MIGRATOR_PACKAGE_ORDER_VIOLATION`):

| Paquete rechazado | Si está instalado | Qué republicaría |
|---|---|---|
| `stella_0014` | `stella_0015` | 4 firmas `SECURITY DEFINER` ciegas al proyecto, con `EXECUTE` para `uellix_app` |
| `stella_0015` | `stella_0016` | `bind`/`complete` con aritmética que cuenta sólo filas cobradas (R1) |
| `stella_0015` | `stella_0017` | ídem |
| `stella_0015` | `stella_0018` | bind de 3 argumentos autocontenido con `EXECUTE` a `uellix_app` (R6a) |
| `stella_0016` | `stella_0017` | `settle_reserved_quota/5` autocontenida junto a la de 10 argumentos |
| `stella_0016` | `stella_0018` | ídem + R6a |
| `stella_0017` | `stella_0018` | R6a |
| **`stella_0005c_rollback`** | `stella_0017` | `GRANT INSERT ON stella_interactions` a `authenticated` y `service_role` — la única regla cuyo `packageName` es un **rollback** |

> **Hueco operativo:** estos guards viven en `db/migrator.ts`, que solicita la
> capacidad `local_migration` — **loopback/contenedor únicamente**. Aplicando
> con `psql` a mano contra hosted, que es la única vía prevista
> (`README.md` regla 2), **los guards no corren**. El orden pasa a depender del
> operador y de las aserciones internas de cada paquete (que son fail-closed
> pero informan un número, no un motivo). Registrado como **MAJOR**.

### 1.4 Orden de rollback (inverso, y lo impone el SQL)

```
stella_0018 → 0017 → 0016 → 0015 → 0014 → 0013
grounding_0004 → grounding_0003 → grounding_0002
```

No es preferencia de runbook: las funciones nuevas son propiedad de roles de
capacidad, así que el `DROP ROLE` de un rollback anterior **falla** mientras
existan, y su transacción entera aborta sin destruir nada.

### 1.5b La cadena HOSTED (Train 5B) — qué se envía realmente

```
stella_hosted_0001_managed_role_bootstrap   ← sustituye a stella_0004 en hosted
   ├── grounding_0002 → grounding_0003 → grounding_0004   [unidad indivisible]
   └── stella_0013 → 0014 → 0015 → 0016 → 0017 → 0018
```

- **Archivos enviados:** `db/prepared/hosted/<paquete>.hosted.sql`, generados y
  versionados. `pnpm hosted:verify` los regenera y compara byte a byte.
- **Identidad de aplicación:** el rol administrativo del proyecto (`postgres`),
  que **no** es superusuario. `stella_0004` queda fuera de la cadena hosted por
  decisión, no por omisión: el planificador lo rechaza con
  `HOSTED_PACKAGE_NOT_IN_CHAIN`.
- **Precondición de sesión:** `SET uellix.bootstrap_environment = 'staging'`,
  sin default, comparación exacta.
- **Precondición en base:** la fila de `uellix_bootstrap.staging_sentinel`. La
  comprueba también `assert_hosted_capabilities()`, **dentro de la transacción**,
  para que un `psql` a mano no pueda saltársela.
- **Primera provisión = las diez.** El planificador rechaza un plan que incluya
  el bootstrap y se quede corto.

### 1.5 `grounding_0001` — NO APLICAR

Supersedido por `grounding_0003`. Se conserva byte a byte bajo banner. Si
alguien lo aplicó, `grounding_0001_rollback.sql` va **antes** de `grounding_0003`.

---

## 2. Fase 5 — Paquetes fuera de esta cadena

`stella_0002`, `0002b`, `0003` (alcance del G2 original) y `stella_0005`…`0005d`,
`0006`…`0012` (campaña de capacidades) **no forman parte de la cadena de
Train 5** y tienen sus propios gates y estados. `stella_0002/0002b/0003` son los
únicos que **no** exigen superusuario y que el `G2_PACKAGE.md` contempla aplicar
en un staging Supabase.

---

## 3. Fase 7 — R6h: el CHECK y los datos históricos

### 3.1 El contrato

`db/prepared/stella_0017_governed_stella_consumption.sql:355-367`:

```sql
ALTER TABLE public.stella_interactions
  ADD CONSTRAINT stella_interactions_governed_identity_check
  CHECK (idempotency_key IS NOT NULL) NOT VALID;
```

- **Columna exigida:** `stella_interactions.idempotency_key` — la crea
  `stella_0013`. Sobre una base sin `stella_0013` el CHECK ni siquiera es
  formulable.
- **Qué protege:** toda fila **nueva**. La identidad la acuña
  `issue_operation_ticket` y se deriva al cierre de un nonce que ninguna función
  devuelve, así que un llamante no puede producirla. Convierte «cada unidad fue
  cobrada por una función gobernada» en una propiedad **del dato**.
- **Por qué `NOT VALID`:** toda fila anterior al paquete fue escrita por el
  camino directo y **no lleva clave**. `NOT VALID` se aplica en cada `INSERT` y
  `UPDATE` desde el instante en que se añade — incluido **para el owner** (cosa
  que RLS no hace) y bajo `session_replication_role = replica` (cosa que un
  trigger no hace). Declina afirmar nada sobre el pasado y afirma algo absoluto
  sobre el futuro.
- **Complemento no obvio:** el CHECK es satisfecho por **cualesquiera 64
  caracteres hexadecimales** (`stella_0018` §0 lo concede). El control
  compensatorio real es la **superficie de grants** que `stella_0017` §1 retira
  — por eso `stella_0005c_rollback` está en el registro de supersesiones.

### 3.2 Qué datos históricos pueden incumplirlo

Toda fila de `stella_interactions` insertada **antes** de `stella_0017`:

- filas anteriores a `stella_0013` — la columna no existía;
- filas entre `0013` y `0017` escritas por el camino directo (`db.insert` desde
  las cinco acciones hermanas) — columna presente, valor `NULL`;
- filas sembradas por `scripts/seed-stella-local.ts`, que declara una fila sin
  clave (el propio paquete lo registra como trabajo pendiente de otra línea).

### 3.3 El conflicto con la premisa de la Fase 7

La instrucción pide «qué resultados permitirían `VALIDATE CONSTRAINT`».
**La respuesta correcta es: ninguno debe usarse para validarla.**

`stella_0017` §5 (4) —su propia autoverificación, dentro de la transacción de
aplicación— **aborta si encuentra la constraint validada**:

> `stella_0017 FAILED verification: stella_interactions_governed_identity_check
> is VALIDATED. Every row filed before this package carries no key, so a
> validated constraint means rows were removed from an append-only trail to
> make it pass`

Consecuencias operativas:

1. Ejecutar `VALIDATE CONSTRAINT` en staging **rompe la re-aplicabilidad y la
   verificación de `stella_0017`** en esa base.
2. Un resultado de auditoría con **cero** filas incumplidoras no autoriza a
   validar: sólo significa que esa base no tiene historia previa (típico de una
   base nueva). La constraint debe **permanecer `NOT VALID` igualmente**.
3. La instrucción prohíbe proponer borrar o sobrescribir historia, y el paquete
   coincide: la única forma de hacer pasar una validación sobre historia real
   sería borrar filas de un ledger append-only.

**Por tanto el criterio de la Fase 7 se reformula así:** la auditoría R6h no
decide si validar, sino **si aplicar `stella_0017` es seguro** y **qué queda
declarado como excepción documentada**.

| Resultado de la auditoría | Interpretación | Acción |
|---|---|---|
| Tabla `stella_interactions` inexistente o vacía | Base nueva | Aplicar la cadena. CHECK queda `NOT VALID`. Sin excepción que documentar |
| Filas presentes, **todas** con `idempotency_key IS NOT NULL` | Improbable salvo base ya gobernada | Aplicar. CHECK queda `NOT VALID` (§3.3.2). Registrar el conteo como evidencia |
| Filas presentes con `idempotency_key IS NULL` | **Caso esperado en cualquier base con historia** | Aplicar igual — el CHECK es `NOT VALID` justamente para esto. **Documentar la excepción**: N filas históricas fuera del régimen gobernado, conservadas íntegras, nunca modificadas |
| Filas con `stella_role` fuera de los 7 valores | Estado inconsistente previo | **ABORTAR.** `stella_0013` ampliaría el CHECK, pero un valor desconocido indica que la base no es la que el plan supone |
| La columna `idempotency_key` existe con tipo distinto de `char(64)` | Otro paquete la creó | **ABORTAR.** A5 de `G2_PACKAGE.md` (forma incompatible) |

### 3.4 Consultas de auditoría read-only preparadas — NO EJECUTADAS

Todas son `SELECT` puros, sin `FOR UPDATE`, sin CTE de escritura. Se ejecutan
con la capacidad `controlled_remote_read` (sesión forzada a solo lectura) o con
`psql` bajo `SET default_transaction_read_only = on`. **Ninguna imprime
contenido de filas: sólo conteos, tipos y bordes temporales.**

```sql
-- R6h-1 · ¿existe el ledger y cuántas filas tiene?
SELECT to_regclass('public.stella_interactions') AS ledger,
       (SELECT count(*) FROM public.stella_interactions) AS total_rows;

-- R6h-2 · ¿existe ya la columna, y con qué tipo?
SELECT column_name, data_type, character_maximum_length, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'stella_interactions'
  AND column_name  = 'idempotency_key';

-- R6h-3 · EL CONTEO QUE DECIDE (sólo si R6h-2 devuelve una fila)
SELECT count(*) FILTER (WHERE idempotency_key IS NULL)     AS ungoverned_rows,
       count(*) FILTER (WHERE idempotency_key IS NOT NULL) AS governed_rows,
       min(created_at) AS oldest_row,
       max(created_at) AS newest_row
FROM public.stella_interactions;

-- R6h-4 · ¿algún stella_role fuera de los 7 valores que la cadena admite?
SELECT stella_role, count(*) AS rows
FROM public.stella_interactions
WHERE stella_role NOT IN ('advisor','validator','composer',
                          'proxy_reviewer','evidence_reviewer',
                          'audit_assistant','grounded_query')
GROUP BY stella_role ORDER BY 2 DESC;

-- R6h-5 · ¿la constraint ya existe? ¿validada?
SELECT c.conname, pg_get_constraintdef(c.oid) AS definition, c.convalidated
FROM pg_constraint c
WHERE c.conrelid = 'public.stella_interactions'::regclass AND c.contype = 'c'
ORDER BY c.conname;

-- R6h-6 · ¿quién puede escribir hoy el ledger? (sigue la pertenencia de rol)
SELECT r.rolname,
       has_table_privilege(r.rolname, 'public.stella_interactions', 'INSERT') AS ins,
       has_table_privilege(r.rolname, 'public.stella_interactions', 'UPDATE') AS upd,
       has_table_privilege(r.rolname, 'public.stella_interactions', 'DELETE') AS del
FROM pg_roles r
WHERE r.rolcanlogin OR r.rolname IN ('authenticated','anon','service_role','PUBLIC')
ORDER BY 1;

-- R6h-7 · ¿RLS sigue activa? (segunda barrera contra COPY … FROM)
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid = 'public.stella_interactions'::regclass;
```

> `has_table_privilege` y **no** `relacl`: `stella_0017` §5 documenta que
> `uellix_app` tiene **cero** entradas propias en `relacl` y sin embargo puede
> insertar, por herencia de `uellix_writer`. Una verificación escrita sobre
> `relacl` reportaría la tabla limpia.

---

## 4. Fase 10 — Plan de aplicación por checkpoints

**Ninguno ejecutado.** Cada checkpoint termina en una decisión humana explícita
de Lorenzo; ningún agente avanza de uno al siguiente.

### CHECKPOINT A — Inspección hosted de SÓLO LECTURA

- **Precondición:** entorno de staging identificado con dos señales
  independientes (hoy **no satisfecha**).
- **Capacidad:** `controlled_remote_read` únicamente. Sesión forzada a solo
  lectura, TLS `verify-full`. **Nunca `service_role`.**
- **Escrituras permitidas:** **cero**.
- **Consultas:** versión (`server_version_num`), extensiones instaladas
  (`pg_extension`), roles (`pg_roles`, `pg_auth_members`), esquemas, funciones
  de `public` y `uellix_*`, tablas, `relrowsecurity`, `pg_policies`, las siete
  consultas R6h de §3.4, y **ausencia de objetos Stella conflictivos**
  (`uellix_stella`, `uellix_stella_ops`, `uellix_grounding`,
  `evidence_document_versions`, `evidence_chunks`, `operation_tickets`).
- **Criterio de avance:** `rolsuper` disponible para alguna identidad accesible
  **y** `server_version_num ≥ 170000` **y** ningún objeto conflictivo. Si
  `rolsuper` no está disponible — el caso conocido en Supabase gestionado — el
  checkpoint termina en **BLOCKED** y el plan no continúa.
- **Teardown:** ninguno (no crea nada).

### CHECKPOINT B — Ensayo de migración (rehearsal)

- **Destino:** clon, rama o base desechable **hosted**, jamás la base de
  staging designada. Si el proveedor no ofrece una, este checkpoint **no se
  sustituye por el ensayo local** — `LOCAL_STAGING_G2_REHEARSAL.md` ya existe y
  ya se ejecutó; su valor es responder «¿el script funciona?», no «¿funciona
  aquí?».
- **Secuencia:** aplicar la cadena en orden → verificar postcondiciones de cada
  paquete → rollback completo en orden inverso → re-aplicar → inventariar
  residuos (roles, esquemas, funciones, policies, entradas de `pg_default_acl`).
- **Criterio PASS:** las tres pasadas convergen y el inventario de residuos tras
  el rollback está vacío salvo lo que cada paquete declara que **no** revierte
  (`stella_0002b`, `stella_0017`, `grounding_0004`).
- **Teardown:** destruir el clon.

### CHECKPOINT C — Aplicación en staging

- **Precondición:** B en PASS + backup de staging verificado como restaurable
  por un humano + los nueve flags `STELLA_*` confirmados en `false` en **todos**
  los entornos que apunten a esa base.
- **Vía:** `psql "<staging>" -1 -v ON_ERROR_STOP=1 -f <script>`, un paquete por
  invocación, en orden. **El SQL Editor queda como último recurso** con
  verificación explícita de estado parcial.
- **Verificar:** roles y grants (con `has_table_privilege`, no `relacl`), RLS
  activo, policies por nombre y por rol, firmas exactas por `to_regprocedure`,
  conteos de funciones por esquema (6/7/8 según el punto de la cadena).
- **Flags:** siguen en `false`. **La aplicación de SQL no habilita nada.**
- **Criterio BLOCKED:** cualquiera de A1-A8 de `G2_PACKAGE.md`.

### CHECKPOINT D — E2E sin proveedor

- **Escrituras:** **sí**, datos de prueba en una organización sintética
  dedicada. Ninguna organización real.
- **Cobertura:** documentos → ingestión → retrieval → generador **extractivo**
  local (`createExtractiveAnswerProvider`) → tickets → cuotas → las siete
  categorías hermanas → observabilidad (`emitTicketEvent` contra allowlist).
- **Proveedor:** **cero llamadas**. `env -u GEMINI_API_KEY`, reafirmado dentro
  del proceso.
- **Verificación de cargo:** delta de filas de `stella_interactions` leído por
  una **segunda conexión**, distinta de la del runtime.
- **Teardown:** **problema conocido y sin solución limpia** — `stella_interactions`
  es append-only para todo rol incluido el owner, así que las filas del E2E
  **no se pueden borrar**. El teardown sólo puede retirar tickets, documentos y
  chunks. Registrado como **MAJOR** en el registro de riesgos: staging queda con
  historia sintética permanente en el ledger.

### CHECKPOINT E — Proveedor

- **Precondición dura:** rotación de ámbito staging completada y probada
  (Fase 3, hoy **BLOCKED**), secreto en el gestor del entorno, y G1 con firma
  humana.
- **Control:** una llamada, con `STELLA_REAL_EVAL_*` acks explícitos, pacing
  mínimo de 10 s, tope de llamadas igual al número de casos, sin reintentos.
- **A verificar:** límites de coste, timeout (`requestTimeoutMs = 15000`),
  taxonomía de errores, sanitización (`redactPii`), métricas, y **cero
  contenido sensible en logs** (auditar la salida real, no el código).

### CHECKPOINT F — Ensayo de rollback

- Confirmar los nueve flags en `false`; ejecutar la reversión en orden inverso;
  comprobar que los tres paquetes de rollback **no reversibles por diseño** se
  comportan como declaran (`stella_0002b`, `stella_0017`, `grounding_0004` con
  su `RAISE WARNING`); inventariar objetos residuales; probar la recuperación
  desde backup; archivar la evidencia.

---

## 5. Lo que este plan NO resuelve

1. ~~La cadena no es aplicable a Supabase gestionado~~ → **resuelto por Train 5B**
   (§1.5b). Lo que queda no es incompatibilidad sino verificación: RR-09,
   PostgreSQL ≥ 17 del proyecto y RR-03, todos CHECKPOINT A.
2. Los guards de orden **siguen sin correr por la vía `psql`** — pero el
   planificador hosted (`db/hosted/hosted-migrator.ts`) los evalúa contra el
   **mismo** registro antes de emitir el plan, y `assert_hosted_capabilities()`
   reimpone el centinela dentro de la transacción. Mitigado, no cerrado: un
   operador que ejecute los `.hosted.sql` a mano sin pasar por el planificador
   sigue sin las sondas de supersesión.
3. El teardown del CHECKPOINT D es incompleto por construcción (append-only).
4. `INT-GR-001`, `INT-GR-003` e `INT-PR-001` siguen pendientes — ver
   [`STELLA_STAGING_RISK_REGISTER.md`](STELLA_STAGING_RISK_REGISTER.md) §2.
5. **RR-02 no es cerrable** en Supabase gestionado: la separación owner/runtime
   es un obstáculo auditable, no una barrera.

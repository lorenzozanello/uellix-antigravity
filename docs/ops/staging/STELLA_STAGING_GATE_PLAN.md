# STELLA — Plan de gates para staging hosted

> Fase 9 de `STELLA_TRAIN_5A_HOSTED_STAGING_READINESS_AUDIT`. HEAD `2de1050`.
> **Ningún gate fue ejecutado por esta auditoría.**

---

## 0. Hallazgo estructural de esta fase

**Los paquetes que staging necesita no tienen gate.** `db/prepared/README.md`
registra, para cada uno de los ocho paquetes de Train 4/4.x, el literal
**«Gate: ninguno todavía»**:

`grounding_0002` · `grounding_0003` · `grounding_0004` · `stella_0013` ·
`stella_0014` · `stella_0015` · `stella_0016` · `stella_0017` · `stella_0018`

`G2_PACKAGE.md` cubre `stella_0002`/`0002b`/`0003` y, por addendum,
`grounding_0001` — que está **supersedido y marcado NO APLICAR**. Es decir: el
único paquete de grounding con gate documentado es precisamente el que no debe
aplicarse.

**Consecuencia:** antes de cualquier aplicación real hace falta un paquete de
gate nuevo. Se propone **G11 — Cadena Stella de tickets y grounding**
(§3), porque encajar nueve paquetes nuevos dentro de `G2_PACKAGE.md` obligaría a
reescribir un documento cuya evidencia ya está publicada — exactamente el
intercambio que el tren 4.2 rechazó al crear `stella_0002b` en vez de editar
`stella_0002`.

---

## 1. Leyenda de clasificación

| Clase | Significado |
|---|---|
| **RO** | puramente read-only |
| **W-test** | escribe datos de prueba, con teardown |
| **DDL** | aplica SQL / cambia estructura |
| **PROV** | llama al proveedor generativo |
| **RB** | exige ensayo de rollback |

---

## 2. Gates existentes

### G1 — Evaluación real del advisor con proveedor

| Campo | Contenido |
|---|---|
| **Objetivo** | Primera evaluación del advisor contextual contra Gemini real, sobre el catálogo oficial de 28 casos, en dos etapas (canary 1-7 → full 28) |
| **Clase** | **PROV** (+ escritura local de artefactos) |
| **Comandos** | `pnpm tsx tests/eval/stella-contextual-real/run.ts --dry-run` (única etapa ejecutable por agente) → `--run-label g1-canary --case-id …` → `--run-label g1-full` → `--resume <dir>` |
| **Infraestructura** | Ninguna base de datos. Sólo red hacia el proveedor |
| **Escrituras permitidas** | Sólo `artifacts/stella-contextual-real-runs/`. **Cero** escrituras a base de datos o a cualquier sistema remoto |
| **Proveedor** | **SÍ.** `STELLA_REAL_EVAL_ACK=B1C_CURRENT_ARCHITECTURE_REAL_EVAL`, `STELLA_PROVIDER_MODE=paid_gemini`, `GEMINI_API_KEY`, más el ack de subset o de full. Pacing ≥ 10 000 ms |
| **Evidencia** | `run-manifest.json`, `run-state.json`, artefactos crudos y decodificados, resumen JSON |
| **Teardown** | Ninguno necesario (read-only respecto de datos de producto). Descartar = borrar el directorio del run |
| **PASS** | A1-A9 del paquete, **todos** binarios: `providerCalls = 28`, `schemaInvalidCases = 0`, `invalidIndexes = 0`, `safetyScore = 2`, `adversarialCasesPassed = 7`, `requiresHumanReviewCases = 28`, `eligibleForGate = false` (hardcodeado: el run **nunca** se auto-aprueba) **más** veredicto humano escrito |
| **BLOCKED** | Cualquier NO. Además: precondición P7 (clave válida y no filtrada) — hoy **no satisfecha para ámbito staging**, ver readiness §2 |
| **Estado** | Sólo el dry-run offline ejecutado (2026-07-31, `providerCalls: 0`). Firma humana en blanco |

### G2 — Paquete maestro de base de datos

| Campo | Contenido |
|---|---|
| **Objetivo** | Aplicar y saber revertir `stella_0002` → `0002b` → `0003` contra **staging**, nunca producción directamente |
| **Clase** | **DDL + RB** |
| **Comandos** | `psql "$STAGING_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f db/prepared/<script>.sql`; alternativa `supabase db execute --file`; último recurso SQL Editor |
| **Infraestructura** | Base de staging + backup verificado |
| **Escrituras** | **DDL sobre estructura.** Ningún dato de producto se modifica |
| **Proveedor** | No |
| **Evidencia** | Siete verificaciones post-aplicación; el `NOTICE` `write path VERIFIED against declared writer role …` (si dice `ASSUMPTION`, **el gate no está verificado**) |
| **Teardown** | Rollbacks preparados. `stella_0002b_rollback` es **deliberadamente NO reversible** (`SAFE_NON_REVERSING_ROLLBACK`) |
| **PASS** | Las 7 verificaciones en verde + writer role declarado y verificado |
| **BLOCKED** | A1-A8: host equivocado, backup no verificable, migraciones base ausentes, flag encendido, forma incompatible, fallo post-apply, estado parcial, decisión G5 ausente |
| **Estado** | No ejecutado. `stella_0004` explícitamente **fuera de G2 remoto** por RR-09/RR-03/RR-02 |
| **Nota** | **No cubre la cadena de Train 4/4.x.** Ver §0 y §3 |

### G3 — Verificación RLS

| Campo | Contenido |
|---|---|
| **Objetivo** | Comprobar con la suite de integración que la postura RLS/grants de las tablas Stella es la declarada; primero local, después staging |
| **Clase** | **W-test** (la suite abre transacciones y hace ROLLBACK) |
| **Comandos** | `pnpm test:rls` — ningún agente lo ejecuta; exige base real y credenciales de Lorenzo |
| **Dependencia** | G2 aplicado |
| **PASS** | Suite verde contra staging con los skips volteados |
| **BLOCKED** | Cualquier caso RLS en rojo |

### G4 — Rollout de roles Stella (activación de flags)

| Campo | Contenido |
|---|---|
| **Objetivo** | Habilitar los seis roles **de uno en uno**, en orden `validator → advisor → composer → proxy_reviewer → evidence_reviewer → audit_assistant` |
| **Clase** | **PROV** (activa tráfico real) |
| **Comandos** | Ninguno de repositorio: se fija la env var en Vercel (**Preview primero**, una ventana, luego Production) y se hace *Redeploy* del último build verde |
| **Infraestructura** | Deployment + base con G2/G3 aplicados + proveedor |
| **Escrituras** | Reales, de usuarios reales |
| **Proveedor** | **SÍ** |
| **Evidencia** | Ventana de observación ≥ **72 h** o ≥ 20 interacciones reales del rol, lo que llegue después. Métricas: volumen por `stella_role`, mezcla de errores, distribución de `risk_level`, consumo de cuota, hits del guard numérico, feedback humano |
| **Teardown / rollback** | **Flag a `false` + redeploy.** Sin migración de datos, sin cambio de código |
| **PASS** | P1-P7 globales + precondición del rol + ventana estable. `advisor` exige **G1 aprobado**; los offline por sí solos no lo despejan |
| **BLOCKED** | Errores > 10 % de las llamadas del rol; lenguaje de certificación; cifras inventadas; salida no española |
| **No negociable** | Nunca dos flags en la misma ventana. Las cuotas siguen mandando: las organizaciones arrancan en **0** pase lo que pase con los flags |
| **Estado** | Ningún flag cambiado. Tabla de firmas en blanco |

### G7 — Revisión legal

| Campo | Contenido |
|---|---|
| **Objetivo** | Revisión por asesor legal externo de los términos que **Stella** añade sobre la base legal existente |
| **Clase** | **RO** — no toca infraestructura |
| **Comandos** | Ninguno. Es un checklist para un humano externo |
| **Infraestructura** | Ninguna |
| **Escrituras** | Ninguna |
| **Proveedor** | No |
| **Evidencia** | Determinación de idoneidad firmada, archivada para el tren correspondiente |
| **Teardown** | N/A |
| **PASS** | Checklist completo con firma del asesor |
| **BLOCKED** | Ausencia de firma. `local-release-gate.ts:561` lo enumera explícitamente entre las razones de `hosted-blocked` |
| **Estado** | Paquete creado 2026-07-31; sin determinación firmada |

### G5, G8, G9, G10 (contexto)

| Gate | Objetivo | Clase | Estado |
|---|---|---|---|
| **G5** | Decisión P3 sobre formatos binarios y pgvector | RO (decisión) | Abierta. **No bloquea la cadena vigente**: `grounding_0003` es pgvector-free por diseño |
| **G8** | Smoke funcional en un deployment Preview | PROV | Definido, no ejecutado |
| **G9** | Calibración del modelo de costo contra facturación real | RO sobre billing | Definido; ejecutable sólo tras G1 y G8 |
| **G10** | Declaración PRODUCTION_READY / piloto | RO (decisión humana) | Depende de G1-G9 con evidencia real + aprobación explícita de Lorenzo |

---

## 3. Gates nuevos que Train 5 requiere

### G11 — Cadena Stella de tickets y grounding (PROPUESTO, no existe)

| Campo | Contenido |
|---|---|
| **Objetivo** | Aplicar y saber revertir `stella_0004` → (`grounding_0002/0003/0004`) + (`stella_0013…0018`) contra staging |
| **Clase** | **DDL + RB** |
| **Comandos** | `psql "<staging>" -1 -v ON_ERROR_STOP=1 -f <script>`, un paquete por invocación, en el orden de `db/prepared-package-order.ts` |
| **Infraestructura** | PostgreSQL **17+** **con superusuario** + backup verificado |
| **Escrituras permitidas** | DDL. `stella_0013` además **altera** `stella_interactions` (columna nullable nueva) y `stella_0017` **le impone una constraint** |
| **Proveedor** | No |
| **Evidencia** | Las autoverificaciones de cada paquete + conteos de funciones por esquema (6/7/8) + `has_table_privilege` exhaustivo sobre `pg_roles` + `pg_policies` por nombre y rol |
| **Teardown** | Rollbacks en orden inverso estricto. Tres **no revierten por diseño**: `stella_0017` (no restaura la escritura directa ni retira el CHECK), `grounding_0004` (revertirlo **reabre INT-CAP-002**, con `RAISE WARNING`), `stella_0002b` |
| **PASS** | Cadena aplicada en orden, cada autoverificación en verde, cero firmas ciegas al proyecto (`PROJECT_BLIND_SIGNATURES_PRESENT_PROBE` devuelve `false`), CHECK R6h presente y **`NOT VALID`**, RLS activa |
| **BLOCKED** | `rolsuper` no disponible · `server_version_num < 170000` · `stella_0004` no aplicable (RR-09) · cualquier objeto Stella preexistente con forma incompatible · cualquier flag `STELLA_*` en `true` · guard de orden disparado |
| **Riesgo propio del gate** | Aplicando con `psql` a mano, `assertPreparedPackageOrder` **no corre** — vive en `db/migrator.ts`, que exige la capacidad `local_migration`. El orden queda a cargo del operador |

### G12 — Inspección hosted de sólo lectura (PROPUESTO)

| Campo | Contenido |
|---|---|
| **Objetivo** | Responder, sin escribir nada, si el entorno hosted puede recibir la cadena |
| **Clase** | **RO estricto** |
| **Comandos** | Las consultas de catálogo del CHECKPOINT A + las siete R6h de `STELLA_STAGING_MIGRATION_PLAN.md` §3.4 |
| **Infraestructura** | Conexión `controlled_remote_read`, sesión solo lectura, TLS `verify-full`. **Nunca `service_role`** |
| **Escrituras permitidas** | **Cero.** Un solo `INSERT`/`CREATE`/`SET` persistente invalida el gate |
| **Proveedor** | No |
| **Evidencia** | Un informe con: versión, extensiones, roles, esquemas, funciones, tablas, RLS, policies, conteos R6h, inventario de objetos conflictivos |
| **Teardown** | N/A |
| **PASS** | Informe completo **y** `rolsuper` disponible **y** PG ≥ 17 **y** cero objetos conflictivos |
| **BLOCKED** | Cualquier ausencia de las anteriores. Hoy: **BLOCKED por ausencia de entorno** |

### G13 — E2E de staging sin proveedor (PROPUESTO)

| Campo | Contenido |
|---|---|
| **Objetivo** | Ejercitar el recorrido completo contra staging con el generador **extractivo** local |
| **Clase** | **W-test** |
| **Comandos** | Adaptación de `scripts/stella-ticket-e2e.sh` y `stella-multicategory-quota-e2e.sh` al destino de staging |
| **Escrituras permitidas** | Sólo en una organización sintética dedicada |
| **Proveedor** | **NO.** `env -u GEMINI_API_KEY`, reafirmado dentro del proceso |
| **Evidencia** | 18 casos multicategoría + lectura del ledger por **segunda conexión**, columna a columna |
| **Teardown** | **Parcial e irreparable por diseño**: `stella_interactions` es append-only para todo rol incluido el owner. Las filas del E2E **quedan**. Sólo se retiran tickets, documentos y chunks |
| **PASS** | `ΔConsumed + LiveReserved <= hueco` tras **cada** escenario; observabilidad contra allowlist; cero escrituras directas aceptadas |
| **BLOCKED** | Cualquier cargo no explicado por un ticket |

---

## 3b. Gates LOCALES de Train 5B (implementados y verdes)

`tests/eval/stella-release/hosted-release-gate.ts`. Los siete son puramente
**RO**: leen el repositorio, no contactan nada. Ninguno puede declarar staging
aplicado, hosted listo ni proveedor listo — los tres campos están **hardcodeados
`false`**, con el mismo precedente que `stagingBlocked`/`hostedBlocked` en
`local-release-gate.ts`.

| Gate | Qué mide | Control negativo que lo mata |
|---|---|---|
| `hosted-capability-preflight-ready` | el bootstrap sonda las 10 capacidades concretas por nombre | renombrar `rolcreaterole` |
| `managed-role-bootstrap-ready` | 5 roles sin atributo peligroso; `service_role` nunca como grantee; **se niega si hay superusuario** | inyectar `BYPASSRLS`, un `GRANT … TO service_role`, un `CREATE ROLE … CREATEROLE`, o quitar la refusal de superusuario |
| `hosted-package-manifest-ready` | los 10 artefactos regeneran byte a byte desde su fuente fijada | marcar un artefacto como divergente |
| `hosted-package-order-ready` | el planificador hosted usa las **mismas 8** reglas de supersesión | bajar el conteo a 7 |
| `staging-target-identity-ready` | host de producción y centinela ausente son rechazos con código propio; **un solo contrato de identidad para los dos modos de conexión** (directo y session pooler), con los catorce ataques de `tests/hosted/identity-contract.test.ts` | desactivar cualquiera de los dos, o aceptar el host del pooler sin su rol de login |
| `hosted-migrator-dry-run-ready` | un dry-run planifica los 10 pasos y **no permite escrituras** | permitir escrituras, o 9 pasos |
| `r6h-audit-ready` | el `stella_0017` generado conserva el CHECK `NOT VALID` y su aborto ante VALIDATED; ningún artefacto emite `VALIDATE CONSTRAINT` | desactivar cualquiera de los dos |

Además, la suite comprueba que el constructor de evidencia **no es un sello de
goma**: lee el bootstrap real y ejecuta un dry-run real.

## 3c. Gates LOCALES de Train 5C0 — el BASELINE (implementados y verdes)

`tests/eval/stella-release/hosted-baseline-gate.ts`. Módulo **separado** de
`hosted-release-gate.ts` a propósito: aquél cubre la cadena Stella, éste cubre
las 50 unidades que deben aterrizar antes de que la cadena exista. Fundirlos
produciría un verde que podría significar cualquiera de las dos mitades.

Los seis son **RO**. Ninguno puede declarar `baselineApplied`, `stagingApplied`,
`hostedReady` ni `providerReady`: los cuatro están **hardcodeados `false`**, y un
test los comprueba incluso con todos los gates rotos.

| Gate | Qué mide | Control negativo que lo mata |
|---|---|---|
| `hosted-baseline-manifest-ready` | 50 unidades, cada una con hash SHA-256 **y** un escaneo estructural esperado | editar un byte (`SHA_MISMATCH`); o editar y actualizar el pin introduciendo un `GRANT … TO service_role` (`SCAN_MISMATCH` además del hash) |
| `hosted-baseline-order-ready` | orden determinista, **y el verificador fue observado refutando una mutación** | subir `db/policies/008` por encima de `0035`; subir `0039` por encima de la unidad que define sus funciones |
| `hosted-baseline-managed-compatible` | cero superusuario / roles / ownership / extensiones en las 50; exactamente un *grantee* de `service_role`; exactamente una unidad con DML y **cero** filas literales | introducir `rolsuper`, un `ALTER ROLE`, un `INSERT … VALUES`, o una segunda unidad con `service_role` |
| `hosted-baseline-rehearsal-ready` | un ensayo **ejecutado** contra este manifiesto exacto: `artifacts/baseline-rehearsal/latest.json` con `manifestDigest` coincidente, RUN A abortando en 0039, RUN B aplicando las 50, B0 limpia | editar el manifiesto sin re-ensayar (el digest deja de coincidir); un RUN A que **no** falle |
| `hosted-baseline-postconditions-ready` | 15 postcondiciones, **cada una observada fallando su propio control negativo ejecutable**, y toda sonda de sólo lectura | hacer que un `check()` devuelva `passed: true` — pasaría su propia mutación y mataría el gate |
| `hosted-baseline-recovery-ready` | un error a mitad de baseline responde `DESTROY_AND_REPROVISION`; sin `psql -1` responde `HALT_AND_ESCALATE`; el runner se niega a escribir el centinela | cambiar cualquiera de las tres respuestas |

El punto no obvio es el quinto. Una postcondición que ignorase su entrada
aprobaría **cualquier** observación, incluida su propia mutación — así que
correr las trece contra su estado roto es lo que separa una comprobación de un
párrafo. Si alguien «arregla» un check devolviendo `true`, este gate cae.

> **Límite declarado del cuarto gate.** El ensayo local es una prueba de
> **regresión** y una **reproducción del defecto**, jamás evidencia de
> compatibilidad con Supabase gestionado. El stack local aplica
> `supabase/migrations/**` al arrancar, que es exactamente lo que ocultó el
> defecto de orden de 0039 durante un año. Y el shim del ensayo crea los esquemas
> `auth` y `storage` **como objetos nuestros**, de modo que toda pregunta de
> privilegio que el apply hosted enfrentará de verdad se responde ahí
> trivialmente y mal. El propio ensayo imprime la lista de lo que shimea.
>
> **El E2E de Train 4 tampoco es evidencia del baseline.**
> `scripts/stella-ticket-e2e.sh` restaura `db/baseline/**`, que es un `pg_dump`
> de una base Supabase **anterior a la campaña de capacidades**, con esquemas,
> propietarios y conteos distintos de los que producen las 50 unidades. Se
> ejecutó en este train (37/37 y 25/25, con teardown limpio) y vale como
> regresión **de Train 4**. Citarlo como regresión del baseline sería validar una
> forma de esquema que las 50 unidades no producen.

## 3d. El gate de autorización de escritura — Train 5C1

`db/hosted/baseline-apply-authorization.ts`. **Uno solo**, y es el que decide si
la primera escritura hosted puede autorizarse:

**`hosted-baseline-apply-authorized`**

Once criterios, cada uno con control negativo **ejecutable**:

| Criterio | Fuente | Control negativo |
|---|---|---|
| `checkpoint-a0-pass` | atestación con consulta y procedencia | un A0 con una sola escritura |
| `production-denylist-loaded` | `productionDenylistStatus()` | lista de refs vacía |
| `target-identity-corroborated` | atestación + una segunda señal **independiente de la declaración**: `projectRefFromHost` por conexión directa, `projectRefFromPoolerUser` por session pooler | un host, o un rol de login, que nombra otro proyecto |
| `class-c-probes-affirmative` | atestación de §2.7 | `ownsStorageObjects: false` |
| `manifest-hashes-and-order` | derivado del corpus | una unidad con un byte de deriva |
| `no-class-d-units` | lista de unidades **inyectada** | una unidad clasificada clase D |
| `zero-production-data` | derivado del corpus | una unidad que gana un `INSERT … VALUES` |
| `no-service-role-widening` | derivado del corpus | una segunda unidad que concede a `service_role` |
| `feature-flags-false` | atestación | un flag en `true` |
| `postconditions-ready` | las 15 contra su propia mutación | corpus que deriva a nada |
| `recovery-plan-conservative` | función de recuperación **inyectada** | tabla que responde `RETRY_UNIT` a todo |

Dos notas que no son cosméticas.

**Ausencia = refutación, en los cuatro campos atestados.** `null` significa «no
medido», y no medido no es satisfecho. Es la misma regla que Train 5B aprendió
con `installedProbes` fallando abierto y 5C0 volvió a aprender con un conjunto de
vacuidad que sólo miraba las tablas que le pasaban.

**Los dos criterios inyectables lo son por falsabilidad, no por
configurabilidad.** `no-class-d-units` y `recovery-plan-conservative` razonaban
sobre constantes de módulo, así que ninguna entrada podía hacerlos fallar: la
primera pasada del barrido de controles negativos los encontró pasando su propia
mutación. Un criterio que lee una constante es decorativo por construcción.

> **Este gate no significa `baselineApplied`.** Significa que nada de lo
> conocido se interpone, y que un humano —Lorenzo— puede ahora elegir ejecutar
> `PHASE_BASELINE`. Los cuatro campos `baselineApplied`, `stagingApplied`,
> `hostedReady` y `providerReady` siguen **hardcodeados `false`**.

**Estado a 2026-08-07: NO AUTORIZADO.** Un test ejecutable lo fija.

`production-denylist-loaded` **pasó a satisfecho** al cerrarse P5: la denylist
lleva el ref productivo `ctaxtgujyyprgynmnvtq` y el de staging
`bvyzblhqymxruxdguaee` está deliberadamente fuera de ella.

Siguen refutando cinco, y los cinco por la misma razón — **atestaciones que aún
no existen**, porque las tres sondas §2.7 las ejecuta el operador a mano:

| Criterio | Qué falta |
|---|---|
| `checkpoint-a0-pass` | A0 pasó, pero no está registrado como atestación con consulta y procedencia |
| `target-identity-corroborated` | el ref de staging está fijado en código; falta la atestación de la invocación |
| `class-c-probes-affirmative` | las tres sondas, con su SQL literal |
| `feature-flags-false` | inventario de los nueve flags del entorno que apunta al objetivo |
| `zero-production-data` | depende de que A0 esté atestado |

Los seis que el repositorio puede establecer por su cuenta están satisfechos.

## 4. Orden y dependencias

```
[Train 5C0, local] baseline-manifest / order / managed / rehearsal /
                   postconditions / recovery  ─── todos verdes, cero escrituras
  └── G12 (RO hosted)  ═ CHECKPOINT A0, PASS manual del operador 2026-08-07
        └── PHASE_BASELINE (50 unidades)  →  CHECKPOINT B0 (RO)
              └── PHASE_STELLA_BOOTSTRAP  →  centinela humano  →  CHECKPOINT A1 (RO)
                    └── G11 apply (cadena Stella)
G12 (RO hosted)
  └── G11 rehearsal (base desechable)
        └── G2 (0002/0002b/0003)  ──┐
        └── G11 apply (cadena)     ──┼──> G3 (RLS)
                                     │
                                     └──> G13 (E2E sin proveedor)
                                                └── [rotación de clave de staging]
                                                      └── G1 (proveedor real)
                                                            └── G4 (flags, un rol por ventana)
                                                                  └── G8 → G9 → G10
G7 (legal) corre en paralelo, sin dependencias técnicas.
```

## 5. Resumen por clase

| Gate | RO | W-test | DDL | PROV | RB |
|---|:--:|:--:|:--:|:--:|:--:|
| G1 | | | | ✔ | |
| G2 | | | ✔ | | ✔ |
| G3 | | ✔ | | | |
| G4 | | | | ✔ | ✔ (flag off) |
| G5 | ✔ | | | | |
| G7 | ✔ | | | | |
| G8 | | ✔ | | ✔ | |
| G9 | ✔ | | | | |
| G10 | ✔ | | | | |
| **G11** | | | ✔ | | ✔ |
| **G12** | ✔ | | | | |
| **G13** | | ✔ | | | |

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

## 4. Orden y dependencias

```
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

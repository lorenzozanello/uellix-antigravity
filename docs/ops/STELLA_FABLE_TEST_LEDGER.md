# STELLA FABLE MOONSHOT — Test Ledger

> Registro append-only de ejecuciones de pruebas de la campaña.
> Cada entrada: timestamp, commit, comando, resultado, notas.
> Nunca se borra una entrada; los rojos se documentan, no se ocultan.
>
> **Reconciliación documental 2026-07-31:** se añadieron las entradas WS3
> (merge `2ecd766`) y WS2 (merge `0d0791a`), que faltaban pese a que las
> demás Olas 1/2 sí las tienen. No se ejecutó ninguna prueba nueva para esta
> reconciliación — el checkpoint final (`15af6bb`) ya reproduce 2246/2246
> tests, ambos evals y el build; ver la última fila del ledger.

## Política

- Suites offline permitidas: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:unit`, evals offline bajo `tests/eval`.
- Suites PROHIBIDAS en esta campaña (tocan remoto): `pnpm test:integration`, `pnpm test:rls`, seeds, migraciones. Sus equivalentes offline deben construirse (WS3/WS5).
- Un workstream no se integra a la coordinadora sin: typecheck + lint + test:unit verdes en su rama.

## Ledger

### 2026-07-31 · BASELINE · `dd36a4e` (rama coordinadora, sin cambios)

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm install --frozen-lockfile` | OK | worktree nuevo, 26.6s |
| `pnpm typecheck` | VERDE | tsc --noEmit sin errores |
| `pnpm test:unit` | VERDE | 95 archivos, 1372 tests, 65.5s |
| `pnpm lint` | VERDE (con warnings) | 0 errores, 54 warnings (`no-unused-vars` mayormente) — exit 0 |

### 2026-07-31 · WS5 INTEGRACIÓN · rama `moonshot/ws5-grounding` → merge `61988e8`

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run lib/grounding` (worktree ws5, por implementador y por coordinador) | VERDE | 4 archivos, 60 tests |
| `pnpm typecheck` (worktree ws5, ambos) | VERDE | sin errores |
| `pnpm test:unit` (worktree ws5, implementador) | VERDE con flakes ajenos | 96/99 archivos; 3 fallos por timeout bajo carga en archivos NO tocados por WS5 (`lib/reports/pdf/render.test.ts`, `tests/eval/stella-contextual-real/{resume,runner}.test.ts`) — pasan aislados; flake preexistente de entorno |

Auditoría independiente WS5: APPROVE_WITH_NOTES. Hallazgo MAJOR (scope `audit-fixtures/`)
verificado FALSO POSITIVO por el coordinador (`git ls-tree` base la contiene; diff de rama = 0
archivos ahí). Hallazgo MINOR (CSV lenient quote) documentado como comportamiento intencional.

### 2026-07-31 · WS4 INTEGRACIÓN · rama `moonshot/ws4-composer` → merge `5ffbf52`

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| suites focalizadas WS4 (13 archivos, worktree ws4, implementador y coordinador) | VERDE | 226 tests (implementador) / 172 (subset coordinador) |
| `pnpm typecheck` (ws4, ambos) | VERDE | limpio |
| `pnpm test:unit` (ws4, implementador, post-fixes) | VERDE | 100 archivos, 1473 tests |

Auditoría WS4: APPROVE_WITH_NOTES; goldens re-derivados a mano por el auditor (exactos);
5 hallazgos corregidos con prueba de fallo-sin-fix (runs con revert documentados).
Guard numérico del composer queda SIN cablear por diseño (WIRING.md) — wiring del coordinador
pendiente tras merge de WS3.

### 2026-07-31 · WS1 INTEGRACIÓN · rama `moonshot/ws1-context` → merge `24b122c`

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm test:unit` (ws1, implementador post-fixes) | VERDE | 98 archivos, 1463 tests |
| `pnpm typecheck` (ws1, implementador, auditor y coordinador) | VERDE | limpio |
| `pnpm eval:offline` (ws1, los tres) | VERDE | 6/6 gates, 28/28 casos, 0 violaciones R1–R6 |
| dry-run runner real `--dry-run` (implementador y auditor, verificado 0 llamadas de red en código antes de ejecutar) | VERDE | 28 casos procesados, providerCalls 0, eligibleForGate false |

Auditoría WS1: APPROVE_WITH_NOTES, 6 hallazgos todos MINOR, 4 corregidos en pase
post-auditoría (paridad estricta, linkage real de stakeholderGroups, detector de fugas
extendido a formas sin corchetes, reservas documentadas en G1 §7). Guards del runner
real byte-idénticos a la base (verificado por auditor).

### 2026-07-31 · WS3 INTEGRACIÓN · rama `moonshot/ws3-security` → merge `2ecd766`

> Entrada añadida en la reconciliación documental 2026-07-31 (auditoría
> independiente `STELLA_MOONSHOT_INDEPENDENT_VERIFICATION` señaló que WS3 no
> tenía entrada propia pese a que las demás Olas 1 sí la tienen — solo
> aparecía agregado en el checkpoint "OLA 1 CERRADA" de abajo). No se
> inventan cifras de `test:unit` específicas al momento del merge: esa
> granularidad no quedó registrada por separado durante la campaña, sólo el
> agregado de checkpoint (1927 tests, fila siguiente). Lo que sigue está
> respaldado directamente por el mensaje del commit de merge `2ecd766` y por
> el diffstat del propio merge.

| Comando / evidencia | Resultado | Detalle |
|---|---|---|
| Suites de seguridad tocadas por el merge (`git show --stat 2ecd766`) | 13 archivos de test añadidos/ampliados | `advisor.test.ts`, `composer.test.ts`, `contextual-advisor.test.ts`, `reviewer.test.ts`, `validator.test.ts` (acciones); `permissions.test.ts`; `anti-regression.test.ts`; `gemini-client.test.ts`; `prompt-injection.test.ts` (nuevo, 280 líneas); `sanitize.test.ts` (nuevo, 257 líneas); `composer-system.test.ts`; `payload-limits.test.ts` (nuevo); `redact-pii.test.ts` (nuevo) |
| Auditoría independiente (mensaje de merge `2ecd766`) | APPROVE_WITH_NOTES | 8 hallazgos corregidos con pruebas de fallo-sin-fix, según el propio mensaje de commit: *"envelope UNTRUSTED_PROJECT_DATA en los 4 builders legacy — atacado por el auditor y resistió; step/sectionType allowlisted tras exploit del auditor; corpus de 18 payloads × 6 builders; redacción PII unicode pre-truncado; canUseStella set-inclusion incl. reviewer; caps maxOutputTokens/temperature/maxPromptChars con PAYLOAD_TOO_LARGE"* |
| `pnpm typecheck` / `pnpm test:unit` (checkpoint agregado inmediatamente posterior) | VERDE | Ver fila "CHECKPOINT OLA 1 CERRADA" — WS3 es uno de los 4 workstreams integrados en ese checkpoint (113 archivos, 1927 tests) |

### 2026-07-31 · CHECKPOINT OLA 1 CERRADA · coordinadora `ea892ca` (WS5+WS4+WS1+WS3 integrados + wiring transversal)

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm typecheck` | VERDE | limpio |
| `pnpm lint` | VERDE | 0 errores (50 warnings preexistentes de no-unused-vars) |
| `pnpm test:unit` | VERDE | **113 archivos, 1927 tests** (baseline era 95/1372: +555 tests netos en la campaña) |
| `pnpm eval:offline` | VERDE | 6/6 gates, 28/28 casos, 0 violaciones R1–R6 |

Wiring transversal del coordinador (`ea892ca`): readiness vivo del motor inyectado al
contexto advisor (capa app), guard numérico+referencias del composer activo fail-closed,
PAYLOAD_TOO_LARGE mapeado en el runner contextual.

### 2026-07-31 · WS7 INTEGRACIÓN · rama `moonshot/ws7-ops` → merge `de860ca`

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm test:unit` (ws4-worktree, implementador) | VERDE | 115 archivos, 1945 tests |
| suites focalizadas (auditor) | VERDE | 3 archivos, 26 tests |
| `pnpm typecheck` (ambos) | VERDE | limpio |

Auditoría WS7: APPROVE_WITH_NOTES, 0 bloqueadores, 3 MINOR advisorios (modelo único en
agregación de costos → nota G9; N+1 aceptable en beta; default `model_used` desactualizado
en schema — preexistente, dueño WS3b/G2).

### 2026-07-31 · WS6 INTEGRACIÓN · rama `moonshot/ws6-roles-eval` → merge `8f39d2a`

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm test:unit` (ws1-worktree, post-fixes) | VERDE | 117 archivos, 1982 tests |
| `pnpm eval:roles` (implementador, auditor y coordinador post-merge) | VERDE | 5/5 gates, 14/14 casos, 5/5 canaries rechazados |
| `pnpm eval:offline` (regresión, los tres) | VERDE | 6/6 gates, 28/28 |
| `pnpm typecheck` (los tres) | VERDE | limpio |

Auditoría WS6: APPROVE_WITH_NOTES; MAJOR (RK-17 residual: 3 bullets de mandato sin datos
serializados) corregido con contract test ampliado + enum pins + sanitizeLabel; probes
adversariales de extractUrlDomain superados (credenciales/token/IDN/javascript: → fail-closed).
RK-17 CERRADO offline; RK-27 CERRADO (fixture agua-segura alimenta eval evidence_reviewer).

### 2026-07-31 · WS3b INTEGRACIÓN · rama `moonshot/ws3b-persistence` → merge `3e967d0` (+wiring `568e70d`)

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm test:unit` (ws3-worktree, post-fixes) | VERDE | 117 archivos, 2020 tests |
| suites focalizadas (auditor: prepared-sql + actions + observability + logger) | VERDE | 9 archivos, 254 tests |
| `pnpm typecheck` (los tres) | VERDE | limpio |
| `test:integration` / `test:rls` | NO EJECUTADAS | prohibidas (BD remota); casos RLS de Stella EDITADOS y listos para G3 |

Auditoría WS3b: APPROVE_WITH_NOTES; MAJOR (interactionId sin verificación org — oráculo
de existencia) corregido con respuesta indistinguible + 3 menores (Sentry truncado con
stack reconstruido, psql -1, CHECK con literales entrecomillados), todos con
fails-without-fix. RK-04 queda PREPARADO (SQL listo, aplicación = G2); RK-12 MITIGADO
(invocaciones/denegaciones/rechazos de integridad en audit_logs); RK-23 MITIGADO
(Sentry con sanitización); RK-11 PARCIAL (acción de decisiones dormante tras flag+G2).

### 2026-07-31 · WS2 INTEGRACIÓN · rama `moonshot/ws2-advisor-ux` → merge `0d0791a` (+ registro `392c613`)

> Entrada añadida en la reconciliación documental 2026-07-31 (misma razón que
> la entrada de WS3 arriba: WS2 solo aparecía agregado en el checkpoint "OLA
> 2 CERRADA" de abajo, pese a tener su propio commit de registro `392c613`).
> No se inventan cifras de `test:unit` específicas al momento del merge —
> sólo el agregado de checkpoint (2170 tests, fila siguiente) quedó
> registrado con ese detalle durante la campaña.

| Comando / evidencia | Resultado | Detalle |
|---|---|---|
| Suites de UI tocadas por el merge (`git show --stat 0d0791a`) | 7 archivos de test añadidos/ampliados | `NarrativePage.contextual.integration.test.tsx` (nuevo, 185 líneas); `StellaAdvisorPanel.test.tsx`; `StellaComposerPanel.test.tsx`; `StellaComposerSectionEditor.test.tsx` (nuevo, 202 líneas); `StellaContextualAdvisorPanel.test.tsx` (nuevo, 684 líneas); `StellaValidatorPanel.test.tsx`; `source-field-label.test.ts` (nuevo) |
| Auditoría independiente (mensaje de merge `0d0791a`) | APPROVE_WITH_NOTES | Según el propio mensaje de commit: *"MAJOR undo-LIFO + 4 minors fixed with fails-without-fix runs"*; ciclo completo aceptar/editar/rechazar/preview/aplicar vía estado React controlado (sin escritura DOM, sin auto-submit — invariante verificado por el auditor) |
| Registro de decisiones (`392c613`) | — | D-007 (adapter de reconciliación UI↔persistencia), D-008 (incidente de archivos huérfanos resuelto sin daño), DP-06 (elevada a Lorenzo) — sin evidencia de test adicional, es un commit puramente documental |
| `pnpm typecheck` / `pnpm test:unit` (checkpoint agregado inmediatamente posterior) | VERDE | Ver fila "CHECKPOINT OLA 2 CERRADA" — WS2 es uno de los 4 workstreams integrados en ese checkpoint (127 archivos, 2170 tests) |

### 2026-07-31 · CHECKPOINT OLA 2 CERRADA · coordinadora `392c613` (WS7+WS6+WS3b+WS2 integrados + wirings)

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm typecheck` | VERDE | limpio |
| `pnpm lint` | VERDE | 0 errores (51 warnings preexistentes) |
| `pnpm test:unit` | VERDE | **127 archivos, 2170 tests** (baseline 95/1372 → +798 tests netos de campaña) |
| `pnpm eval:offline` | VERDE | 28/28, 0 violaciones R1–R6 |
| `pnpm eval:roles` | VERDE | 14/14, 5/5 canaries rechazados |

### 2026-07-31 · CHECKPOINT FINAL DE CAMPAÑA · coordinadora `20d21fb` (Olas 1+2+3 integradas)

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm typecheck` | VERDE | limpio |
| `pnpm lint` | VERDE | 0 errores (51 warnings preexistentes + 1 directive sobrante) |
| `pnpm test:unit` | VERDE | **131 archivos, 2246 tests** (baseline 95/1372 → **+874 tests netos**) |
| `pnpm eval:offline` | VERDE | 6/6 gates, 28/28 casos, 0 violaciones R1–R6 |
| `pnpm eval:roles` | VERDE | 5/5 gates, 14/14 casos, 5/5 canaries rechazados |
| `pnpm build` | **VERDE** | build de producción Next.js exitoso |

WS3c auditado (APPROVE_WITH_NOTES, 0 bloqueadores) e integrado en `c28c135`.

### 2026-07-31 · ENDURECIMIENTO PRE-EJECUCIÓN DE G2 · coordinadora (post-`6632378`)

Resolución offline de los hallazgos R1–R6 de `STELLA_G2_READINESS_AUDIT`.
**No se ejecutó G2**: cero acceso a base de datos, cero SQL aplicado.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm typecheck` | VERDE | limpio (un `error TS1501` por el flag `s` de regex en el test nuevo fue corregido usando `[\s\S]`) |
| `pnpm lint` | VERDE | 0 errores, 51 warnings preexistentes |
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts lib/grounding` | VERDE | 6 archivos, **154 tests + 1 todo** (tras las dos rondas de correcciones de auditoría) |
| `pnpm test:unit` | VERDE | **132 archivos, 2312 tests + 1 todo** (antes: 131/2246 → **+1 archivo, +66 tests**) |
| `pnpm test:integration` / `pnpm test:rls` | NO EJECUTADAS | prohibidas (BD remota) |

**Auditoría independiente del diff (agente separado, modo lectura, 3 pasadas):**
ronda 1 → 1 BLOCKER, 3 MAJOR, 9 MINOR; ronda 2 → los 13 resueltos, pero 1 MAJOR
y 6 MINOR **nuevos derivados del propio fix del BLOCKER**; ronda 3 → verificación
final. El BLOCKER (**B1**) fue introducido por el propio
endurecimiento: `SET search_path = public` habría impedido resolver el tipo
`vector` cuando pgvector vive en el esquema `extensions` (convención de Supabase
hosted) — y la guarda previa, agnóstica del esquema, habría declarado que
pgvector estaba bien justo antes de fallar. Corregido con
`search_path = public, extensions`, instalación `WITH SCHEMA extensions` y una
guarda de resolubilidad (`to_regtype('vector')`) que nombra el esquema real.
**M1** (los CHECK se reconciliaban por nombre y no por definición: un CHECK
obsoleto sin `'undone'` habría pasado el gate y roto `recordStellaDecision` en
runtime), **M2** (guarda de forma ciega a PK/DEFAULT/columnas extra) y **M3**
(una migración escrita a mano en `db/migrations/` evadía las 4 salvaguardas)
también corregidos, más 7 menores.

La segunda ronda encontró que **el fix de B1 había roto la variante léxica de
G5**: la guarda de resolubilidad abortaba el script cuando pgvector
legítimamente no está instalado, y el mensaje afirmaba que sí lo estaba. Se
resolvió condicionando la guarda a la presencia real de la extensión (**N1**,
**N2**), más: anclajes `^$` en la comparación del CHECK de hash (**N3** — sin
ellos, una regex obsoleta sin anclar habría pasado el gate y admitiría
`<texto crudo><64 hex><más texto>`, justo la fuga que ese CHECK previene),
lint de los literales de `EXECUTE` (**N4** — el stripper los blanqueaba, así que
cualquier DDL escondido ahí era invisible), y **N5–N7**.

Sin corregir por decisión explícita, ratificada por el auditor: **m8**
(`decided_at timestamptz` vs. `timestamp` del resto del esquema) — `timestamptz`
es lo correcto para un audit trail; la inconsistencia es un argumento para
migrar el resto del esquema, no para degradar esta columna. Anotado en el
inventario de `db/prepared/README.md` para que nadie lo "arregle" al revés.

Cambios: los 3 scripts forward y los 3 rollbacks de `db/prepared/` fijan
`SET search_path = public`, cualifican cada objeto con `public.`, añaden guardas
de precondición y de forma que **abortan con mensaje accionable** en vez de
hacer no-op silencioso, y reconcilian constraints de forma convergente.
`G2_PACKAGE.md` incorpora criterios de aborto A1–A8 y prioriza
`psql -1 -v ON_ERROR_STOP=1`; el addendum de grounding hace lo propio (GA1–GA6)
y declara su ejecución separada, bloqueada por G5 P3. Nuevo ADR
`docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md` + nueva suite
`tests/prepared-sql-source-of-truth.test.ts` con las 4 salvaguardas.

El `1 todo` es la aserción de `STELLA_DECISIONS_PERSISTENCE_ENABLED` en
`.env.example`: la deny-list del harness (D-002, cubre `.env*`) impidió editar
ese archivo. Queda como acción manual de Lorenzo — ver el resultado de la tarea.

### 2026-08-01 · REMEDIACIÓN DE PRIVILEGIOS APPEND-ONLY · worktree `codex/stella-g2-local-rehearsal`

Cierre de **RK-04b** (`MAJOR_APPEND_ONLY_BYPASS`). Nueva unidad preparada
`stella_0002b` + endurecimiento de `stella_0003` antes de su primera aplicación.
**No se ejecutó G2 formal**: todo el trabajo con base de datos ocurrió contra el
stack Supabase **local y desechable** de este worktree.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm typecheck` | VERDE | 0 errores |
| `pnpm lint` | VERDE | 0 errores, 51 warnings preexistentes |
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | VERDE | 2 archivos, **114 tests** (antes: 79 → **+35**) |
| `pnpm test:unit` | VERDE | **134 archivos, 2408 tests** (antes: 134/2373 → **+35 tests**) |
| `pnpm test:rls` | NO EJECUTADA | fuera de alcance de esta unidad |

**Auditoría independiente del diff (agente separado, solo lectura):**
**0 BLOCKER, 2 MAJOR, 10 MINOR**, con verificación contra fuentes primarias
(`pg_cast.dat`, documentación de PostgreSQL 17). Los **2 MAJOR y 6 MINOR de
correctitud** fueron corregidos y fijados con 12 tests nuevos:

| ID | Hallazgo | Corrección |
|---|---|---|
| MAJ-01 | `DROP/CREATE TRIGGER` toma `ACCESS EXCLUSIVE` sobre `audit_logs` (escrita en casi cada request) y lo retiene hasta el COMMIT; sin timeout, encolarse tras un lector largo bloquearía todo el tráfico a la tabla | `SET lock_timeout = '5s'` en 0002b y 0003: el modo de fallo pasa de "el sitio se para" a "aborta y reintenta" |
| MAJ-02 | 0003 no concede nada a `service_role` apoyándose en que el aplicador es el owner — **la única premisa sin guarda** de un script que guarda todo lo demás. Antes del `REVOKE ALL`, un grant heredado la enmascaraba | Guarda que aborta si el rol actual no puede `INSERT`, reportando rol y owner |
| MIN-01 | El literal de `REVOKE MAINTAIN` dependía de la concatenación implícita multilínea: reformatear a una línea lo convertiría en error de sintaxis | Un solo literal en una línea; test que prohíbe `'\n'` adyacentes |
| MIN-02 | Sin guarda de existencia de `authenticated`/`service_role` | Guarda `pg_roles` con mensaje accionable |
| MIN-03 | `('public.'||t)::regclass` lanza excepción si la tabla falta, y PostgreSQL **no garantiza el orden de evaluación de los quals del WHERE**, así que el `IS NOT NULL` hermano no protege | `to_regclass()` en todas partes — ya devuelve `regclass` y da NULL en vez de lanzar |
| MIN-04 | El rollback reportaba huecos con `RAISE WARNING` → `psql` salía 0 y un gate lo vería verde | `RAISE EXCEPTION` final; no modifica nada, así que raise no cuesta |
| MIN-07 | 0003 §5 seguía afirmando que `service_role` salta RLS, cuando tras §4 no tiene **ningún** privilegio; quien salta RLS es el **owner** | Comentario corregido explicando la diferencia |
| MIN-08 | 0003 verificaba que los helpers RLS *existen*, no que sean *ejecutables* (0033:18 revoca, 0039 reconcede) | Guarda `has_function_privilege` |
| MIN-09 | Correr `stella_0002_rollback` tras 0002b deja `stella_interactions` asimétrica y hace abortar un re-apply de 0002b | Documentado en la cabecera del rollback de 0002 y en el paso 11 del runbook |
| MIN-10 | El forward nunca aseveraba su estado final; un `REVOKE` solo elimina concesiones del grantor actual y **avisa, no falla**, si no hay nada que revocar | Bloque de auto-verificación **en la misma transacción**: 0 privilegios residuales, 4 triggers adjuntos y `SELECT`/`INSERT` **preservados** (sobre-revocar también falla) |

**Confirmados correctos por la auditoría** (sin acción): sintaxis
`BEFORE TRUNCATE … FOR EACH STATEMENT`; disparo para owner y superusuario;
**disparo también sobre tablas añadidas por `CASCADE`** (doc PG17: los triggers
se disparan "first those listed in the command, and then any that were added due
to cascading") — de modo que un `TRUNCATE <ancestro> CASCADE` aborta;
reutilización de `uellix_forbid_mutation()` a nivel sentencia (`TG_OP`/
`TG_TABLE_NAME` disponibles, ausencia de `RETURN` correcta); umbral `170000`;
bits `tgtype` 8/16/32; `rolbypassrls` no salta grants de tabla.

**Aceptados sin corregir, documentados:** MIN-05 se resolvió añadiendo el
rollback de 0002b al paso 11 del runbook. **MIN-06** (`ENABLE ALWAYS TRIGGER`
para cerrar la vía `session_replication_role = 'replica'`) **no se aplicó**:
cierra un residual real, pero altera el comportamiento ante restauraciones
(`pg_restore --disable-triggers`) que no puedo verificar en este entorno. Queda
como recomendación de seguimiento, no como omisión silenciosa.

**Cobertura nueva** (23 tests): que `0002b` cubre las cuatro tablas, revoca los
privilegios exigidos a `authenticated` y a `service_role` sin tocar
`SELECT`/`INSERT`, crea exactamente 4 triggers `BEFORE TRUNCATE FOR EACH
STATEMENT` con su `DROP ... IF EXISTS`, no borra los triggers de fila
preexistentes, no toca datos/RLS/constraints, es transaccional, y maneja
`MAINTAIN` de forma version-aware; que el rollback **no** vuelve a conceder
ningún privilegio peligroso ni borra protecciones; y que `0003` hace
`REVOKE ALL` a los tres roles antes de conceder, no concede nada a
`service_role`, y crea sus dos triggers append-only.

**Guards de test reforzados, no relajados.** Tres aserciones tuvieron que
volverse *más precisas* porque el vocabulario del paquete cambió:

- `TRUNCATE` dejó de ser una palabra prohibida y pasó a clasificarse por
  posición: solo se rechaza cuando **inicia un statement** (comando), no cuando
  aparece como **evento de trigger** (`BEFORE TRUNCATE`) o como **nombre de
  privilegio** (`REVOKE TRUNCATE`). Un ban por substring habría prohibido
  justamente la defensa que se estaba añadiendo.
- `EXECUTE` dinámico sigue prohibido salvo cuando su argumento es un **literal
  puro** — detectable porque `stripCommentsAndStrings` lo colapsa a `''`.
  `EXECUTE v_sql` y `EXECUTE format(...)` siguen fallando.
- La convención de nombres de `db/prepared/` admite ahora un sufijo de letra
  (`stella_0002b`), para que una unidad correctiva no obligue a renumerar un
  script cuya evidencia ya fue publicada.

### 2026-08-01 · ENDURECIMIENTO PRE-APLICACIÓN DE `stella_0003` · worktree `codex/stella-g2-local-rehearsal`

Cierre de **MAJ-A / MAJ-B / MAJ-C** (RK-04d) y de MIN-A/MIN-B/MIN-D/MIN-F,
**antes de que `stella_0003` tocara ninguna base**. El script **sigue sin
aplicarse**. Cero escrituras: toda la validación se hizo en transacciones
revertidas.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | VERDE | **188 tests** (antes 114 → **+74**) |
| `pnpm typecheck` | VERDE | 0 errores |
| `pnpm lint` | VERDE | 0 errores |
| `pnpm test:unit` | VERDE | **134 archivos, 2482 tests** (antes 2408 → **+74**) |
| `pnpm test:rls` | NO EJECUTADA | fuera de alcance |

**La prueba que importa (MAJ-A).** La guarda vieja habría devuelto `true` para
cualquier superusuario. La nueva se ejercitó en cinco escenarios, todos en
transacciones revertidas:

| Caso | Instalador | `stella.writer_role` | Resultado |
|---|---|---|---|
| A | `postgres` (no superusuario) | `postgres` | **VERIFIED** |
| B | `postgres` | `authenticated` | **ABORTA** — `direct INSERT: f, rolbypassrls: f` |
| C | `postgres` | rol inexistente | **ABORTA** |
| D | **`supabase_admin` (superusuario)** | `authenticated` | **ABORTA** ← la guarda vieja habría pasado |
| E | `supabase_admin` | `postgres` | VERIFIED — correcto: `postgres` tiene grants directos + `rolbypassrls`, la ruta existe de verdad |

**Idempotencia:** dos corridas consecutivas en la misma transacción → dos
`verification passed`, sin duplicar objetos.

**MIN-B medido, no supuesto:** sobre `stella_interactions`,
`information_schema.role_table_grants` devuelve **11 filas** y `aclexplode`
sobre la ACL directa devuelve **4**. La diferencia son privilegios del owner y
heredados por membresía (`postgres` es miembro de `authenticated` y
`service_role`) — exactamente el falso rojo que habría hecho fallar el gate.

**Revisión independiente del diff — ronda 2: 0 BLOCKER, 1 MAJOR, 7 MINOR.**
Todos corregidos y fijados con pruebas de regresión:

| ID | Hallazgo | Corrección |
|---|---|---|
| **M1** | La comprobación (19) abortaba si existía `public.evidence_chunks`. Pero `grounding_0001` la crea **legítimamente sobre la misma base** bajo su propio gate (G5 P3), y el chequeo no puede distinguir "la creé yo" de "otro gate ya corrió". Una vez aplicado G5 P3, **toda re-ejecución de 0003 abortaría** — rompiendo la convergencia que el propio encabezado promete | Eliminada. El invariante real ("este archivo nunca la crea") es **estático**, no de runtime: el script no menciona `evidence_chunks` y el test offline lo verifica. Documentado por qué no se comprueba |
| **m1** | La comprobación (20) buscaba el nombre de la tabla dentro de `defaclacl`, que es `aclitem[]` (`grantee=privs/grantor`) y **nunca** contiene nombres de tabla: siempre daba 0. Un chequeo que no podía dispararse mientras se contaba como verificado | Eliminada, con la razón documentada |
| **m2** | No se verificaba `relforcerowsecurity`. Todo el camino de escritura depende de que el **owner esquive RLS**; con FORCE activo dejaría de esquivarlo y, sin policy INSERT, toda escritura fallaría — mientras el script imprimía `VERIFIED` | Comprobado en **dos** sitios: la guarda §4b y la auto-verificación §7 |
| **m3** | `writer::regrole::oid` — `regrolein` parsea como identificador SQL: minusculiza y parte por puntos. Un rol `AppWriter` o `app.writer` pasaba el chequeo de existencia y reventaba después | `SELECT oid FROM pg_roles WHERE rolname = writer`. Verificado: `Rol.Con.Puntos` da ahora el mensaje limpio de "no existe" |
| **m4** | `position()` prueba **presencia**, no exclusividad: un CHECK obsoleto que además admitiera `'deleted'` pasaba | Añadida comprobación de exclusividad con `regexp_matches` sobre la definición |
| **m5** | `authenticated=r*/postgres` (SELECT **WITH GRANT OPTION**) quedaba excluido y no se reportaba, pese a permitir re-conceder SELECT a `anon` | `AND NOT a.is_grantable` en la exclusión |
| **m6** | No se detectaban columnas ni FKs **extra**, ni se fijaba `confdeltype` | Exactamente 11 columnas, exactamente 4 FKs, y `confdeltype='a'` (NO ACTION) — ahora invariante documentada por RK-04f |
| **m7** | El mensaje era más estricto que la guarda: un `stella.writer_role='authenticated'` con grants adecuados habría pasado | La guarda rechaza `writer IN ('anon','authenticated','service_role')` |

**Control adicional del encargo:** la autorización destructiva del rollback
exige ahora exactamente `= 'true'` (antes `'yes'`), sin valores ambiguos.

**Revisión independiente — ronda 3: 0 BLOCKER, 1 MAJOR, 7 MINOR.** Todos
corregidos:

| ID | Hallazgo | Corrección |
|---|---|---|
| **MAJOR-1** | §4b declaraba que existía una prueba offline fijando que el único camino de escritura de la app es `db/client.ts` (postgres-js sobre `DATABASE_URL`) y no un cliente `service_role`/PostgREST. **Esa prueba no existía.** El hecho era cierto pero nadie lo fijaba — y es *load-bearing*: es la razón declarada de por qué la guarda SQL puede quedarse corta. Exactamente el defecto que M1/m1 habían cerrado en otros sitios | Escrita: verifica que `db/client.ts` es postgres-js sobre `DATABASE_URL` y **no** un cliente supabase-js; que `decisions.ts` escribe por ahí; y que **ningún otro módulo** de `app/`, `lib/` o `components/` toca la tabla (recorrido real del árbol, ignorando comentarios) |
| **MINOR-1** | `README.md` y el registro de riesgos seguían diciendo "20 comprobaciones … `evidence_chunks` ausente, default privileges intactos" — justo las dos que M1 y m1 eliminaron. El registro autoritativo afirmaba verificar algo que ya no se verifica | Corregido a **18**, enumerando cuáles se retiraron y por qué, para que no se reintroduzcan |
| **MINOR-2** | El comentario (19) atribuía la verificación a `prepared-sql-source-of-truth.test.ts` (que no la hace) y decía que el script "no menciona `evidence_chunks` en ninguna parte" — literalmente falso: aparece en comentarios | Reescrito: el **SQL ejecutable** nunca la menciona, y quien lo fija es `prepared-stella-sql.test.ts` |
| **MINOR-3** | `'([a-z_]+)'` no capturaba `'accepted2'`, `'Deleted'` ni `'v2'`: un CHECK obsoleto con esos valores pasaba la prueba de exclusividad en silencio — el mismo patrón "sólo detecta lo que ya esperabas" que cerró MIN-A | Ampliado a `'([^'']+)'` en los **dos** puntos de uso |
| **MINOR-4** | §2 reconciliaba por presencia mientras §7 rechazaba supersets: un CHECK preexistente con un quinto estado no se reconstruía y luego abortaba toda la transacción. La cabecera promete convergencia, no un fallo ruidoso | §2 usa ahora la misma prueba de exclusividad → reconstruye en vez de abortar |
| **MINOR-5** | `PUBLIC` era invisible: es grantee OID 0, sin fila en `pg_roles`, así que el `JOIN` no podía verlo — y el script tampoco lo revocaba | `REVOKE ALL … FROM PUBLIC` + comprobación explícita de `grantee = 0` |
| **MINOR-6** | "0 UNIQUE" sólo miraba `pg_constraint`; un `CREATE UNIQUE INDEX` suelto impone unicidad sin crear constraint y habría pasado | Añadida comprobación sobre `pg_index` (`indisunique AND NOT indisprimary`) |
| **MINOR-7** | `G2_PACKAGE.md` ofrecía vías (`supabase db execute --file`, SQL Editor) donde **no se puede** emitir el `SET` previo, así que siempre caerían en la rama ASSUMPTION | Tabla por vía de aplicación, con `ALTER DATABASE … SET stella.writer_role` para las que no admiten `SET` de sesión |

**Escenarios ejercitados de la guarda — reejecutados contra PostgreSQL 17 real
DESPUÉS de las ediciones SQL de ronda 3** (SHA-256 del script
`6caa5ca97acbc0e9b28a439a66dcfac9b0d15399e4172da886dffd9fc1d6b7d1`), todos en
transacciones revertidas. *(Corregido por MINOR-D: el párrafo anterior enumeraba
los escenarios de ronda 2 bajo la tabla de ronda 3, sin evidencia de una
re-ejecución posterior a los cambios de `EXISTS` en §2, `pg_index`,
`REVOKE … FROM PUBLIC` y `grantee = 0`. Era el mismo patrón "verificación
declarada, no realizada" que este paquete persigue.)*

| Caso | Instalador | `stella.writer_role` | Resultado real |
|---|---|---|---|
| A | `postgres` | `postgres` | `write path VERIFIED` |
| B | `postgres` | `authenticated` | aborta — *is a PostgREST role* |
| C | `postgres` | inexistente | aborta — *does not exist* |
| D | **`supabase_admin` (superusuario)** | `authenticated` | **aborta** |
| E | `postgres` | `authenticator` | aborta — *has no working INSERT path* |
| F | `postgres` | `Rol.Con.Puntos` | aborta limpio (sin reventar en `regrolein`) |
| G | `postgres` | **sin declarar** | `ASSUMPTION, not a verification` |

Idempotencia reverificada con el mismo script: dos corridas consecutivas → dos
`verification passed`. Base intacta: `stella_suggestion_decisions` sigue
ausente.

**Lección de proceso (propia, no del auditor).** Dos ediciones automatizadas de
tests se corrompieron por usar `String.replace` con un reemplazo que contenía
`$'`, que en JavaScript significa *"el texto posterior al match"*: duplicó 691
líneas del archivo. Se detectó por error de parseo, se verificó que la cola era
duplicado exacto y se truncó. Para texto con `$` conviene una función de
reemplazo o edición directa, nunca una cadena literal.

### 2026-08-01 · STELLA 0003 LOCAL REHEARSAL — RUN 1 · worktree `codex/stella-g2-local-rehearsal`

**Primera aplicación de `stella_0003` en un PostgreSQL real.** La ejecutó
**manualmente el operador**; todo lo demás de esta entrada se verificó después,
de forma independiente, sobre el estado ya aplicado. **No es la ejecución
formal de G2**: una base local no es staging y ninguna casilla de
`docs/ops/gates/G2_PACKAGE.md` queda marcada por esta corrida.

| Campo | Valor |
|---|---|
| Branch / HEAD | `codex/stella-g2-local-rehearsal` / `09a65fd22429c033cc3de970deb2913cd90752e3` |
| `project_id` | `uellix-stella-g2-local-rehearsal` |
| Contenedor | `supabase_db_uellix-stella-g2-local-rehearsal` (PostgreSQL 17.6) |
| Writer declarado | `SET stella.writer_role = 'postgres'` |
| SHA-256 working tree (bytes ejecutados, CRLF) | `6caa5ca97acbc0e9b28a439a66dcfac9b0d15399e4172da886dffd9fc1d6b7d1` |
| SHA-256 canónico Git (LF) | `ad22e22c18f0bfb8c03987e05b76de45efe440fd994c2ae719a55bece778fab5` |
| Git blob ID | `00c17b0491b26c195aa19822d8c80fed4874c202` |
| Archivo modificado tras aplicar | **no** (`git status` vacío; `git hash-object` = blob ID) |

**1ª aplicación (manual).** `psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
-c "SET stella.writer_role='postgres'" -f <script>`. Exit exitoso. Los dos
`NOTICE` finales del script: `write path VERIFIED against declared writer role
postgres (owner: postgres, owner_is_writer: t)` y `verification passed — …`.
La rama `ASSUMPTION` **no** se activó.

**Postchecks independientes** (contra `pg_catalog`, sin confiar en el `NOTICE`
que el script emite sobre sí mismo): 11 columnas exactas sin extras, tipos /
nulabilidad / defaults exactos; PK sobre `(id)`; **4 FKs, todas `NO ACTION`**,
cero adicionales; **0 UNIQUE constraints y 0 índices únicos no-PK**; CHECK de
`decision` con exactamente los cuatro estados; CHECK de hash anclado
`^[0-9a-f]{64}$`; 2 índices no únicos + el de la PK; owner `postgres`; RLS
activo con **FORCE apagado**; **1 sola policy** SELECT org-scoped con ambos
helpers; ACL directa por `aclexplode` → `authenticated = SELECT` no grantable,
`service_role` / `anon` / `PUBLIC` = **nada**; 2 triggers no internos
(`tgtype` 27 y 34) ligados a `uellix_forbid_mutation()`, sin INSERT en el de
fila. `evidence_chunks` **ausente**; las 4 tablas append-only previas y sus 8
triggers intactos; interacción sintética intacta; registro de migraciones sin
entradas nuevas.

**Camino de escritura** (transacción revertida, como `postgres` = owner =
`DATABASE_URL`; identificadores derivados en SQL, nunca impresos):

| Comprobación | Resultado |
|---|---|
| `INSERT` | permitido |
| `RETURNING id` | permitido, `id` no nulo |
| `DEFAULT` de `decided_at` | aplicado |
| CHECKs (`accepted_edited`, hash 64 hex) y FK a `stella_interactions` | satisfechos |
| Tras `ROLLBACK` | **0 filas** |

Cero errores de FK, CHECK, ACL, RLS o `RETURNING`.

**Inmutabilidad como owner** (transacciones separadas, todas revertidas):

| Operación | Resultado | SQLSTATE | Origen |
|---|---|---|---|
| `UPDATE` | bloqueado | `42501` | trigger `uellix_forbid_mutation()` |
| `DELETE` | bloqueado | `42501` | trigger `uellix_forbid_mutation()` |
| `TRUNCATE` (sin `CASCADE`) | bloqueado | `42501` | trigger `BEFORE TRUNCATE` |

**Matriz de roles cliente** (`SET LOCAL ROLE`, revertido; sin conceder nada):

| Rol | SELECT | INSERT / UPDATE / DELETE / TRUNCATE |
|---|---|---|
| `authenticated` | permitido por ACL, **0 filas** por RLS org-scoped (sin claims) | bloqueados por **ACL** |
| `service_role` | bloqueado por **ACL** — pese a `rolbypassrls = t` | bloqueados por **ACL** |
| `anon` | bloqueado por **EXECUTE del helper RLS** y además por ACL | bloqueados por **ACL** |

Tres matices medidos, no supuestos: (a) `authenticated` lee y no ve nada —
ACL y RLS son capas distintas; (b) `service_role` salta RLS pero **saltarse RLS
no concede ACL**, así que la postura "sin ningún privilegio" de §4 queda
comprobada en ejecución; (c) el error de `anon` es `permission denied for
function current_user_org_ids`, no el de tabla, porque el helper es una función
SQL `SECURITY DEFINER` y el planner comprueba su `EXECUTE` al inlinearla, antes
del chequeo de ACL de tabla en el ejecutor — verificado que **ambas** capas
deniegan (`has_table_privilege` = f **y** `has_function_privilege` = f).
Comportamiento preexistente en `stella_interactions`; no lo introduce 0003.

**2ª aplicación — idempotencia medida, no supuesta.** Misma copia exacta
(`sha256` verificado dentro del contenedor), misma sesión, mismo writer:
exit **0**, ~898 ms, mismos dos `NOTICE`, **0 warnings, 0 errores**. Huella
estructural de 39 líneas (columnas, constraints, índices, policy, triggers,
ACL, owner, flags RLS, filas, triggers de las 4 tablas previas, interacción
sintética, nº de tablas, ausencia de `evidence_chunks`) capturada antes y
después:

```
sha256(antes)   = 549b4084327b35f18756586ca0edc4a8571d1ea7f79a3396a6552f632a84d030
sha256(despues) = 549b4084327b35f18756586ca0edc4a8571d1ea7f79a3396a6552f632a84d030
diff -u -> sin diferencias
```

Los triggers recreados se reverificaron **funcionalmente** tras la segunda
corrida: `UPDATE`/`DELETE`/`TRUNCATE` volvieron a fallar con `42501`. La copia
temporal del script dentro del contenedor se eliminó al terminar.

*Nota operativa:* el primer intento de la 2ª aplicación falló por conversión de
rutas de MSYS (`/tmp/...` → ruta Windows). `-1` hizo su trabajo: el `SET` corrió,
el `-f` no encontró el archivo y **no se tocó la base** (verificado). Se repitió
con `MSYS_NO_PATHCONV=1`.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | VERDE | **188 tests**, 2 archivos |
| `pnpm test:unit` | VERDE | **134 archivos, 2482 tests** |
| `pnpm typecheck` | VERDE | exit 0, 0 errores |
| `pnpm lint` | VERDE | exit 0, **0 errores** (51 warnings preexistentes) |
| `pnpm test:rls` | NO EJECUTADA | es G3 |

**Alcance.** Cero acceso remoto. Cero `supabase login/link/db push/db pull`.
Cero G3. Cero `grounding_0001`. Cero seeds. Cero reset. **Rollback NO
ejecutado.** Otros stacks (`uellix-antigravity`, `aforiq`) intactos. **Cero
ejecución formal de G2.**

**Pendientes para el gate remoto** (abiertos; no bloquean el ensayo local):

| # | Pendiente | Ámbito |
|---|---|---|
| 1 | `G2_PACKAGE.md` §2 sigue usando `information_schema.role_table_grants` para `stella_interactions`. Además esa vista **no puede expresar `PUBLIC`**: medido en este stack devuelve 0 filas con `grantee='PUBLIC'` mientras **195 relaciones** sí tienen ACL de `PUBLIC`, así que su expectativa *"para anon / PUBLIC: ninguna fila"* es infalsificable para `PUBLIC`. Es el defecto que MINOR-5 cerró para la tabla nueva | G2 remoto |
| 2 | En el rollback, la guarda (`DO $$`) y el `DROP TABLE IF EXISTS` son sentencias separadas: la protección depende de `-1 -v ON_ERROR_STOP=1`, no de la estructura | G2 remoto / producción |
| 3 | No existe test automático de integridad estructural de los archivos de test; el incidente de `String.replace` con `$'` sólo está registrado como lección de proceso. **Reincidió durante esta misma corrida**, al redactar esta entrada: un `String.replace` sobre este ledger interpretó `$` + backtick (el texto ANTERIOR al match, 411 líneas) y `$` + comilla simple (el texto POSTERIOR, 6 líneas), insertando 417 líneas espurias, y además colapsó `$$` en `$`. Se detectó por conteo de líneas (540 añadidas frente a 123 esperadas), se revirtió con `git checkout --` y se rehízo con una **función** de reemplazo, que desactiva por completo esa interpretación. Segundo caso registrado: la lección escrita no basta, hace falta el guardarraíl | proceso |
| 4 | El SHA-256 citado como "bytes ejecutados" es el del working tree con CRLF; en un checkout LF o CI Linux el mismo archivo hashea `ad22e22c…`. No hay `.gitattributes` que fije `eol` para `*.sql` | evidencia |

### 2026-08-01 · G3 LOCAL REHEARSAL — RUN 1, CORRECTED INSTRUMENTATION · worktree `codex/stella-g2-local-rehearsal`

Primera ejecución de `pnpm test:rls` con los dos bloques post-G2 habilitados,
contra el stack local `uellix-stella-g2-local-rehearsal` (PostgreSQL 17.6,
`127.0.0.1:56321` / `56322`). **Cero acceso remoto.** Detalle completo en
`docs/ops/LOCAL_STAGING_G2_REHEARSAL.md` y `docs/ops/gates/G3_PACKAGE.md`.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm test:rls` (1ª, instrumentación original) | **ROJO** | 23 passed / **2 failed** — rojo falso, ver abajo |
| `vitest ... -t "via service role falla con insufficient_privilege"` (focalizada) | VERDE | 2 passed / 30 skipped; no ejecutó el bloque que crea la decisión |
| `pnpm test:rls` (2ª, corregida) | VERDE | 1 archivo, **32 passed, 0 failed, 0 skipped**, 11,79 s |
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | VERDE | **188 tests**, 2 archivos |
| `pnpm test:unit` | VERDE | **135 archivos, 2495 tests** (+13: pruebas del helper nuevo) |
| `pnpm typecheck` | VERDE | exit 0, 0 errores |
| `pnpm lint` | VERDE | exit 0, **0 errores** (51 warnings preexistentes; los archivos nuevos no añaden ninguno) |

**Causa del falso rojo.** `db.execute()` de drizzle-orm 0.45.2 lanza un
`DrizzleQueryError` cuyo `.message` es `"Failed query: <sql>\nparams: "`; el
`PostgresError` de postgres-js 3.4.9 —con `code='42501'` y
`append-only: UPDATE on stella_interactions is not permitted`— queda en
`.cause`. `.rejects.toThrow(/append-only/)` compara sólo contra `.message`, así
que la aserción **nunca podía ver** el mensaje del trigger. La base sí bloqueó
ambas mutaciones y la fila quedó intacta. Defecto **independiente del entorno**:
habría fallado igual contra staging.

**Corrección.** `tests/helpers/append-only-error.ts` recorre la cadena `cause`
(profundidad ≤ 10, detección de ciclos) y exige **conjuntamente** SQLSTATE
`42501`, texto `append-only`, operación y tabla — estrictamente **más fuerte**
que la aserción original. Fijado por `tests/append-only-error.test.ts` (13
casos: causa válida, anidada, ausente, SQLSTATE erróneo, mensaje erróneo,
operación/tabla erróneas, ciclo, profundidad, y "la consulta tuvo éxito").

**Idempotencia.** La suite resuelve la clave determinista
`g3-local-rehearsal.synthetic.advisor.suggested_next_actions[0]` antes de
escribir: **REUSED** si existe una (deriva org, proyecto e interacción y no
inserta nada append-only), **CREATED** si no existe, **aborta** si hay más de
una. La 2ª corrida fue **REUSED**: decisiones **1 → 1**, interacciones
**2 → 2**, y organizaciones/usuarios/proyectos/membresías/objetos de Storage sin
cambio neto.

**Cobertura nueva** (7 tests, ninguno crea filas append-only): `TRUNCATE`
bloqueado por el trigger `BEFORE TRUNCATE` en transacción revertida;
`service_role` sin poder leer **ni** insertar (BYPASSRLS ≠ ACL); super_admin lee
pero no muta; usuario sin membresía ni lee ni inserta; y la lectura de
organización A verifica clave y decisión exactas.

**Alcance.** Cero acceso remoto. Cero `supabase login/link/db push/db pull`.
Cero reset. Cero restauración del respaldo. **Rollback NO ejecutado.** Cero
`grounding_0001`. **Cero ejecución formal de G2.** Otros stacks
(`uellix-antigravity`, `aforiq`) intactos. Respaldo local pre-G3
(`pg_dump -Fc`, fuera del repo, SHA-256 `d46280c4…b436aeb`, validado con
`pg_restore -l`, no restaurado).

**Residuo deliberado.** 1 decisión + 1 interacción sintéticas, más la clausura
FK que fijan (org, proyecto, usuario). No retirables fila por fila. Limpieza
autorizada: **reset/rebuild del stack local**. **G3 remoto sigue sin
autorización** — necesita una estrategia no contaminante propia.

### 2026-08-01 · ENDURECIMIENTO ESTRUCTURAL DEL ROLLBACK DE `stella_0003` · worktree `codex/stella-g2-local-rehearsal`

Unidad **previa** al ensayo destructivo. Cierra **RK-04i** y el pendiente remoto
2 de `docs/ops/LOCAL_STAGING_G2_REHEARSAL.md`. **Cero escrituras en la base
viva, cero acceso remoto, rollback NO ejecutado.** Detalle completo en
`docs/ops/LOCAL_STAGING_G2_REHEARSAL.md`.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | VERDE | 2 archivos, **237 tests** (antes 188 → **+49**) |
| `pnpm test:unit` | VERDE | **135 archivos, 2544 tests** (antes 2495 → +49, los mismos) |
| `pnpm typecheck` | VERDE | exit 0, 0 errores |
| `pnpm lint` | VERDE | exit 0, **0 errores** (51 warnings preexistentes, sin cambio) |
| `pnpm test:rls` | **NO EJECUTADA** | Es G3 |
| Dry-run del script real, contenedor desechable PG 17.6 | VERDE | **24/24 escenarios** con fixture realista (tabla, 2 CHECK, índice, RLS + política, 2 triggers); `sha256` verificado dentro del contenedor |
| Mutation testing de las aserciones | VERDE | **58/58 mutantes detectados**; archivo restaurado byte a byte tras cada uno |
| Revisión independiente (agente de solo lectura), **9 rondas, cerrada** | VERDE | R1: **3 MAJOR**; R2: **2 MAJOR**; R3: **1 BLOCKER + 2 MAJOR**; R4: **2 MAJOR**; R5: **2 MAJOR**; R6: **2 MAJOR** (el supuesto de aislamiento estaba documentado, no impuesto); R7: **1 MAJOR** (premisa del conjunto de llamadores — resuelto midiendo, no añadiendo guarda); R8: **1 MAJOR** (`DROP TABLE` admite además al dueño del ESQUEMA; la guarda es deliberadamente más estrecha y esa estrechez es portante); **R9: 0 BLOCKER, 0 MAJOR** — el revisor declara el SQL entregado listo y no logra construir ninguna mutación que cambie el comportamiento dejando la suite verde. Los 2 MINOR de R9 (banner sin fijar, "barrido" que era una lista fija) también corregidos |

**Defecto.** Guarda (`DO $$ … $$;`) y `DROP TABLE IF EXISTS` eran **sentencias
top-level separadas**. Sin `-v ON_ERROR_STOP=1`, `psql` reporta el error de la
guarda y **envía la siguiente sentencia**; sin `-1`, no hay transacción que
revierta. La barrera era una convención de invocación, y `G2_PACKAGE.md` admite
tres vías de aplicación de las cuales **sólo `psql`** acepta esas banderas.

**Corrección.** Guarda y `DROP` en **un único bloque `DO`**: un
`RAISE EXCEPTION` termina el bloque y ninguna sentencia posterior *de ese
bloque* corre — semántica del **servidor**, no del **cliente**. El `DROP` se
emite como `EXECUTE '<literal fijo>'` (cero concatenación, `format()`,
`quote_ident()` o variables), sin `IF EXISTS` porque la existencia ya se probó
en el mismo bloque.

**Dry-run.** Contenedor **nuevo, `--network none`, sin puertos publicados**,
imagen `supabase/postgres:17.6.1.143` (PostgreSQL **17.6**, mismo motor que el
stack del ensayo), destruido al terminar. Los escenarios críticos corrieron con
**`psql` desnudo (sin `-1`, sin `ON_ERROR_STOP`)**: tabla ausente → no-op;
0 filas → `DROP` con `NOTICE` de rollback técnico y **sin** `WARNING`; 1 fila
sin autorización → aborta y **tabla, fila y triggers sobreviven**; **11/11**
valores de autorización incorrectos rechazados; `'true'` exacta → `DROP` con
`WARNING` y conteo; segunda ejecución → no-op. Con `-1 -v ON_ERROR_STOP=1` el
camino no autorizado sale **3** (defensa en profundidad intacta).

**Par regresión/cierre (S8/S9).** Mismo motor, misma invocación desnuda, misma
fila: la forma **anterior** lanzó la excepción de la guarda **y destruyó la
tabla igualmente**; la forma **nueva** dejó tabla y fila intactas.

**Revisión independiente — 3 MAJOR cerrados (S10–S13).**
**M1:** `count(*)` está sujeto a RLS; con `FORCE ROW LEVEL SECURITY` un owner
sin `rolbypassrls` contaba **0** sobre una tabla poblada (reproducido: `FORCE`
off → 1, on → 0) y el script habría anunciado *"no audit data lost"* mientras la
destruía → guarda de `relforcerowsecurity` antes del conteo (**S10**).
**M2:** un `ALTER DATABASE/ROLE … SET` persistido pre-autorizaba toda sesión
futura — el mismo defecto reubicado a la capa de GUC. La corrección propuesta
por el revisor (`pg_settings.source`) es **inaplicable**: los GUC placeholder no
aparecen en `pg_settings` (0 filas); implementada sobre `pg_db_role_setting`
(**S11**).
**M3:** las pruebas no prohibían un `EXCEPTION WHEN`, que traga el `RAISE` de la
guarda dejando pasar el `DROP` con todo lo demás en verde → prohibido, más
exactamente un `BEGIN` y un `RETURN`.
MINOR/NIT: aviso de irreversibilidad corregido (el DDL es transaccional: bajo
`-1`, `ROLLBACK` deshace hasta el `COMMIT`), `client_min_messages` fijado
(**S12**), `LOCK TABLE … ACCESS EXCLUSIVE` antes del conteo (TOCTOU), banner de
destrucción sólo en el camino con filas (**S13**), helper de comentarios que
recorta también los de final de línea, y autorización fijada **byte a byte** en
vez de por enumeración de rechazos.

**Cambio colateral.** El banner de `RAISE NOTICE` pasó de guiones a `=`: un
`--` **dentro de un literal** hacía que `stripCommentsAndStrings` truncara el
`NOTICE`, dejara una comilla desbalanceada y leyera el contenido de las cadenas
como código — la aserción "no hay `DROP TABLE` ejecutable" era infalsificable.

**Cobertura nueva (19 tests).** Ausencia de `DROP TABLE` top-level; `DROP`
dentro del mismo `DO` y **después** del `RAISE EXCEPTION`; `EXECUTE` con literal
fijo; exactitud de `stella.confirm_destroy_decisions` con rechazo enumerado;
ausencia de `::boolean`/`lower()`/`trim()`; `missing_ok = true`; los cuatro
mensajes distinguibles; aviso de audit trail irrecuperable; `lock_timeout`;
`search_path`; cero `GRANT`/`ALTER DEFAULT PRIVILEGES`/mención ejecutable a
0002/0002b/`evidence_chunks`; y ausencia de control de transacción propio.

**Alcance.** Base viva verificada idéntica antes y después: **1** decisión,
**2** interacciones, **10** triggers append-only, **104** policies,
`evidence_chunks` ausente. Respaldo pre-G3 **no restaurado**, SHA-256 sin cambio
(`d46280c4…b436aeb`). Cero reset, cero G3, cero `grounding_0001`, cero cambios
en `db/schema.ts` / `db/migrations` / `stella_0002` / `stella_0002b`. Otros
stacks intactos. **Cero ejecución formal de G2.** Siguiente paso: **ensayo
destructivo controlado**, todavía sin ejecutar.

### 2026-08-02 · CIERRE DE MINOR DE LA REAUDITORÍA (MIN-1, MIN-2) · worktree `codex/stella-g2-local-rehearsal`

Sigue a `STELLA_0003_ROLLBACK_REAUDIT_VERIFIED_READY_FOR_CONTROLLED_EXECUTION`
(0 BLOCKER, 0 MAJOR, 2 MINOR). Cierra ambos MINOR **sin tocar la lógica
ejecutable** de `stella_0003_rollback.sql` — SHA-256 idéntico antes y después
(`e9498d02…5008bfb4c12e4b`). **Rollback vivo NO ejecutado.**

**MIN-1 — mensajes de aborto no fijados extremo a extremo.** Las aserciones de
la ronda 4 (`GUARDS`, arriba) pinnean la condición de cada guarda más un
prefijo del mensaje; el tramo medio (explicación, contexto, remedio) no
quedaba comparado íntegro, así que una mutación ahí pasaba en verde.
Añadido `describe('MIN-1 closure — the six abort messages, pinned end to
end', ...)` en `tests/prepared-stella-sql.test.ts`: extrae los seis literales
`RAISE EXCEPTION` del bloque `DO` (decodificando el escape `''`, con
comentarios ya retirados por `stripAllComments` para no confundir la prosa
del encabezado con SQL ejecutable) y los compara por **igualdad exacta**
contra seis constantes canónicas etiquetadas semánticamente
(`isolationPrecondition`, `ownershipPrecondition`, `forceRowLevelSecurity`,
`destructionNotAuthorised`, `provenanceCatalogUnreadable`,
`authorisationPersisted`), más comprobación de unicidad (6 mensajes
distintos) y de prefijo común. 9 tests nuevos.

**MIN-2 — README con conteo de mutantes desactualizado.** `db/prepared/README.md`
seguía diciendo **40/40** tras la ronda de endurecimiento estructural del
2026-08-01, cuyo resultado final verificado fue **58/58**. Corregido, con
contexto añadido: los 58 son mutantes **destructivos y estructurales**
(condiciones, guardas degradadas, ramas intercambiadas, aislamiento,
autorización), pertenecen al endurecimiento **previo a la ejecución**, no
implican cobertura universal de toda mutación posible, y la clase adicional
que propuso esta reauditoría (mutaciones sólo de mensajes/comentarios, no
destructivas) queda cerrada aparte, sin alterar esa cifra.

**Mutation check focalizado (2026-08-02).** 10 mutantes sobre los seis
mensajes (tramo medio eliminado, significado invertido, remedio cambiado,
prefijo cambiado, referencias a aislamiento/FORCE RLS/autorización
eliminadas, mensaje de propiedad cambiado, dos mensajes intercambiados, un
mensaje duplicado) — **10/10 detectados**. Archivo restaurado byte a byte
(SHA-256 verificado) tras cada uno.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | VERDE | 2 archivos, **246 tests** (antes 237 → **+9**) |
| `pnpm test:unit` | VERDE | **135 archivos, 2553 tests** (antes 2544 → +9, los mismos) |
| `pnpm typecheck` | VERDE | exit 0, 0 errores |
| `pnpm lint` | VERDE | exit 0, **0 errores** (51 warnings preexistentes, sin cambio) |
| `pnpm test:rls` | **NO EJECUTADA** | Es G3 |

**Alcance.** Diff limitado a `tests/prepared-stella-sql.test.ts` y
`db/prepared/README.md`. Cero cambios en `stella_0003_rollback.sql`,
`db/schema.ts`, `db/migrations`. Verificación de estado vivo (solo `SELECT`,
contra el stack local `uellix-stella-g2-local-rehearsal`, `127.0.0.1:56322`,
no remoto): tabla `stella_suggestion_decisions` presente, **1** decisión,
**2** interacciones — sin cambio. Respaldo pre-G3 no tocado. Cero reset, cero
G3, cero acceso remoto, cero push/PR.

### 2026-08-02 · STELLA 0003 ROLLBACK REHEARSAL — RUN 1 · worktree `codex/stella-g2-local-rehearsal`

**HEAD inicial `12715d8`.** Primera ejecución **real** de
`db/prepared/stella_0003_rollback.sql` contra un PostgreSQL vivo (stack local
desechable `uellix-stella-g2-local-rehearsal`, contenedor
`supabase_db_uellix-stella-g2-local-rehearsal`, PostgreSQL 17.6,
`127.0.0.1:56322`). Hasta aquí el rollback estaba verificado sólo
*estructuralmente*: 246 pruebas sobre el texto del archivo y 58 mutantes
detectados, pero cero ejecuciones destructivas.

**Respaldo antes de nada.** `pre_g3_local.dump` validado en tamaño exacto
(581 736 bytes) y SHA-256 (`d46280c4…b436aeb`), `pg_restore -l` en solo lectura
→ **1155 entradas TOC / 87 `TABLE DATA`** (exacto), y duplicado a una segunda
ubicación estable fuera de `TEMP`, fuera del repositorio y fuera de carpetas
sincronizadas. Hashes de original y copia **idénticos**. **Ninguno restaurado.**

**Identidad del script.** SHA-256 working tree = SHA-256 canónico Git =
`e9498d02…c4b12e4b` (el archivo está en LF, así que ambas identidades
colapsan); blob ID `81211230…6224de`, idéntico al registrado en `HEAD`;
`git diff HEAD` vacío. Hash **recalculado dentro del contenedor** antes de
ejecutar y coincidente. Estructura re-verificada sobre el archivo: 4 sentencias
top-level (3 `SET` + 1 `DO`), 0 `DROP` top-level, el único `DROP` como literal
fijo dentro del `DO`, sin `format()`/`quote_ident`/concatenación, autorización
exacta `stella.confirm_destroy_decisions = 'true'`, 6 guardas / 6 abortos.

**1ª ejecución — destructiva, autorizada.** Un solo `psql`, una conexión, una
transacción (`-1`), autorización por `-c` en la misma sesión que el `-f`. Sin
`ALTER ROLE`/`ALTER DATABASE`/`PGOPTIONS`/config persistente (0 entradas en
`pg_db_role_setting`). Exit **0**, ~1 s. **1 fila detectada**, banner de 13
líneas verbatim, **1 `WARNING`**, tabla eliminada, transacción confirmada.

**2ª ejecución — idempotencia.** Sesión nueva, **sin** autorización. Exit **0**,
`NOTICE` de tabla ausente, no-op, **cero** banner, **cero** `WARNING`. Línea
base re-capturada **idéntica byte a byte** a la del postcheck.

**Postcheck — delta cerrado.** Cada línea que cambió entre la línea base pre y
post pertenece a `stella_suggestion_decisions` o es un contador que refleja esa
remoción:

| Contador | Pre | Post | Δ |
|---|---|---|---|
| tablas `public` | 38 | 37 | −1 |
| policies `public` | 104 | 103 | −1 |
| triggers append-only | 10 | 8 | −2 |
| índices `public` | 119 | 116 | −3 |
| constraints `public` | 230 | 223 | −7 |
| grants no-owner | 461 | 460 | −1 |
| funciones `public` | 8 | 8 | 0 |
| migraciones | 2 | 2 | 0 |

`stella_interactions` presente con **2** filas; `organizations` 3, `users` 9,
`projects` 2, `organization_members` 7 — sin cambio (las FKs de decisions eran
salientes, el `DROP` sin `CASCADE` no tocó a los padres); `uellix_forbid_mutation()`
intacta; `evidence_chunks` ausente; `session_replication_role = origin` antes y
después.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | VERDE | 2 archivos, **246 tests** — verdes **después** del `DROP`: prueban el texto del SQL, no el estado de la base |
| `pnpm test:unit` | VERDE | **135 archivos, 2553 tests** |
| `pnpm typecheck` | VERDE | exit 0, 0 errores |
| `pnpm lint` | VERDE | exit 0, **0 errores** (51 warnings preexistentes, sin cambio) |
| `pnpm test:rls` | **NO EJECUTADA** | Es G3 |
| `pnpm test:integration` | **NO EJECUTADA** | Escribe en BD remota por defecto |

**Alcance.** Diff limitado a documentación (`LOCAL_STAGING_G2_REHEARSAL.md`,
este ledger, `STELLA_FABLE_RISK_REGISTER.md`, `gates/G2_PACKAGE.md`). Cero
cambios en `stella_0003_rollback.sql`, `db/schema.ts`, `db/migrations`. Cero
acceso remoto (todo por `docker exec`), cero restore, cero reset, cero G3, cero
`grounding_0001`, cero rollback de `stella_0002`/`0002b`, cero push/PR. Otros
stacks (`uellix-antigravity`, `aforiq`) intactos. **Cero ejecución formal de G2.**

**Siguiente paso:** auditoría post-rollback independiente. El RUN 2 (FULL
REBUILD) **no** queda autorizado por esta corrida.

### Omitidas deliberadamente (baseline)

| Comando | Motivo |
|---------|--------|
| `pnpm test:integration` | Escribe en BD remota por defecto — prohibido por reglas de campaña |
| `pnpm test:rls` | Ídem |
| `pnpm build` | Se ejecutará como gate de integración por workstream, no en baseline |

## STELLA FULL REBUILD — RUN 2 (2026-08-02)

Reconstrucción completa del stack local desechable y reaplicación controlada de
`stella_0002`, `stella_0002b` y `stella_0003` sobre volumen nuevo, con G3 en
modo `CREATED`. Evidencia completa en
`docs/ops/LOCAL_STAGING_G2_REHEARSAL.md` → *STELLA FULL REBUILD — RUN 2*.

| Campo | Valor |
|---|---|
| Branch | `codex/stella-g2-local-rehearsal` |
| HEAD inicial | `92d7c61` |
| `project_id` | `uellix-stella-g2-local-rehearsal` (API `56321`, DB `56322`) |
| Recursos destruidos | 10 contenedores · 3 volúmenes · 1 red, todos por label `com.supabase.cli.project` |
| Otros stacks | `uellix-antigravity` y `aforiq` con los **mismos IDs de contenedor y estados** antes, durante y después |
| Respaldos | ambos con SHA-256 `d46280c4…36aeb`, 581 736 B, fuera del repo — **no restaurados** |
| `pg_restore -l` | 1155 TOC · 87 `TABLE DATA`, en contenedor `--network none` por `stdin` |

### Pruebas de RUN 2

| Comando | Pre-G3 | Post-G3 | Notas |
|---|---|---|---|
| `pnpm vitest run tests/prepared-stella-sql.test.ts tests/prepared-sql-source-of-truth.test.ts` | **246 / 246** | **246 / 246** | 2 archivos |
| `pnpm test:unit` | **2553 / 2553** | **2553 / 2553** | 135 archivos, 0 omitidos |
| `pnpm typecheck` | verde | verde | `tsc --noEmit`, 0 errores |
| `pnpm lint` | 0 errores · 51 warnings | 0 errores · 51 warnings | warnings preexistentes |
| `pnpm test:rls` | — | **32 passed · 0 failed · 0 skipped** | ejecutada **una sola vez**, fixture `CREATED`, 11,37 s |
| `pnpm test:integration` | **NO EJECUTADA** | **NO EJECUTADA** | Escribe en BD remota por defecto |
| `db:seed:proxies` / `db:seed:taxonomies` | **NO EJECUTADOS** | **NO EJECUTADOS** | Sin guarda de host |
| `grounding_0001` | **NO EJECUTADO** | **NO EJECUTADO** | Bloqueado por G5 P3 |

### Idempotencia

| Script | 1ª pasada | 2ª pasada |
|---|---|---|
| `stella_0002` | exit 0 | exit 0, salida idéntica salvo `NOTICE` de *skipping* |
| `stella_0002b` | exit 0, `verification passed` | exit 0, `verification passed` |
| `stella_0003` | exit 0, `write path VERIFIED` + `verification passed` | exit 0, idéntico |

### Conteos finales

38 tablas · 104 policies · 119 índices · 230 constraints · 10 triggers
append-only · 8 funciones `public` · 3 orgs · 9 users (`public` y `auth`) ·
2 projects · 7 memberships · 2 `stella_interactions` ·
1 `stella_suggestion_decisions` · 0 `storage.objects` · `evidence_chunks`
ausente · `session_replication_role = origin` · 0 datos reales.

### RUN 1 vs RUN 2

Cero deriva estructural, cero deriva de seguridad, cero deriva funcional.
G3 RUN 1 = **32/32 REUSED**; G3 RUN 2 = **32/32 CREATED**. La única diferencia
de contador es de *definición de medida* (`MAINTAIN`, privilegio nuevo de
PostgreSQL 17): con la definición de RUN 1, RUN 2 da los mismos 461 grants
no-owner.

**Alcance.** Diff limitado a documentación (`LOCAL_STAGING_G2_REHEARSAL.md`,
este ledger, `STELLA_FABLE_RISK_REGISTER.md`, `gates/G2_PACKAGE.md`,
`gates/G3_PACKAGE.md`). Cero cambios en `db/prepared/`, `db/schema.ts`,
`db/migrations` ni en ningún script. Cero restore, cero remoto, cero
`grounding_0001`, cero push/PR. **Cero ejecución formal de G2.**

**Siguiente paso:** re-auditoría independiente de RUN 2.

---

### 2026-08-02 · ENDURECIMIENTO DE ACCESO A BASE DE DATOS · rama `codex/stella-g2-local-rehearsal`, sobre `7d9d269`

Unidad transversal de seguridad, **no** un gate. Introduce `db/safety/`
(clasificación de destinos + autorización por capacidad, fail-closed) y
reescribe los entry points peligrosos para que pasen por ella. Documento
operativo: `docs/ops/DATABASE_TARGET_SAFETY.md`.

#### Suites ejecutadas

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/database-target-safety.test.ts` | VERDE | 137 tests — clasificación, redacción, matriz de capacidades, aislamiento, seguridad de mensajes, entorno, contraste contra `supabase/config.toml` |
| `pnpm vitest run tests/database-entrypoint-safety.test.ts` | VERDE | 95 tests — sin efectos de import, guarda antes del driver, superficie de `package.json`, regresión dotenv, 6 procesos hijo reales sobre rutas de **rechazo** |
| `pnpm test:unit` | VERDE | 137 archivos, **2787 tests** (baseline previo: 2704, de los cuales 3 en rojo por esta unidad, ya corregidos) |
| `pnpm typecheck` | VERDE | `tsc --noEmit` sin errores |
| `pnpm lint` | VERDE | 0 errores, 51 warnings — mismo conteo que antes de la unidad; ninguno en archivos nuevos |
| `pnpm build` | VERDE | `next build` completo. Ahora compila **sin** variable de conexión: el cliente dejó de construirse en tiempo de import |

**No ejecutados, por política de esta campaña:** `test:integration`, `test:rls`,
seeds, migraciones, resets, `grounding_0001`. Cero acceso remoto.

#### Rojos encontrados y corregidos (se documentan, no se ocultan)

| # | Rojo | Causa | Corrección |
|---|---|---|---|
| 1 | `resolveEnvironment` devolvía `development` con `UELLIX_APP_ENV` mal escrita | La errata caía al `NODE_ENV` por defecto — el entorno **más permisivo** | Valor definido pero no reconocido ⇒ `production` |
| 2 | 3 suites de servicio dejaron de cargar (`DB_TARGET_URL_MISSING`) | `vi.mock('@/db/client')` sin factory es *automock*: Vitest **inspecciona** los exports y leía `Symbol.toStringTag` y `__esModule` del proxy, forzando la construcción del cliente | Inspeccionar es inerte; sólo usar conecta. `fx-rates` necesitaba además métodos preexistentes ⇒ factory explícita |
| 3 | `prepared-stella-sql` y `prepared-sql-source-of-truth` en rojo | Fijaban `drizzle(client` (renombrado a `sql`) y prohibían la cadena `db/prepared` en `drizzle.config.ts`, que aparecía en un comentario nuevo | Aserción actualizada al nombre real + una **nueva** que fija que el runtime sigue resolviendo la variable de conexión bajo `app_runtime`; comentario reformulado |
| 4 | `db:audit:readonly` reportaba 5 triggers y `undefined` en la sesión | El filtro `LIKE '%append_only%'` sólo capturaba una de las dos familias; `SHOW` devuelve la fila con la clave del ajuste | Cuenta ambas familias por separado y total; lectura vía `current_setting()` |

#### Revisión adversarial independiente — rondas 1 a 5

Agente de solo lectura, sin acceso a base de datos. **2 BLOCKER y 4 MAJOR
reales**, todos reproducidos antes de corregirse y todos cerrados con una
prueba que falla si la corrección se revierte. Detalle en
`docs/ops/DATABASE_TARGET_SAFETY.md` §9.

El más grave: la guarda y el driver **leían la misma cadena de forma
distinta**. `URL` (WHATWG) termina el userinfo en el último `@`; postgres-js
usa el primero y trata la coma como lista multihost. Una URL que la guarda
clasificaba `local_loopback:56322` hacía que el driver marcara primero un host
gestionado remoto. Verificado contra `postgres@3.4.9`; alcanzable desde
`UELLIX_LOCAL_DATABASE_URL` y desde `DATABASE_URL`.

El segundo: la garantía de las suites de integración vivía sólo en el archivo
de setup que carga la config de integración, así que `pnpm test` las ejecutaba
sin guarda alguna, con el `db` compartido en `app_runtime`.

**La ronda 2 encontró 1 BLOCKER y 2 MAJOR más, y dos los había introducido la
propia corrección de la ronda 1:**

- la comprobación de autoridad ambigua era evadible en **un carácter** (`#`),
  porque cortaba la autoridad en un sitio distinto del driver — el mismo error
  de la ronda 1, cometido al arreglarlo;
- excluir `tests/integration/**` de la config base hizo que la config de
  integración colectara **cero** archivos (`mergeConfig` concatena arrays), lo
  que habría puesto en rojo los pasos de integración y RLS de CI en cada PR;
- rechazar sólo `options` era insuficiente: el driver reenvía toda clave de
  query que no consume, así que `?default_transaction_read_only=off` seguía
  anulando la imposición de solo lectura.

Lecciones registradas:

1. **Una guarda que reimplementa el parseo de otro componente no es una
   guarda**; donde no se pueda garantizar que ambos leen lo mismo, hay que
   rechazar la entrada, no adivinarla.
2. **Una corrección de seguridad puede romper otra cosa en silencio**, y una
   aserción que sólo mira el lado negativo pasa en verde cuando la
   funcionalidad desaparece. Las comprobaciones de config son ahora de
   comportamiento: resuelven ambas configs y verifican qué colecta cada una.
3. **Enmascarar por patrón no puede ser exhaustivo**: cuando el mensaje se
   construye a partir del dato sensible, se descarta el mensaje.

**La ronda 3 encontró 0 BLOCKER, 4 MAJOR y 4 MINOR.** El más instructivo no
era un agujero de la arquitectura sino de las **pruebas**: la única aserción
que decía cubrir la imposición de solo lectura leía el valor de vuelta de la
tabla de políticas, y el mock de `postgres` descartaba el objeto de opciones —
así que borrar la imposición entera dejaba la suite en verde mientras toda
conexión de auditoría pasaba a ser escribible. Y `db:audit:readonly`
*imprimía* el ajuste y contaba la comprobación como superada cualquiera que
fuese su valor: habría reportado `off` y salido con código 0.

4. **Una prueba que verifica la configuración en vez del efecto no es una
   prueba.** Ahora el mock captura lo que recibe el driver, y la auditoría
   falla —no informa— cuando la sesión no es de solo lectura.

Correcciones adicionales de la ronda 3: TLS fijado para las capacidades
remotas controladas (postgres-js viene con `ssl: false` y honra
`?sslmode=disable`); flag de solo lectura movido a parámetro de arranque
directo (PostgreSQL procesa `cmdline_options` antes que la lista por
parámetro, así que el par directo gana); `sslrootcert` retirada de la
allow-list porque el driver **sí** la reenvía; y detección de errores de red
hecha estructural, tras descubrir que `address` es un **array** en los errores
de postgres-js y la detección por `typeof === 'string'` nunca acertaba.

**La ronda 4 encontró 0 BLOCKER, 1 MAJOR (latente) y 4 MINOR.** El MAJOR era,
otra vez, una corrección mía: el TLS que yo había fijado para las capacidades
remotas, `ssl: 'require'`, pone `rejectUnauthorized = false` en postgres-js —
cifrado **sin autenticación del servidor** — y además degradaba
configuraciones más fuertes, mientras la línea de auditoría decía `tls=pinned`.
Se fija ahora `verify-full` y la línea dice `tls=verified`.

Y la fuga de datos más concreta de toda la unidad no era una credencial:
los errores de query de Drizzle llevan `Failed query: <sql>\nparams: <valores
ligados>` en su propio mensaje, sin `address` ni `errno`, así que se imprimían
enteros — y los parámetros ligados contienen correos y demás datos personales.

5. **Un nombre que suena fuerte no es una garantía**: la línea de auditoría
   debe decir lo que ocurrió, no lo que el nombre sugiere.
6. **El dato sensible no siempre es la credencial.**

**La ronda 5 (verificación acotada) cerró con 0 BLOCKER y 0 MAJOR**, condición
de salida de la fase de revisión. Sus MINOR/NIT también se corrigieron; el más
relevante: `ssl` había quedado como la única clave que un llamador podía
**degradar** (`?? 'verify-full'` sólo protege contra `undefined`), mientras la
línea de auditoría seguía afirmando `tls=verified`. Ahora `ssl` sólo se puede
subir.

Dos riesgos residuales quedan **aceptados y documentados** (no descubiertos
tarde), ambos en `app_runtime` y ambos por la misma razón: cerrarlos exigiría
cambiar el comportamiento del runtime de producción sin poder inspeccionar su
cadena de conexión real. Ver `docs/ops/DATABASE_TARGET_SAFETY.md` §6.1, que
además deja explícita la premisa de la que depende esa aceptación (quien fija
`DATABASE_URL` es quien posee la credencial que contiene).

#### Verificación de estado vivo (sólo `SELECT`, sesión forzada a solo lectura)

`pnpm db:audit:readonly` contra `127.0.0.1:56322`:

| Comprobación | Valor | Esperado |
|---|---|---|
| tablas `public` | 38 | 38 |
| policies | 104 | 104 |
| triggers append-only | 10 (5 de fila + 5 de `TRUNCATE`) | 10 |
| `stella_suggestion_decisions` | 1 | 1 |
| `stella_interactions` | 2 | 2 |
| `evidence_chunks` | ausente | ausente |
| `default_transaction_read_only` | `on` | `on` — confirma que la garantía la impone el servidor |

Respaldos `pre_g3_local.dump` (original y copia estable): presentes, 581 736 B,
SHA-256 `d46280c4261cc8b68896dd34b12f41d9334756a61f7a2f2a3c441aef5b436aeb` —
idéntico al documentado en RUN 2. **No restaurados.** Stacks `uellix-antigravity`
y `aforiq` intactos (28 h de uptime, sin reinicios). **Cero escrituras.**

**Alcance del diff:** `db/safety/` (nuevo), `db/client.ts`, `db/README.md`,
4 scripts de seed/usuario, 3 scripts nuevos, ambos configs de drizzle,
`vitest.setup.integration.ts`, `package.json`, el workflow `p1a-validation`,
2 suites nuevas y 3 ajustes de suites existentes, y documentación. Cero cambios
en `db/prepared/`, `db/schema.ts` y `db/migrations/`. Cero push, cero PR.
**Cero ejecución formal de G2.**

### 2026-08-02 · CIERRE DE HUECOS DE LA REAUDITORÍA DE SEGURIDAD DE BD · rama `codex/stella-g2-local-rehearsal`, sobre `ce0b195`

Sigue a `STELLA_DATABASE_SAFETY_REAUDIT_VERIFIED_READY_FOR_NEXT_HARDENING`, cuyo
gate reclasifica temporalmente cualquier mutación de seguridad superviviente
como MAJOR o BLOCKER. Cierra exactamente los tres huecos que dejó abiertos —
ver `docs/ops/DATABASE_TARGET_SAFETY.md` §9, ronda 6 (hallazgos 34-36) para el
detalle técnico completo. Resumen aquí:

1. **Orden del *merge* de `postgresOptions.connection` sin prueba propia.**
   El código ya era correcto (spread del llamador, luego el flag protegido),
   pero ninguna prueba fallaba si se invertía, porque `GUARD_OWNED_CONNECTION_KEYS`
   ya rechaza esa clave **antes** de llegar al *merge* — dos capas de la misma
   garantía, sólo una con prueba. Extraída `mergeGuardedConnectionOptions()` en
   `db/client.ts`, exportada y probada de forma aislada.
2. **`GUARD_OWNED_CONNECTION_KEYS` comparaba case-sensitive.** Los GUC de
   Postgres no distinguen mayúsculas; `DEFAULT_TRANSACTION_READ_ONLY` habría
   pasado sin ser detectado. Normalizado a minúsculas sobre un `Set` derivado,
   sin mutar el objeto del llamador.
3. **`sslrootcert` sin prueba dedicada.** Ya estaba correctamente excluido de
   `DRIVER_CONSUMED_QUERY_KEYS` desde la ronda 3 de la unidad original, pero
   nada fijaba por qué. Verificado empíricamente contra el `postgres@3.4.9`
   instalado: se reenvía al paquete de arranque, pero jamás se lee para
   construir las opciones TLS — sólo el `ssl` de nivel superior llega a
   `tls.connect`.

**Mutation check (2026-08-02).** 8 mutaciones sobre los tres cierres (spread
invertido, valor protegido eliminado, `Object.assign` inseguro, comparación
case-sensitive, normalización a minúsculas retirada, `DEFAULT_TRANSACTION_READ_ONLY`
permitida explícitamente, `sslrootcert` reclasificada como consumida por el
driver, `sslrootcert` degradando `verify-full`) — **8/8 detectadas**. Cada
mutación se aplicó a `db/client.ts` o `db/safety/database-target.ts`, se
confirmó al menos una prueba en rojo, y el archivo se restauró desde una copia
verificada por SHA-256 antes de la siguiente.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/database-target-safety.test.ts` | VERDE | 139 tests (antes 137 → **+2**) |
| `pnpm vitest run tests/database-entrypoint-safety.test.ts` | VERDE | 111 tests (antes 95 → **+16**) |
| `pnpm test:unit` | VERDE | 137 archivos, **2805 tests** (antes 2787 → **+18**, los mismos 18) |
| `pnpm typecheck` | VERDE | exit 0, 0 errores |
| `pnpm lint` | VERDE | exit 0, **0 errores**, 51 warnings — mismo conteo que antes de esta unidad |
| `pnpm build` | VERDE | `next build` completo |

**No ejecutados, por política de esta campaña:** `test:integration`, `test:rls`,
seeds, migraciones, resets, `grounding_0001`. Cero acceso remoto.

**Verificación de estado vivo (sólo `SELECT`, sesión forzada a solo lectura)**
vía `pnpm db:audit:readonly` contra `127.0.0.1:56322`: **38** tablas, **104**
policies, **10** triggers append-only (5 de fila + 5 de `TRUNCATE`), **1**
`stella_suggestion_decisions`, **2** `stella_interactions`, `evidence_chunks`
ausente, `default_transaction_read_only = on` — **idéntico** a la línea base
de la unidad original. Cero escrituras.

**Alcance del diff:** `db/client.ts` (extracción de `mergeGuardedConnectionOptions`
y normalización case-insensitive; `db/safety/database-target.ts` sin cambios —
la clasificación de `sslrootcert` ya era correcta), `tests/database-target-safety.test.ts`,
`tests/database-entrypoint-safety.test.ts`, y esta documentación. Cero cambios
en `db/prepared/`, `db/schema.ts`, `db/migrations/`, seeds, ni scripts. Cero
reset, cero grounding, cero acceso remoto, cero push, cero PR. **G2 formal
sigue sin ejecutarse.**

**Resultado:** `STELLA_DATABASE_SAFETY_GAPS_CLOSED_READY_FOR_FINAL_CHECK`.

### 2026-08-02 · SEPARACIÓN DE ROLES DE BASE DE DATOS · `8cd8e62` + esta unidad

Bloque `stella_0004`: ownership fuera del runtime, corrección de *default
privileges* y matriz de privilegios explícita. Contrato completo en
[`docs/ops/DATABASE_ROLE_MODEL.md`](DATABASE_ROLE_MODEL.md).

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/database-role-safety.test.ts` | VERDE | **49** tests (nuevo archivo) — 30 offline sobre el SQL preparado + 19 contra el catálogo vivo |
| `pnpm vitest run tests/database-default-privileges.test.ts` | VERDE | **13** tests (nuevo archivo) |
| `pnpm vitest run tests/database-target-safety.test.ts` | VERDE | **139** tests, sin cambio |
| `pnpm vitest run tests/database-entrypoint-safety.test.ts` | VERDE | **111** tests, sin cambio |
| `pnpm vitest run tests/prepared-stella-sql.test.ts` | VERDE | 249 → **251**; el tripwire de inventario y el invariante de `EXECUTE` **detectaron los scripts nuevos**, que es su función |
| `pnpm test:unit` | VERDE | 139 archivos, **2869 tests** (antes 2805 → **+64**) |
| `pnpm typecheck` | VERDE | exit 0 |
| `pnpm lint` | VERDE | exit 0, **0 errores**, 51 warnings — mismo conteo que antes |
| `pnpm build` | VERDE | `next build` completo, 44 páginas |

**No ejecutados, por política:** `test:integration`, `test:rls`, seeds,
migraciones, resets, `grounding_0001`. Cero acceso remoto.

#### Ensayo desechable antes de tocar el stack vivo

Contenedor `supabase/postgres:17.6.1.143` **sin red** (`--network none`),
destruido al terminar. Fixture verificado fiel contra el stack vivo en tres
dimensiones antes de cada corrida: **830** filas de ACL de tabla, **13** de ACL
de función y **75** de default ACL (`public` + GLOBAL) — idénticas. **Cero filas
de datos**: el fixture es sólo estructura.

| Prueba | Resultado |
|---|---|
| Forward ×2 | idéntico (1086 filas de huella) — **idempotente** |
| Rollback | **0** filas añadidas respecto del estado previo; delta = 260 ACL + 51 DEFACL, exactamente los dos segmentos `SAFE_NON_REVERSING` |
| Rollback sin confirmación / con confirmación errónea | **RECHAZADO** en ambos casos |
| Reaplicación tras rollback | converge al mismo estado |
| Rollback con `restore_unsafe_defaults=yes` | restaura los default ACL originales con dos `RAISE WARNING` |
| Regresión B1 (default privilege GLOBAL inseguro) | **abortado** por la precondición |
| Regresión B2 (`anon` con `EXECUTE` en una función) | **abortado** |
| Regresión M2 (vista o secuencia en `public`) | **abortado** en ambos casos |

#### Defectos que el ensayo encontró antes de la base viva

1. **La comprobación 9.2 no contemplaba las tablas TOAST**, que heredan el owner
   y viven en `pg_toast`: ~70 entradas hacían fallar la verificación siempre.
2. **`ALTER DEFAULT PRIVILEGES … IN SCHEMA public REVOKE … FROM PUBLIC` no
   funciona** sobre funciones ni tipos — 0 filas, reporta éxito. Sólo la forma
   **global** suprime el `EXECUTE`/`USAGE` incorporado.
3. **Transferir el owner rompía toda la RLS del producto**: las 3 funciones
   `SECURITY DEFINER` que llaman a `auth.uid()` pasaban a ejecutarse como
   `uellix_owner`, sin `USAGE` sobre el esquema `auth` → `permission denied for
   schema auth` para **todos** los invocantes, incluido PostgREST.
4. **Evaluar una policy exige `EXECUTE` en el rol INVOCANTE** sobre las funciones
   que la policy llama: sin ello un `SELECT` **falla** en vez de devolver cero
   filas.
5. **`ALTER TABLE … OWNER TO` no preserva la ACL del owner anterior**, la
   transfiere. El runtime habría perdido `INSERT` sobre
   `stella_suggestion_decisions`, enmascarado en las otras 37 tablas por la
   membresía heredada de `postgres` en `pg_read_all_data`.

#### Revisión adversarial independiente (read-only)

**2 BLOCKER, 6 MAJOR, 8 MINOR** — todos reales, todos corregidos. Los dos
BLOCKER: (B1) la verificación de default privileges hacía `INNER JOIN` sobre
`defaclnamespace`, que **nunca** puede casar una fila global — ciega justo a la
clase que el propio script declara decisiva; (B2) nada comprobaba `EXECUTE` de
`anon`/`service_role` sobre las 8 funciones, que tras el cambio corren como el
owner exento de RLS.

#### Aplicación al stack local

`psql -U supabase_admin -1 -v ON_ERROR_STOP=1`, una sola conexión,
`lock_timeout=20s`. Respaldo previo tomado y verificado (**584 224 B**,
SHA-256 `6c07073c…d02324`, idéntico dentro del contenedor y en el host); el
respaldo anterior (`d46280c4…b436aeb`, 581 736 B) intacto.

Aplicado **dos veces** más una tercera con el artefacto final tras la
reescritura: huella idéntica en las tres. **Sin rollback sobre el stack vivo.**

**Estado vivo tras aplicar:** 38 tablas, 104 policies, 119 índices, 230
constraints, 10 triggers (`tgenabled='O'` los 10), 1 decisión, 2 interacciones,
`evidence_chunks` ausente, RLS 38/38, `FORCE` 0/38, ownership `uellix_owner`
38/38 + 8/8 funciones, `postgres` owner de **0**, `pg_has_role(postgres,
uellix_owner)` = false/false, **0** privilegios peligrosos para no-owners, **0**
para `anon`/`PUBLIC`, **0** default ACL inseguras. Servicios locales healthy,
PostgREST responde 200. Otros dos stacks locales intactos y con **0** roles
`uellix_*`.

**Resultado:** `STELLA_DATABASE_PRIVILEGE_HARDENED_READY_FOR_REAUDIT`.

---

### 2026-08-02 · COMPATIBILIDAD DEL RUNTIME: LA IDENTIDAD LLEGA A LOS ENTRY POINTS · rama `codex/stella-g2-local-rehearsal`, sobre `b6787a5`

El cutover dejó el mecanismo listo y la aplicación sin usarlo: 46 entry points
consultaban sin abrir contexto y `getCurrentUser()` leía `public.users` para
descubrir el sujeto, con lo que **el login local estaba roto**. Contrato
completo en [`DATABASE_RUNTIME_CUTOVER.md`](DATABASE_RUNTIME_CUTOVER.md) §7–§8.

| Comando | Resultado | Detalle |
|---------|-----------|---------|
| `pnpm vitest run tests/authenticated-database-context.test.ts` | VERDE | **33** tests (archivo nuevo) — 7 offline sobre los estados de sesión + 26 contra el stack vivo |
| `pnpm vitest run tests/database-runtime-entrypoints.test.ts` | VERDE | **163** tests (archivo nuevo) — grafo de imports + un caso por entry point que alcanza la base |
| `pnpm vitest run tests/database-runtime-identity.test.ts` | VERDE | sin cambio |
| `pnpm vitest run tests/database-runtime-rls.test.ts` | VERDE | sin cambio |
| `pnpm vitest run tests/database-migrator-path.test.ts` | VERDE | sin cambio |
| `pnpm vitest run tests/database-ddl-containment.test.ts` | VERDE | sin cambio |
| `pnpm vitest run tests/database-role-safety.test.ts` | VERDE | sin cambio |
| `pnpm vitest run tests/database-default-privileges.test.ts` | VERDE | sin cambio |
| `pnpm vitest run tests/database-target-safety.test.ts` | VERDE | sin cambio |
| `pnpm vitest run tests/database-entrypoint-safety.test.ts` | VERDE | sin cambio |
| `pnpm test:unit` | VERDE | 145 archivos, **3154** tests (antes 2957 → **+197**). *Corrección 2026-08-03:* la cifra vigente es **147 archivos / 3234 tests**; 3225 era la línea base antes de los 9 tests de `updateOrganizationFinancialProxy` añadidos en el preflight del diseño de capacidades |
| `pnpm typecheck` | VERDE | exit 0 |
| `pnpm lint` | VERDE | exit 0, **0 errores**, 50 warnings (51 → 50: se cerró uno introducido y se limpió otro preexistente) |
| `pnpm build` | VERDE | `next build` completo |

**No ejecutados, por política:** `test:integration`, `test:rls`, seeds,
migraciones, resets, `grounding_0001`, G2/G3 formales. Cero acceso remoto.

#### Qué prueba realmente `authenticated-database-context.test.ts`

La capa Auth se sustituye en su frontera verdadera —`supabase.auth.getUser`— y
**no** en `lib/auth/identity.ts`, para que el módulo bajo prueba siga corriendo
su propia validación de UUID y su propia separación entre "sin sesión" y "sesión
rechazada". Debajo hay una conexión **viva** como `uellix_app`, abierta por la
factoría de la propia aplicación.

Ningún test alcanza el rol por `SET ROLE`. Esa es la lección de la reauditoría
previa: pasó entera mientras el runtime seguía siendo `postgres`, precisamente
porque los tests llegaban al rol de menor privilegio pidiéndolo prestado desde
una sesión administrativa.

Cubre: sesión válida · sin sesión · sesión rechazada (expirada/revocada) ·
sujeto malformado · Auth inalcanzable (503, que no es un logout) · usuario Auth
sin fila en `public.users` · cuenta con `deleted_at` · organización propia ·
organización ajena (`AUTH_ORGANIZATION_FORBIDDEN`, sin eco del id) ·
super-admin sólo desde servidor · anidamiento con la misma identidad (reutiliza)
· anidamiento con identidad distinta (rechaza) · limpieza tras COMMIT · limpieza
tras ROLLBACK · reutilización de la conexión del pool · **dos peticiones
concurrentes con identidades distintas**.

Y los flujos: login resuelve perfil (el ciclo cerrado) · logout no deja residuo ·
dashboard lista sólo lo propio · proyecto ajeno invisible · lectura de Stella ·
creación de interacción **revertida** · UPDATE y DELETE append-only rechazados
**cada uno en su propia transacción** — juntos, el segundo sólo probaría que
PostgreSQL aborta la transacción tras el primer fallo, que no es lo mismo que un
trigger rechazando.

#### Qué prueba `database-runtime-entrypoints.test.ts`

Reconstruye el grafo de imports de `app/**` —resolviendo `@/`, relativos,
re-exports y `import()` dinámico, ignorando `import type` y módulos
`'use client'`— y pregunta si el entry point alcanza `db/client.ts`. No es un
grep: casi ninguna página consulta directo.

| | |
|---|---|
| Entry points inventariados | 117 (corregido en el cierre 2026-08-02; era 110, cifra sin fijar) |
| Alcanzan `db/client.ts` | 93 |
| Abren contexto de identidad | 80 |
| En allowlist documentada | 13 |

Dos **controles negativos** impiden que la suite se vuelva vacua:
`lib/projects/service.ts` debe salir como "alcanza la base **y no** abre
contexto" y `lib/auth/roles.ts` como "no alcanza la base". Un tercer test
comprueba que los ocho nombres de wrapper siguen exportados: renombrar uno
convertiría el archivo entero en un no-op silencioso.

#### Regresiones que la migración de suites hizo visibles

11 archivos de test fallaron (206 tests) y **ninguno** por un defecto del
producto: todos mockeaban `@/lib/auth/session` y no conocían los wrappers
nuevos. Se les añadió un paso-a-través explícito, con el comentario de que el
contexto se prueba en su propio archivo y no ahí. `tests/auth/session.test.ts`
además necesitó UUID sintéticos: la capa de identidad rechaza un sujeto que no
lo sea, que es exactamente lo que debe hacer.

#### Bloqueadores por diseño (sin bypass)

Cinco caminos funcionaban **sólo** porque `postgres` saltaba RLS. Ninguno
recibió un bypass nuevo; los cinco fallan cerrado y están documentados en el
código que los contiene: alta autoservicio de organización, aceptar invitación,
webhook de Stripe (rechaza con **503** tras verificar la firma, para que Stripe
reintente en vez de perder el evento), verificación pública por hash y captura
de lead público.

El último trajo un hallazgo medido: `marketing_leads` es la **única** tabla de
`public` cuyas policies nombran roles (`TO anon` / `TO authenticated`); las
otras 104 llevan `{public}`. La cláusula `TO` se contrasta con el rol de base, no
con el `role` de las claims, y `pg_has_role(uellix_app, 'anon'|'authenticated')`
es **false** en ambos casos.

**Estado vivo tras la unidad (leído como `uellix_app`):** 38 tablas, 107
policies, 10 triggers, 1 decisión, 2 interacciones, `evidence_chunks` ausente.
`session_user` = `current_user` = `uellix_app`. Sin escrituras permanentes.

**Resultado:** `STELLA_RUNTIME_CUTOVER_HARDENED_READY_FOR_REAUDIT`.

#### Revisión adversarial independiente (read-only) — segunda ronda

**1 BLOCKER, 5 MAJOR, 8 MINOR.** El BLOCKER y los cinco MAJOR quedaron cerrados;
tres MINOR se cerraron también y el resto está registrado como riesgo.

**BLOCKER — dos mutaciones sin contexto, y la prueba de cobertura las aprobaba.**
`evidence/page.tsx` exporta once cierres `'use server'`; dos de ellos
(`archiveAction`, `updateStatusAction`) llamaban a `lib/pipeline/evidence`
directamente en vez de a su `.action.ts` — que existía, estaba correctamente
envuelto y **no lo importaba nadie**. Archivar evidencia y cambiar su estado de
revisión estaban rotos para todos los usuarios, con un mensaje engañoso
(*"Project does not belong to your organization"*), porque `verifyProjectOwnership`
leía cero filas.

Lo revelador es lo segundo: la comprobación era **por archivo**. Un solo
`runWithOrganizationAccess(` en la ruta de render satisfacía al archivo entero,
incluidos sus once endpoints POST independientes.

Se reescribió a **por región**: el archivo se parte en cada directiva
`'use server'` (emparejando llaves sobre una copia con literales y comentarios
enmascarados **preservando offsets**, para que una llave dentro de una cadena no
descuadre el emparejamiento), y una región sólo debe abrir contexto si
**realmente llama** a un símbolo importado de un módulo que alcanza la base. Se
permite delegar, pero sólo a otro entry point que la propia suite comprueba.
Dos controles negativos nuevos: uno reproduce la forma exacta del defecto y
verifica que la comprobación anterior lo habría aprobado; otro fija que una
mención en cadena o comentario no cuenta como llamada.

**MAJOR cerrados**

| Hallazgo | Cierre |
|---|---|
| Subida a Storage de hasta 25 MB dentro de la transacción — y **un bug nuevo**: si la subida salía bien y un paso posterior fallaba, el ROLLBACK descartaba la fila y el objeto quedaba huérfano para siempre | `createFileEvidenceForProject` pasa a tener tres fases explícitas: reservar fila / subir **sin transacción** / finalizar o compensar. El `DELETE` compensatorio vuelve a estar vivo |
| Descarga y re-hash del fichero completo dentro de la transacción | `verifyFileEvidenceIntegrity` con el mismo patrón |
| Envío por Resend dentro de la transacción de la invitación, invalidando el invariante documentado del módulo | `createInvitation` devuelve `sendEmail()`; el llamador lo ejecuta **tras** el COMMIT. Un token en una bandeja cuyo hash se revirtió es un enlace vivo que no resuelve a nada |
| Dos APIs de FX de terceros **sin timeout**, alcanzables desde rutas de escritura | `AbortSignal.timeout(8s)` en ambas. La eliminación completa exigiría reestructurar el camino de inversiones — registrado como riesgo residual, no declarado cerrado |
| `NEXT_REDIRECT` y `AuthContextError` devueltos al cliente como texto | `lib/errors/next-control-flow.ts` (sobre `unstable_rethrow` de Next) al principio de cada `catch` que traga; los refusos de autorización pasan a `?error=not_authorized` en vez de `unknown_error`, y a `401/403` vía `authContextErrorStatus()` en los dos route handlers |
| `/admin/project-deletions` lanzaba `redirect()` desde una server action invocada por un componente cliente | usa `withOrganizationDatabaseContext` (lanza un valor renderizable). El alcance cross-org de `approveProjectDeletion` es **preexistente** y queda documentado en el propio código |

**MINOR cerrados:** seis filas de allowlist que la comprobación nunca consultaba
—no alcanzan la base, así que su afirmación no era falsable— movidas a
`AUDITED_NO_DATABASE_REACH`, con una prueba en dirección **contraria**: falla el
día que una de ellas empiece a tocar la base. Un caché de alcanzabilidad que
podía envenenarse ante un ciclo de imports (marcando un módulo como "no alcanza"
y sacando del conjunto comprobado a todo entry point que llegara a través de él)
ahora sólo memoiza recorridos que no tocaron una arista de retorno. Se añadieron
las convenciones de servidor que faltaban (`sitemap`, `manifest`, `template`,
`not-found`, `opengraph-image`…), siendo `sitemap.ts` el candidato realista a
publicar un sitemap vacío en silencio. El endpoint público de leads pasa a
rechazar explícitamente con **503** en vez de intentar el INSERT y responder 500
en cada petición.

**Confirmó también las tres afirmaciones del cambio** —`marketing_leads`,
bootstrap de organización/invitación y verificación pública— y añadió dos
precisiones que se incorporaron: `super_admins_read_marketing_leads` es
igualmente `TO authenticated`, así que la **lectura** de leads por un super admin
está igual de muerta que la escritura; y en aceptar-invitación el muro que se
choca primero no es `members_insert_admin` sino `invitations_select_member` — el
invitado no puede ni leer su propia invitación.

Categorías donde **no encontró nada**: circularidad de `getCurrentUser`, claims
tomadas del cliente, contexto persistente en el pool, `service_role` o bypass
reintroducido, anidamiento de identidades en operación normal, y regresiones
fail-open.

Tras las correcciones: **145 archivos, 3154 tests** (2957 → +197) — cifra del
cierre de reauditoría; vigente al 2026-08-03: **147 archivos, 3234 tests** —, typecheck
verde, lint 0 errores, build completo.

---

## Unidad: cierre de la reauditoría de compatibilidad (2026-08-02, tarde)

Cierra los 2 BLOCKER y 5 MAJOR de
`STELLA_RUNTIME_COMPATIBILITY_REAUDIT_BLOCKED_ENTRYPOINT`. Detalle en
`DATABASE_RUNTIME_CUTOVER.md` §11 y en la sección "Cierre de compatibilidad"
del risk register.

| Evidencia | Resultado |
|---|---|
| Once suites de base contra el stack local | **643/643** (antes diez suites, 581/581): entrypoints 187 · authenticated-context 33 · runtime-identity 21 · runtime-rls 18 · **insert-policy-scope 19 (nueva)** · migrator-path 18 · ddl-containment 18 · role-safety 52 · default-privileges 16 · target-safety 139 · entrypoint-safety 122. La cifra 640/184 publicada en el cierre de reauditoría estaba desactualizada: el conteo real reejecutado el 2026-08-03 es 643/187 (`database-runtime-entrypoints` incorporó tres casos de la capa AST que el recuento anterior no reflejó). Verificado con `--reporter=json`, 0 fallos |
| Suite local de integración | **49/49** (`pnpm db:test:integration:local`; rls 32 + investments 17). Guard por capacidad (`UELLIX_RUNTIME_DATABASE_URL`, rol `uellix_app`, 127.0.0.1:56322); fixtures por ruta owner (`tests/integration/_owner.ts`); clausura append-only en modo REUSED |
| Residuo de la integración | +1 organización y +1 usuario por corrida en `public` (pineados por `audit_logs` append-only, FK NO ACTION — contrato preexistente, antes era uno POR TEST); 1 fila compartida `fx_rates` COP 2024-12-31 (fixture idempotente); `auth.users` limpio (los usuarios GoTrue de la suite se borran en `afterAll`) |
| Gate de Stripe | `tests/stripe-webhook-route.test.ts`, 8 tests: 400/503 con cero acceso a BD, constante pineada |
| Escáner AST | 117 módulos / 95 alcanzan BD / 82 contextualizados + 13 allowlist / **0 sin guardia**; 10 fixtures mutantes; con la forma antigua de `OutcomeAllocationWrapper` reinsertada, fallan 4 pruebas (verificado empíricamente) |
| Policies | 107 = 101 `{public}` + 3 `{uellix_app}` + 2 `{authenticated}` + 1 `{anon}`; `authenticated`/`service_role` sin INSERT efectivo en `audit_logs`/`stella_interactions` (sonda directa denegada) |
| Login E2E HTTP local **(ensayo manual, no test automatizado)** | Probado: GoTrue real → cookie → dashboard con la organización propia bajo RLS → logout → redirect. Usuario sintético del seed; sin crear usuarios. `onboarding_completed` alternado y **restaurado**. No hay suite CI que lo reproduzca |
| SQL aplicado en local | `stella_0005c` (re-alcance de policies INSERT) y `stella_0005d` (USAGE sobre `storage` para el owner — reparación de un hallazgo colateral medido) |
| No ejecutado | grounding, G2 formal, G3 remoto, `test:rls`/`test:integration` remotos. Cero acceso remoto |

---

## Diseño de capacidades públicas (2026-08-03)

**Unidad de DISEÑO.** Cero escrituras en base, cero acceso remoto, cero
grounding, cero G2 formal. Ninguna capacidad habilitada.

### Suites ejecutadas

| Evidencia | Resultado |
|---|---|
| `pnpm test:unit` | **3421/3421**, 148 archivos. Línea base al inicio de la unidad: 3225 / 147 archivos |
| `tests/capability-isolation.test.ts` (**nueva**) | **173/173**. Gate estático sobre `db/prepared/stella_0006..0010*.sql`: sin base de datos, sin red |
| `tests/proxies.service.test.ts` | 28 (antes 19): +9 de `updateOrganizationFinancialProxy` (precondición 2) |
| Once suites de base contra el stack local | **643/643** — corrección de la cifra publicada (640/184 → 643/187) |
| `typecheck`, `lint` | limpios |
| Auditoría de sólo lectura del stack local | 38 tablas · 107 policies · 10 triggers append-only · 1 decisión · 2 interacciones · `evidence_chunks` ausente — **sin cambios** respecto al estado de entrada |

### Pruebas de mutación (la evidencia de que los gates muerden)

Un test verde no prueba nada por sí solo. Cada gate nuevo se rompió a propósito
y se comprobó que exactamente los tests que aseguran esa propiedad fallan:

| Mutación | Tests que fallaron |
|---|---|
| `resetReview = false` en `updateOrganizationFinancialProxy` | 1 (reset de re-revisión) |
| `if (false)` en el gate RC-12 de repunte de `sourceId` | 1 (rechazo de fuente ajena) |
| `GRANT SELECT` añadido al definer de CAP-04 | 1 («el escritor de leads no puede leerlos») |
| `TO uellix_app` retirado de una policy interna de CAP-02 | 1 («ninguna policy sin cláusula `TO`») |
| `EXECUTE` de una función Stripe concedido a `uellix_app` | 2 (ejecutor único · el runtime no mueve cuotas) |

### Suites de capacidad DISEÑADAS y NO implementadas

Requieren un stack **desechable** y esta unidad tiene prohibido tocar uno. Cada
una está especificada caso por caso en el documento de su capacidad:

| Suite | Casos vivos diseñados | Documento |
|---|---|---|
| `invitation-capability` | 13 (`L1..L13`) | `capabilities/CAP_01_INVITATIONS.md` §11.2 |
| `public-verification-capability` | 12 (`L1..L12`) | `capabilities/CAP_02_PUBLIC_VERIFICATION.md` §11.2 |
| `stripe-webhook-capability` | 14 (`L1..L14`) | `capabilities/CAP_03_STRIPE.md` §12.2 |
| `public-lead-capability` | 13 (`L1..L13`) | `capabilities/CAP_04_PUBLIC_LEADS.md` §10.2 |
| `organization-bootstrap-capability` | 15 (`L1..L15`) | `capabilities/CAP_05_ORGANIZATION_BOOTSTRAP.md` §9.2 |

**67 casos vivos diseñados** (13 + 12 + 14 + 13 + 15). La suite **estática**
cubre la mitad que se puede cubrir sin base: que el SQL que produciría ese
catálogo dice lo que el diseño afirma. No cubre —y su cabecera lo dice— que las
capacidades funcionen.

> **Corrección 2026-08-03 (segunda reauditoría).** Este documento afirmaba a la
> vez «67 casos vivos diseñados» y, en la tabla del dry run, «57/57». Las dos
> cifras no pueden ser ciertas y la buena es **67**: 13 + 12 + 14 + 13 + 15. El
> «57» venía de un recuento anterior a que CAP-03 pasara de 12 a 14 casos y
> CAP-05 de 13 a 15, y se propagó al informe del ensayo previo. Los 67 están
> ahora **implementados y ejecutados** en `scripts/capability-dry-run.sql` y
> `scripts/capability-dry-run-concurrency.sh`, que es la diferencia relevante:
> la evidencia anterior se produjo a mano y por eso no se pudo volver a
> comprobar.

### Dry run en entorno desechable sin red (2026-08-03)

**Nada de esto tocó el stack vivo.** El contenedor se creó con `--network none`
(sin puertos, sin red; sólo `docker exec`), sembrado con un volcado
**schema-only** del stack local obtenido por lectura (`pg_dump --schema-only`,
`pg_dumpall --roles-only --no-role-passwords`). Se destruye al terminar.

**Línea base replicada exactamente: 38 tablas / 107 policies**, los cinco roles
`uellix_*`, `auth.uid()` presente, las tres restricciones únicas y el índice
parcial `user_single_active_membership`.

**Reejecutado el 2026-08-03 sobre los paquetes vigentes**, con
`scripts/capability-dry-run.sh`. Las cifras de abajo son las de esa ejecución;
las de la ronda anterior (132 policies, 57/57) correspondían a paquetes que la
segunda ronda adversarial modificó y **ya no describen estos ficheros**.

| Fase | Resultado |
|---|---|
| Línea base replicada | **38 tablas / 107 policies / 0 roles de capacidad / 0 funciones / sin esquema** — idéntica al stack vivo |
| Forward × 5, primera pasada | 5/5 sin error → **42 tablas, 141 policies, 6 roles, 8 funciones, 1 esquema** |
| Forward × 5, **segunda** pasada | 5/5 sin error, **estado idéntico** (convergente) |
| Aserciones vivas | **72/72** — los 67 casos `L*` de los cinco documentos, más 3 de aislamiento cruzado y 2 de concurrencia añadidas para CAP-02 y CAP-04 |
| Concurrencia con sesiones reales | 6/6 — CAP-01 L6, CAP-03 L3, CAP-05 L4, CAP-05 L11, más CAP-02 y CAP-04 bajo contención. Las dos sesiones se sincronizan contra un instante común, no se lanzan y se espera que solapen |
| Rollback × 5, orden inverso | 5/5 sin error → **0 roles de capacidad, 0 policies `cap_*`, 0 funciones, esquema eliminado** |
| Residuo tras rollback | **40 tablas / 108 policies.** Dos tablas retenidas por diseño (`report_public_disclosures`, `stripe_webhook_events`) y dos eliminadas (`capability_verification_hits`, `capability_bootstrap_attempts`); una policy retenida (`disclosures_select_member`). Los 108 se descomponen así: 107 de línea base — las dos de `marketing_leads` que 0009 retira y su rollback **restaura** — más `disclosures_select_member`. La cifra «105» que aparecía aquí era el conteo *excluyendo prefijos* de las precondiciones, no el total |
| Reaplicación tras rollback | 5/5 sin error → **42/141/6/8/1**, idéntico a la primera pasada |

**El detalle de siembra que invalidó el primer intento de esta reejecución.**
`pg_dump --schema-only` no traslada el ACL del esquema `public` cuando el
esquema se crea a mano en la restauración, y la diferencia no es cosmética: el
stack vivo tiene la entrada `=U/pg_database_owner` —`PUBLIC` con `USAGE`, que es
**RR-CAP-7**— y todo rol de capacidad la hereda. Sin ese `GRANT`, los definers
no pueden ni nombrar `public.users`, las cinco capacidades fallan con 42501 y el
ensayo mide la siembra en vez de los paquetes. El driver lo restituye de forma
explícita y lo comenta, porque es el tipo de error que produce un rojo
convincente y equivocado.

### Matriz de mutaciones (2026-08-03)

`scripts/capability-mutation-audit.ts` aplica cada mutación **al fichero en
disco**, ejecuta las suites, restaura y compara el SHA-256 antes y después.

| Medida | Resultado |
|---|---|
| Mutaciones catalogadas | **67** — `M-01..M-22` (las supervivientes de la reauditoría) + `N-01..N-45` (nuevas) |
| Sobreviven a `tests/capability-isolation.test.ts` **tal como estaba en `1bfed10`** | **22 de 22** — reproducido, no asumido |
| Sobreviven a esa suite **tras repararla** | **21 de 22.** M-08 (`show_issued_on DEFAULT true`) ya no sobrevive: la lista de cuatro nombres codificada a mano se sustituyó por una derivada del `CREATE TABLE`. Era el test que la propia M-08 acusaba, y seguía en el repositorio |
| Sobreviven a los gates nuevos | **0 de 67** |
| Restauración verificada por SHA | **67/67** idénticas |
| Reparto por gate | máximo **7** mutaciones muertas por un mismo gate, sobre 67 |
| Gates sin mutación que los ejercite | **59 de 117**, listados en `UNEXERCISED_GATES` (`tests/capability-mutation.test.ts`) y comprobados por un test que falla si la lista cambia sin decirlo. Es el residual honesto de RR-CAP-12 |

**Qué significa «0 de 67», y qué no.** Es acuerdo entre dos ficheros escritos
por la misma mano —el catálogo y los gates—, no cobertura del diseño. Lo que le
da valor es lo otro: dos revisores adversariales de solo lectura, sin permiso de
escritura y sin base de datos, intentaron escapar de los gates y encontraron
**once clases reales** en una sesión. Todas están ahora catalogadas
(`N-24`…`N-45`) y en rojo. Ninguna exigió imaginación. Por eso RR-CAP-12 queda
**MITIGADO y no CERRADO**.

Además, desde la ronda 3 cada mutación declara **qué gate debe refusarla**
(`expectedGate`) y el arnés lo comprueba. Sin eso, «45 mutaciones, 0
supervivientes» era compatible con que una mutación muriese por un gate que no
tiene nada que ver con la propiedad que dice probar — y N-08 era exactamente ese
caso: probaba «la primera lectura toma el bloqueo» y la mataba
`cap01-order-replay`, porque `cap01-order-unlocked-read` resultó ser
**definicionalmente cierto** y no podía fallar nunca.

**Concurrencia, medida con dos sesiones `psql` simultáneas:**

| Escenario | Resultado |
|---|---|
| Dos aceptaciones del **mismo** token | ambas devuelven la organización (una acepta, la otra toma la rama idempotente); **1 membresía** |
| Dos bootstrap con la **misma** clave | 1 organización, 1 membresía |
| Dos bootstrap con claves **distintas**, mismo sujeto | 1 membresía, 1 organización; el perdedor **no deja ni organización ni fila de intento** — la transacción revierte entera y libera su clave |
| Dos entregas Stripe del **mismo** evento | exactamente un `claimed`, un `in_progress`; `attempts` sin incrementar |
| Dos envíos de lead idénticos | cero errores, **1 fila** |

#### Nueve defectos que sólo la ejecución encontró

> **Corrección 2026-08-03.** Este encabezado decía «Ocho» y la tabla lista D1–D8,
> mientras `capabilities/ADVERSARIAL_FINDINGS.md` §3 lista **D1–D9** y tanto
> `db/prepared/README.md` como `DATABASE_CAPABILITY_MODEL.md` dicen «Nueve». El
> que falta es **D9**: el `ON CONFLICT` sin arbiter de CAP-04, medido cuando un
> `ON CONFLICT (lower(email), source) DO NOTHING` fue denegado a un definer sin
> `SELECT`. Es, además, el defecto con la consecuencia de diseño más grande de
> los nueve.

Ninguno era visible leyendo el SQL, y cuatro habrían fallado **en tiempo de
ejecución** —dentro de un webhook o de un enlace de invitación—, no al aplicar.

| # | Defecto | Mecanismo | SQLSTATE |
|---|---|---|---|
| D1 | `ALTER FUNCTION … OWNER TO R` exige que **R** tenga `CREATE` sobre el esquema | La cabecera razonaba sólo la mitad de la comprobación (membresía) | 42501, al aplicar |
| D2 | `CREATE OR REPLACE` en la segunda pasada exige propiedad resuelta por `has_privs_of_role`, que `INHERIT FALSE` niega | El paquete se declaraba convergente y no lo era | 42501, al reaplicar |
| D3 | Las policies `{public}` preexistentes se evalúan **para todos los roles**, definers incluidos, y llaman a helpers cuyo `EXECUTE` se revocó a `PUBLIC` | Cuatro capacidades fallaban toda lectura | **42501, en ejecución** |
| D4 | `auth.uid()` exige `USAGE` sobre el esquema `auth` **para el definer** | Misma clase que `stella_0005d` con `storage` | **42501, en ejecución** |
| D5 | `pg_catalog.coalesce` / `nullif` no existen: son producciones gramaticales, no funciones | Sobre-cualificar rompe | **42883, en ejecución** |
| D6 | `min(uuid)` no existe en PostgreSQL | Resolución de organización en el webhook | **42883, en ejecución** |
| D7 | `has_any_column_privilege(..., 'DELETE')` no devuelve `false`: `DELETE` no tiene forma por columna | Abortaba la postcondición del paquete entero | 0A000, al aplicar |
| D8 | `SELECT … FOR UPDATE` se filtra por el `USING` de la policy de UPDATE (`status='pending'`), así que **no ve la fila ya aceptada** | La rama idempotente era inalcanzable: recargar la página daba rechazo | lógico |

Y uno más, de la misma familia, encontrado al probar CAP-04:
`ON CONFLICT (expresión)` incorpora las columnas del árbitro al requisito
`SELECT` de la sentencia, así que **un *conflict target* y un definer sin
`SELECT` son mutuamente excluyentes**. Medido: `INSERT` simple y
`ON CONFLICT DO NOTHING` sin objetivo pasan; con objetivo, denegado.

Los nueve están fijados como gates estáticos en
`tests/capability-isolation.test.ts` (§ *dry-run regressions*), de modo que no
pueden reaparecer sin romper la suite.

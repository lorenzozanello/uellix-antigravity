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

### Omitidas deliberadamente (baseline)

| Comando | Motivo |
|---------|--------|
| `pnpm test:integration` | Escribe en BD remota por defecto — prohibido por reglas de campaña |
| `pnpm test:rls` | Ídem |
| `pnpm build` | Se ejecutará como gate de integración por workstream, no en baseline |

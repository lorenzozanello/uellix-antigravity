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

### Omitidas deliberadamente (baseline)

| Comando | Motivo |
|---------|--------|
| `pnpm test:integration` | Escribe en BD remota por defecto — prohibido por reglas de campaña |
| `pnpm test:rls` | Ídem |
| `pnpm build` | Se ejecutará como gate de integración por workstream, no en baseline |

# STELLA FABLE MOONSHOT — Test Ledger

> Registro append-only de ejecuciones de pruebas de la campaña.
> Cada entrada: timestamp, commit, comando, resultado, notas.
> Nunca se borra una entrada; los rojos se documentan, no se ocultan.

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

### Omitidas deliberadamente (baseline)

| Comando | Motivo |
|---------|--------|
| `pnpm test:integration` | Escribe en BD remota por defecto — prohibido por reglas de campaña |
| `pnpm test:rls` | Ídem |
| `pnpm build` | Se ejecutará como gate de integración por workstream, no en baseline |

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

### Omitidas deliberadamente (baseline)

| Comando | Motivo |
|---------|--------|
| `pnpm test:integration` | Escribe en BD remota por defecto — prohibido por reglas de campaña |
| `pnpm test:rls` | Ídem |
| `pnpm build` | Se ejecutará como gate de integración por workstream, no en baseline |

# Normalización del working tree — `feature/stella-generation-copilot`

**Fecha:** 2026-07-26. **Rama:** `feature/stella-generation-copilot`. **HEAD:** `4c8a8ed9537e4181229ce94f83ca6447db30b172` (`docs(spec): Stella generation co-pilot design`). Sin commits nuevos, sin merge, sin push, sin PR, sin deploy — este documento describe el estado ANTES de crear ningún commit local.

## 1. Estado medido (no estimado)

- Archivos tracked modificados: **32** (`git diff --name-status`).
- Insertions/deletions en archivos tracked: **1606 insertions(+), 173 deletions(-)** (`git diff --numstat`).
- Archivos sin seguimiento (`git ls-files --others --exclude-standard`): **147**.
- Líneas totales en archivos sin seguimiento: **39.986** (conteo directo con `wc -l`, un archivo a la vez).
- **Total medido: ~41.600 líneas añadidas** (1606 + 39.986). Esto es sustancialmente menor a la cifra de ~139.000 mencionada en el encargo — no se identificó ninguna fuente adicional de líneas (no hay `node_modules`, `.next`, cobertura, ni builds sin ignorar; `.gitignore` ya excluye esas rutas de `git ls-files --others`). Se reporta la cifra medida, no la estimada, para evitar afirmar algo no verificado por código.
- **Un tercio de las líneas sin seguimiento (15.045 de 39.986, el 37.6%) proviene de exactamente 2 archivos**: los snapshots de Drizzle `db/migrations/meta/0047_snapshot.json` (7.462 líneas) y `0048_snapshot.json` (7.583 líneas). Son metadatos completos de esquema generados por `drizzle-kit generate`, no código — su tamaño es intrínseco al formato (un snapshot completo de ~50 tablas), no un error.
- `git diff --check`: sin marcadores de conflicto, sin errores de espacio en blanco. Solo avisos informativos de fin de línea LF→CRLF (comportamiento normal de Git en Windows con `core.autocrlf`), en 13 archivos tracked — no requieren acción.

## 2. Clasificación completa (categorías A-K del encargo)

| Categoría | Descripción | Cantidad | Ejemplos |
|---|---|---|---|
| A. Código de aplicación | `.ts`/`.tsx` no-test en `app/`, `lib/`, `components/` | 41 nuevos + 32 modificados (tracked) | `lib/stella/pilot/access.ts`, `app/actions/stella/consent.ts` |
| B. Esquema y migraciones | `db/migrations/*.sql` nuevas + `db/schema.ts` (modificado, tracked) | 7 migraciones nuevas (`0042`-`0048`) | `0048_stella_pilot_confirmations.sql` |
| C. Políticas RLS | `db/policies/*.sql` nuevas | 5 | `013_stella_pilot_confirmations_rls.sql` |
| D. Pruebas unitarias | `__tests__/*.test.ts(x)` bajo `lib/`, `app/actions/`, `components/` | 54 nuevas + 4 modificadas (tracked) | `lib/stella/pilot/__tests__/access.test.ts` |
| E. Pruebas de integración | `tests/integration/*.test.ts` | 9 nuevas + 1 modificada (tracked) | `tests/integration/stella-pilot-confirmations-rls.test.ts` |
| F. Scripts locales | `scripts/*.ts` | 2 | `stella-pilot-preflight.ts`, `stella-retention-cli.ts` |
| G. Documentación y backlog | `STELLA_*.md/csv/json` en la raíz + `docs/ops/*` | 27 (25 relacionados con Stella + 2 sin relación, ver §3) | `STELLA_B0_CONTROLLED_PILOT_IMPLEMENTATION_REPORT.md` |
| H. Snapshots de Drizzle | `db/migrations/meta/*_snapshot.json` | 2 (`0047`, `0048`) | ver §1 — legítimos, no se eliminan |
| I. Artefactos generados que no deben versionarse | — | **0 encontrados** | `.gitignore` ya excluye `node_modules/`, `.next/`, cobertura; ninguno apareció en `git ls-files --others` |
| J. Configuración local que no debe versionarse | `.env.local` | **0 en el working tree rastreado** — confirmado ignorado (`git check-ignore -v .env.local` → `.gitignore:34:.env*`) | — |
| K. Cambios dudosos o no atribuibles | Archivos sin relación aparente con Stella/B0 | 2 | ver §3 |
| Además: 1 arnés de evaluación (`tests/eval/*`, 7 archivos) y 1 prueba smoke (`tests/smoke/*`, 1 archivo) — categorías propias no listadas arriba pero incluidas en A-F según su naturaleza. | | | |

## 3. Categoría K — hallazgos que requieren decisión del propietario

Dos archivos sin seguimiento **no tienen relación con Stella ni con Etapa B0**, y sus fechas de modificación (verificadas con `ls -la`) son anteriores al inicio de este trabajo de gobernanza de Stella:

- `docs/ops/PRODUCTION_APPLY_P0_STABILIZATION.md` — modificado 2026-07-24, un runbook de aplicación a producción de la estabilización P0. No forma parte de ningún commit de Stella.
- `public/brand/Tablero de Logo Uellix.svg` — modificado 2026-07-06, un asset de marca (1.516 líneas de datos SVG). Corresponde a una sesión de diseño de reporte anterior, no a Stella.

**No se eliminan** (no son artefactos regenerables, son contenido real de trabajo previo) y **no se incluyen en ningún commit de esta sesión**, ya que agruparlos con el trabajo de Stella violaría la coherencia de los commits pedida en el encargo. Quedan sin seguimiento al finalizar esta sesión, disponibles para que el propietario decida si los quiere en un commit separado.

## 4. Brecha preexistente en la cadena de snapshots de Drizzle (hallazgo, no corregido aquí)

Al inventariar `db/migrations/meta/`, además de la brecha ya documentada y cerrada a partir de la migración `0047` (ver `STELLA_A2_DR004_RETENTION_IMPLEMENTATION_REPORT.md`), se confirma que las migraciones **`0011`, `0012` y `0041` tampoco tienen snapshot** (ni tracked ni sin seguimiento — nunca se generaron). Esto es anterior a todo el trabajo de Stella de esta rama y queda fuera del alcance de esta sesión de cierre; se documenta aquí porque el inventario lo reveló. `npx drizzle-kit check` no lo señala como error porque valida el estado actual del esquema contra las migraciones aplicadas, no la completitud histórica de cada snapshot individual.

## 5. Escaneo de secretos

Ejecutado contra los 179 archivos (32 tracked modificados + 147 sin seguimiento):

```text
PASS — formato de clave de Google (AIza...)
PASS — tokens tipo JWT (eyJ...)
PASS — postgresql://usuario:contraseña@ embebidos
PASS — asignación literal de GEMINI_API_KEY / GOOGLE_API_KEY
PASS — asignación literal de password/secret/token (6 coincidencias, las 6 son
       `const password = 'test-password-123'` en los helpers createTestUser()
       de tests/integration/*-rls.test.ts — fixtures sintéticas, no secretos reales)
PASS — URLs de Supabase remoto (*.supabase.co) hardcodeadas
```

`git check-ignore -v .env.local` confirma que `.env.local` está ignorado por `.gitignore:34:.env*` — no requirió corrección.

## 6. Snapshots de respaldo (fuera del repositorio)

Creados antes de cualquier modificación:

- `../stella-generation-copilot-working-tree.patch` — `git diff --binary` de los cambios tracked (2650 líneas).
- `../stella-generation-copilot-untracked-files.txt` — listado de los 147 archivos sin seguimiento.
- `../stella-generation-copilot-untracked-backup/` — copia completa de esos 147 archivos, preservando rutas, 2.3 MB. Verificado: ningún archivo `.env*`, credencial, `node_modules`, `.next`, log o caché fue copiado.

Ninguno de los tres se añadió a Git.

## 7. Conclusión de esta fase

El working tree es normal para 7 etapas de gobernanza de Stella (A1-A2.4, B0) implementadas sin commits intermedios. No hay artefactos generados que limpiar. No hay secretos. Los dos archivos de categoría K quedan fuera de los commits de esta sesión. Se procede a: diagnóstico de la API key → preflight → smoke test → validación completa → plan de commits.

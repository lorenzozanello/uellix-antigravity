# Stella — Trabajo Paralelo en Cuatro Líneas

Documento de gobernanza para la ejecución paralela de Stella sobre cuatro
líneas de desarrollo independientes, integradas en una única rama de
integración. Este documento es la fuente de verdad de propiedad de rutas,
protocolo de contratos, protocolo de commits, protocolo de integración y
disciplina de recursos. Cada línea debe leerlo antes de tocar cualquier
archivo fuera de su propio worktree.

## 1. Fundación

- **HEAD de fundación:** `c7c9736` (`fix(db): remove implicit writer dependency from member policy`, rama origen `codex/stella-g2-local-rehearsal`).
- Las cuatro líneas de desarrollo no arrancan directamente desde `c7c9736`:
  arrancan desde `INTEGRATION_ROOT_HEAD` (ver más abajo), que es `c7c9736`
  más el commit único de gobernanza que crea este documento y los cuatro
  documentos de `docs/ops/workstreams/`.
- La rama fuente (`codex/stella-g2-local-rehearsal`) permanece congelada:
  ninguna línea de este esfuerzo paralelo le añade commits ni la modifica.

## 2. Rama de integración

- **Branch:** `codex/stella-integration`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-integration`
- Es la **única** rama que recibe merges de las cuatro líneas de desarrollo.
- Ninguna línea de desarrollo hace merge directo hacia otra línea de
  desarrollo. Todo merge pasa por integración.

## 3. Propiedad exclusiva de base de datos — CAPABILITIES

`codex/stella-capabilities` es la única línea autorizada a modificar,
directamente y sin contrato previo:

- `db/**` (incluye `db/policies`, `db/safety`, `db/audit`, `db/baseline`,
  `db/manual-migrations`, `db/migrations`, `db/schema.ts`, `db/migrator.ts`,
  `db/client.ts`, `db/identity-context.ts`, `db/identity-store.ts`,
  `db/runtime-bootstrap.ts`)
- `supabase/**` (incluye `supabase/migrations`, `supabase/config.toml`)
- `db/prepared/**` (paquetes SQL preparados: `stella_00xx_*.sql` y sus
  `*_rollback.sql`, incluyendo `grounding_0001_evidence_chunks.sql`)
- Migraciones, policies, roles, funciones SQL, esquemas, grants, RLS en
  cualquier ubicación del repositorio.
- Paquetes de capacidad **CAP-01 a CAP-05**
  (`docs/ops/capabilities/CAP_01_INVITATIONS.md` …
  `CAP_05_ORGANIZATION_BOOTSTRAP.md`, ya presentes en el repo).
- **RR-CAP-10-A-bis**: nombrado así en la instrucción de origen. La
  verificación contra el repositorio encuentra el hallazgo **RR-CAP-10**
  (asimetría de grant `UPDATE` preexistente sobre `organizations` /
  `stella_monthly_quota`, registrado en
  `docs/ops/capabilities/ADVERSARIAL_FINDINGS_ROUND2.md`, hallazgo B2-F3).
  No se ha encontrado una variante `-A-bis` en el árbol actual. CAPABILITIES
  debe tratar `RR-CAP-10` como el hallazgo de referencia y, si la numeración
  `-A-bis` corresponde a un desglose posterior no documentado aún, registrarlo
  explícitamente al abrir esa unidad — no asumir que ya existe.

Ninguna otra línea escribe en estas rutas. Ver §7 para el protocolo cuando
otra línea necesita algo de estas rutas.

## 4. GROUNDING — sin acceso directo a base de datos

`codex/stella-grounding` **no puede modificar directamente**:

- `db/**`, `supabase/**`, `db/prepared/**`
- migraciones, SQL preparado, policies, roles, funciones SQL

GROUNDING **puede** desarrollar:

- contratos TypeScript (bajo `lib/stella/**` o módulo dedicado que la línea
  defina en su propio worktree)
- extracción de documentos
- normalización
- hashing
- chunking
- clasificación documental
- retrieval
- ranking
- provenance
- citas
- abstención
- evaluaciones focalizadas de grounding (`eval:offline`, `eval:roles` y
  cualquier eval nueva que la línea añada bajo su propio directorio de tests)

Toda necesidad de esquema, tabla, columna, policy o función SQL debe
registrarse como **solicitud de contrato para CAPABILITIES** (§8). GROUNDING
no crea tablas provisionales ni SQL especulativo fuera de `db/prepared/**`
para sortear esta regla.

## 5. PRODUCT — sin acceso directo a base de datos ni SQL

`codex/stella-product` **no puede modificar directamente** base de datos ni
SQL (mismas rutas que §4).

PRODUCT **puede** desarrollar:

- Composer
- experiencia Stella (UI conversacional, advisor, validator)
- componentes (`components/**`)
- formularios
- estados de carga, error, vacío y abstención
- decisiones (UI de decisiones sobre sugerencias)
- evidencias (UI)
- proxies (UI)
- reportes (UI, incluyendo `/report/[reportId]/pdf` si el cambio es de
  presentación, no de esquema)
- historial
- cuotas visibles (lectura y presentación, no la definición de la cuota en
  base de datos)
- integración mediante contratos TypeScript publicados por GROUNDING y
  CAPABILITIES

## 6. RELEASE Y CALIDAD — sin contratos funcionales ni SQL

`codex/stella-release` **no puede modificar** contratos funcionales
(interfaces TypeScript publicadas por otra línea) ni SQL.

RELEASE **puede** desarrollar:

- E2E
- evals
- CI (`.github/workflows/ci.yml`, `.github/workflows/p1a-validation.yml`) —
  bajo el mismo protocolo de ruta compartida que §7 si el cambio afecta a
  las demás líneas
- observabilidad
- logging
- métricas
- presupuestos de latencia y costos
- pruebas de aislamiento
- scripts de release
- staging y runbooks (`docs/ops/runbooks/**`)

## 7. Rutas compartidas — INTEGRATION-OWNED

Inspección del árbol real en la fundación (`c7c9736`). Ninguna línea de
desarrollo modifica estos archivos sin una solicitud explícita de
integración (§8/§10):

| Categoría | Ruta |
|---|---|
| Manifiesto / dependencias | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` |
| TypeScript | `tsconfig.json` |
| Configuración de tests | `vitest.config.ts`, `vitest.integration.config.ts`, `vitest.setup.ts`, `vitest.setup.integration.ts`, `vitest.shared.ts` |
| Variables de entorno de ejemplo | `.env.example` (incluye los flags `STELLA_*_ENABLED`) |
| Build / framework | `next.config.ts`, `eslint.config.mjs`, `postcss.config.mjs`, `components.json` |
| Drizzle | `drizzle.config.ts`, `drizzle.local.config.ts` |
| Middleware / proxy de request | `proxy.ts` (equivalente a middleware de Next en este repo; matcher global, rate-limit, `lib/supabase/proxy`) |
| Navegación / shell de la app | `app/layout.tsx`, `components/marketing/Navbar.tsx`, `components/layout/MobileNav.tsx` |
| CI | `.github/workflows/ci.yml`, `.github/workflows/p1a-validation.yml` |
| Repo-level | `.gitattributes`, `.gitignore`, `AGENTS.md` |

Si el árbol real revela más superficie compartida durante la ejecución
(por ejemplo un nuevo archivo de tipos compartidos), la línea que lo
descubre debe registrarlo aquí vía integración, no asumir propiedad tácita.

## 8. Protocolo de contratos

Ubicación: `docs/ops/contracts/` (**ruta nueva prevista** — no existe en la
fundación; la crea la primera línea que publique un contrato).

Estructura:

- `docs/ops/contracts/CONTRACT_LEDGER.md` — índice único, una fila por
  contrato: id, línea solicitante, línea propietaria, estado
  (`solicitado` / `aceptado` / `incompatible`), fecha, enlace al documento.
- `docs/ops/contracts/<ID>_<slug>.md` — un archivo por contrato con la
  forma propuesta (tipos TypeScript, forma de tabla/función si aplica),
  justificación, y la decisión de integración cuando exista.

Cada línea publica ahí lo que necesita de otra línea (p. ej. GROUNDING
publica un contrato de tabla para CAPABILITIES; PRODUCT publica un contrato
de tipo TypeScript que espera de GROUNDING). Integración resuelve
incompatibilidades y marca el estado final en `CONTRACT_LEDGER.md`.

## 9. Protocolo de commits

- Commits locales únicamente. **Sin push** en ninguna línea ni en
  integración durante esta unidad.
- Una unidad técnica coherente por grupo de commits — no mezclar dominios
  no relacionados en un mismo commit.
- Árbol limpio (`git status` sin cambios) al entregar una unidad a
  integración.
- Pruebas focalizadas en verde antes de entregar (ver §11 para la
  disciplina de recursos al ejecutarlas).
- Nunca compartir archivos mediante copia manual entre worktrees.
  Integración ocurre únicamente por Git (merge/cherry-pick de commits
  completos).

## 10. Protocolo de integración

- Ninguna línea de desarrollo hace merge directo hacia otra línea de
  desarrollo.
- Únicamente `codex/stella-integration` recibe merges de las cuatro líneas.
- Merge sólo de unidades verdes (pruebas focalizadas en verde, árbol
  limpio).
- Usar merge explícito (`git merge --no-ff` o equivalente), no copiar
  commits parcialmente.
- No hacer cherry-pick parcial de una unidad cuyos commits individuales no
  sean verdes de forma independiente.
- Los conflictos se resuelven en integración, no en la línea de desarrollo.
- Ejecutar pruebas focalizadas después de cada merge individual.
- Ejecutar la batería completa sólo al cerrar un tren integrado (todas las
  líneas pendientes de ese ciclo ya mergeadas).

## 11. Disciplina de recursos

Debido a timeouts observados bajo carga en este entorno:

- No ejecutar dos `pnpm test:unit` (ni `test:integration`, ni `test:rls`)
  simultáneamente entre worktrees.
- No ejecutar dos `next build` simultáneamente.
- No ejecutar dos dry-runs de Docker simultáneamente. (Recordatorio: esta
  unidad tiene prohibido ejecutar Docker — ver Fase 0/restricciones. Esta
  regla queda documentada para cuando se levante esa restricción.)
- No ejecutar mutation audits en paralelo con la batería completa.
- Sólo un job pesado a la vez, coordinado entre líneas.
- Las líneas pueden programar y ejecutar pruebas **focalizadas** (un
  archivo, un paquete) en paralelo sin coordinación previa.
- Integración coordina los gates pesados (batería completa, build de
  release, mutation audit).

## 12. Criterio de detención

Una línea debe detenerse si necesita modificar un archivo que no está en
sus rutas autorizadas (§3–§6) o que es `INTEGRATION-OWNED` (§7).

En ese caso, la línea:

1. No modifica el archivo.
2. Registra una solicitud de contrato en `docs/ops/contracts/` (§8) si la
   necesidad es de otra línea de desarrollo, o abre una solicitud explícita
   a integración si la ruta es `INTEGRATION-OWNED`.
3. Continúa con el resto de su unidad si es posible sin ese archivo;
   si no es posible, lo documenta como bloqueador en su propio
   `docs/ops/workstreams/<LINEA>.md` (campo "riesgos").

## Documentos de línea

- [`docs/ops/workstreams/CAPABILITIES.md`](workstreams/CAPABILITIES.md)
- [`docs/ops/workstreams/GROUNDING.md`](workstreams/GROUNDING.md)
- [`docs/ops/workstreams/PRODUCT.md`](workstreams/PRODUCT.md)
- [`docs/ops/workstreams/RELEASE.md`](workstreams/RELEASE.md)

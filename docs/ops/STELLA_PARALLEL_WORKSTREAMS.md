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
- **RR-CAP-10-A-bis** — *resuelto en el tren 1 de integración (2026-08-04).*
  Nombrado así en la instrucción de origen. La verificación de CAPABILITIES
  contra el árbol confirmó que **no existe** en
  `docs/ops/STELLA_FABLE_RISK_REGISTER.md`: era un alias acuñado en un
  comentario de `lib/admin/organization-administration.ts`. **El identificador
  canónico es `RR-CAP-10-A`**, y los tres `UPDATE` directos del webhook eran su
  resto no cerrado. CAPABILITIES los eliminó; integración retiró el alias
  (CT-CAP-002, opción A) y anotó el cierre en la entrada `RR-CAP-10-A` del
  registro. **No se creó una entrada `-A-bis`** — dar existencia registral a un
  identificador que nunca la tuvo sería peor que la referencia colgante que se
  estaba corrigiendo.

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

### 7.1 Propiedad registrada en el tren 1

La revisión de integración del tren 1 encontró cuatro rutas ocupadas sin
entrada previa. Ninguna causó conflicto — el aislamiento se sostuvo — pero
quedan registradas aquí en vez de consolidarse como propiedad tácita, que es
lo que §7 prohíbe:

| Ruta | Ocupada por | Registro |
|---|---|---|
| `app/api/webhooks/stripe/route.ts` | CAPABILITIES | **Propiedad de CAPABILITIES.** Es el manejador de CAP-03 y §3 le concede el dominio de los paquetes CAP-01…CAP-05; la ruta faltaba por nombre. Ninguna otra línea la edita sin contrato. |
| `lib/capabilities/**`, `db/capabilities/**` | CAPABILITIES | **Propiedad de CAPABILITIES**, declarada por la propia línea en su documento por paridad con lo que §4 concede a GROUNDING. Ratificado. `db/capabilities/**` es TypeScript, no SQL. |
| `lib/grounding/contracts/**`, `lib/grounding/ingest/**` | GROUNDING | **Propiedad de GROUNDING.** El barrel `lib/grounding/contracts/index.ts` es la **única** superficie publicada: nadie importa desde `ingest/**` ni desde los archivos de contrato sueltos. |
| `docs/superpowers/plans/**` | PRODUCT | Notas de plan de la línea. Sin dueño declarado y sin impacto; se registra para que no se lea como superficie compartida. |

Además, **integración editó `lib/admin/organization-administration.ts`** (sólo
comentario) y **`tests/eval/stella-release/fixtures.ts`** (sólo comentario) en
el tren 1. Las dos son correcciones de afirmaciones factualmente falsas
—CT-CAP-002 pidió la primera explícitamente— y ninguna cambia comportamiento.
Integración corrige un comentario falso en cualquier ruta; no cambia lógica
fuera de §7.

## 8. Protocolo de contratos

Ubicación: `docs/ops/contracts/` (**ruta nueva prevista** — no existe en la
fundación; la crea la primera línea que publique un contrato).

Estructura:

- `docs/ops/contracts/CONTRACT_LEDGER.md` — índice único, una fila por
  contrato: id, línea solicitante, línea propietaria, estado
  (`solicitado` / `aceptado` / `incompatible` / `parcialmente satisfecho`),
  fecha, enlace al documento.
  - `parcialmente satisfecho` lo añadió integración en el tren 1: la necesidad
    **sí** está cubierta por la línea propietaria, pero con una forma distinta
    de la pedida, de modo que hace falta una capa de adaptación. No es
    `aceptado` (la forma pedida no existe) ni `incompatible` (la necesidad está
    resuelta).
  - **El estado de la fila del ledger y el del encabezado del documento de
    contrato deben coincidir.** Un lector llega al documento por el enlace de
    la fila; un `solicitado` obsoleto ahí hace que se vuelva a aplicar algo ya
    aplicado. Integración actualiza los dos en la misma edición.
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

## 13. Trenes integrados

### Tren 1 — integrado 2026-08-04

`INTEGRATION_ROOT_HEAD` = `ff1ffb6`. Las cuatro líneas entregaron dos commits
cada una y las cuatro descendían del root sin divergencias intermedias.

| Línea | HEAD integrado | Commits fusionados | Merge commit | Pruebas focalizadas |
|---|---|---|---|---|
| CAPABILITIES | `4c40a8e` | `7002f86`, `4c40a8e` | `95ce36b` | 1184 passed / 61 skipped (16 archivos) |
| GROUNDING | `0698937` | `7020288`, `0698937` | `24dc14d` | 145 passed (6 archivos) |
| PRODUCT | `9e57301` | `21468ca`, `9e57301` | `fa3a13c` | 261 passed (13 archivos) |
| RELEASE | `55a9e48` | `74d559a`, `55a9e48` | `847795d` | 14/14 harness + 14/14 script offline |

Merges explícitos `--no-ff`, en ese orden. Sin cherry-pick, sin reescritura de
historia, sin push, sin acceso a remoto.

**Único conflicto, y era previsible:** `docs/ops/contracts/CONTRACT_LEDGER.md`,
add/add, tres veces. Las tres líneas que publicaron contratos crearon el índice
en paralelo el mismo día, cada una con su propia cabecera. Integración
reconcilió los tres sin alterar autoría, fecha ni texto de ninguna solicitud.
Ningún otro archivo fue tocado por más de una línea — el aislamiento de rutas
de §3–§6 se sostuvo en la práctica.

**Superficie compartida tocada por integración** (§7, ninguna línea la tocó):

- `.gitattributes` — `db/prepared/** text eol=lf` (CT-CAP-003).
- `docs/ops/STELLA_FABLE_RISK_REGISTER.md` y
  `lib/admin/organization-administration.ts` (CT-CAP-002).
- `.env.example` — **no tocado**; CT-CAP-004 sigue `solicitado` (ver ledger).

**Estado de contratos:** ver
[`contracts/CONTRACT_LEDGER.md`](contracts/CONTRACT_LEDGER.md). Resumen:
CT-CAP-001/002/003 `aceptado`, CT-CAP-004 `solicitado`, GR-001/GR-002
`solicitado` (pendientes de CAPABILITIES), PRODUCT-001
`parcialmente satisfecho`, INTEGRATION-001 `solicitado` — la decisión está
registrada, la implementación del adaptador **no está hecha** y es trabajo de
PRODUCT en el tren 2.

**Batería integrada** (serializada, un gate pesado a la vez, §11):
`test:unit` 3920 passed / 2 failed / 125 skipped · `typecheck` limpio ·
`lint` 0 errores / 44 warnings · `build` verde · `capability-baseline-verify`
38/107/10 · `capability-dry-run` 42/151/7/10/1, 132/132 aserciones (7/7
concurrencia), rollback 40/108, reaplicación 42/151/7/10/1 — todas las cifras
idénticas a las vigentes antes del tren.

Los 2 fallos de `test:unit` están clasificados con evidencia y **ninguno es
regresión de integración**: ver §Riesgos abiertos de cada línea y el informe de
integración. Ninguna base de datos fue modificada; el dry-run corrió en un
contenedor desechable con `--network none` sobre `db/baseline/**`.

### Revisión adversarial del tren 1

Dos revisores de sólo lectura sobre el diff integrado: **A — contratos**,
**B — integridad**. **Cero BLOCKER.** Lo corregido y lo asignado:

**Corregido en el commit de integración** (artefactos de integración, y dos
comentarios factualmente falsos):

| # | Hallazgo | Acción |
|---|---|---|
| A-F3 | INTEGRATION-001 §7 declaraba «regla» algo que ningún tipo, guard ni prueba impone | Reescrito: es convención documentada hasta que el tren 2 añada la prueba que la haga fallar |
| A-F4 | INTEGRATION-001 §1 afirmaba que no existe otra noción de provenance; existen tres, una **persistida** | Reescrito con las tres enumeradas, y con la advertencia dirigida a CAPABILITIES: **aplicar `grounding_0001` tal cual NO satisface GR-001** |
| A-F5 / B-M7 | Ledger marcaba INTEGRATION-001 `aceptado` mientras su documento decía `solicitado`, y el entregable no existe | INTEGRATION-001 → `solicitado`, propietaria PRODUCT. Integración no se acepta trabajo a sí misma |
| A-F6 / B-M7 | CT-CAP-001/002/003 y PRODUCT-001 conservaban `solicitado` en su encabezado | Encabezados sincronizados con el ledger; §8 ahora exige que coincidan |
| A-F7 | `CAPABILITIES.md` con dos tablas de estado contradictorias | Nota de reenvío al ledger bajo la tabla de entrega |
| A-F8 | §8 no listaba `parcialmente satisfecho` | Añadido y definido |
| B-M1 / B-m1 / B-m2 | Cuatro rutas ocupadas sin entrada en §7 | Registradas en §7.1 |
| B-M2 | `fixtures.ts` atribuía `lib/stella/context/**` a GROUNDING; el harness no evalúa `lib/grounding/**` | Comentario corregido: borrar el tren entero de GROUNDING dejaría los 14 checks en verde |
| B-M8 | El fix de CT-CAP-003 vivía sólo en el working tree | Incluido en el commit de integración |
| B-m3 | `db/prepared/README.md` seguía en CRLF | Renormalizado; los 33 archivos de `db/prepared/**` en LF |

**No corregido — asignado a la línea propietaria.** Ninguno es regresión de
integración; los cinco son defectos internos de una unidad, y parchearlos
desde integración sería tomar decisiones de diseño que §3–§6 reservan a su
dueño. Se registran con dueño y tren, no se silencian:

| # | Hallazgo | Sev. | Dueño / tren |
|---|---|---|---|
| A-F1 | `validateAnswerCitations` compara **sólo** `organizationId`; `availableChunks` no puede ni recibir `projectId`, y `scopeContains` tiene cero llamadas en producción. Una cita de otro proyecto de la misma organización se valida como correcta | **MAJOR** | GROUNDING tren 2 |
| A-F2 | `capabilityUnavailable` dice `retryable:false` para `feature_flag_disabled`; `stripeCapabilityUnavailable` responde siempre 503 retryable. El comportamiento de CAP-03 es defendible (un 200 haría que Stripe abandonara el evento), pero el contrato genérico afirma lo contrario y `route.ts` dice que «no puede divergir». `capabilityUnavailable` tiene cero llamadas | **MAJOR** | CAPABILITIES tren 2 |
| B-M4 | `cap-01-05-regression-surface-present` es `existsSync` + una tautología (`every(f => !f.startsWith('tests/integration/'))` sobre un array literal): pasa con los `.sql` truncados a cero bytes | **MAJOR** | RELEASE tren 2 |
| B-M5 | El check de contradicción compara un regex contra sus propios literales y cuenta como `passed` pese a `offlineMeasurable:false` | **MAJOR** | RELEASE tren 2 |
| B-M6 | `structural-regression` está declarada en la matriz y **no se emite** en `computeReleaseMetrics`; `latency` se declara en dos checks y está cableada a `null` | **MAJOR** | RELEASE tren 2 |
| B-M3 | El harness importa `@/components/stella/error-messages` (interno) en vez del barrel de PRODUCT. **Rebajado a MINOR por integración:** el `Record<StellaPanelErrorCode, boolean>` que el revisor leyó como acoplamiento accidental es el propósito declarado del check `retryable-code-set-pinned` — debe fallar si alguien añade un código sin decidir su retryabilidad. Queda sólo la ruta de import | MINOR | PRODUCT (exportar) / RELEASE (importar), tren 2 |
| A-F9 | `capability-isolation` escanea `lib/` y `app/`, no `db/`, donde viven las tres invocaciones `uellix_capability.*` | MINOR | CAPABILITIES tren 2 |
| A-F10 | `abstention-schema-enforced` no declara `offlineLimitation` pese a evaluar sólo literales | MINOR | RELEASE tren 2 |
| B-m4 | Ciclo **sólo de tipos** entre `grounding-model.ts` y `StellaContextualAdvisorPanel.tsx`; se borra en transform por `import type` + `isolatedModules` | MINOR | PRODUCT tren 2 |
| B-m5 | `scripts/eval-release-offline.ts` no tiene entrada `eval:release` en `package.json` (§7) y RELEASE no abrió fila de contrato | MINOR | RELEASE tren 2 — abrir la fila |

**Siguiente tren por línea:** CAPABILITIES → evaluar GR-001/GR-002, CT-CAP-004,
A-F2, A-F9. GROUNDING → retrieval real, calibración de umbrales (R4) y **A-F1**.
PRODUCT → adaptador puro de INTEGRATION-001 con la prueba que impone §7.
RELEASE → cerrar B-M4/M5/M6, abrir la fila de `package.json`, y extender el
harness a los contratos de grounding cuando exista retrieval.

## Documentos de línea

- [`docs/ops/workstreams/CAPABILITIES.md`](workstreams/CAPABILITIES.md)
- [`docs/ops/workstreams/GROUNDING.md`](workstreams/GROUNDING.md)
- [`docs/ops/workstreams/PRODUCT.md`](workstreams/PRODUCT.md)
- [`docs/ops/workstreams/RELEASE.md`](workstreams/RELEASE.md)

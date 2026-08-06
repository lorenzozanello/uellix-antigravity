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

### Preparación de raíz compartida para el tren 2 — 2026-08-04

Unidad de integración sobre `INTEGRATION_ROOT_HEAD` del tren 1 (`48c54b3`,
reconciliación de contratos). Cierra cuatro asuntos INTEGRATION-OWNED
pendientes antes de abrir el tren 2; no desarrolla funcionalidad de tren 2.

**1. CT-CAP-004 → `aceptado`.** `.env.example` recibe únicamente el nombre de
variable `UELLIX_STRIPE_DATABASE_URL=` (vacío, con comentario que la describe
como identidad de BD separada para CAP-03), en la sección Stripe. No se tocó
`DATABASE_URL`, no se usó `service_role`, `WEBHOOK_DATABASE_IDENTITY_AVAILABLE`
permanece `false`. Detalle en
[`CONTRACT_LEDGER.md`](contracts/CONTRACT_LEDGER.md). Esto también cierra B-m5
del tren 1 (RELEASE no tenía dueño de `package.json` para su propia fila).

**2. Comando oficial del harness de RELEASE.** `package.json` gana
`"test:stella:release-eval": "tsx scripts/eval-release-offline.ts"`. Sigue
siendo 100% offline (probado por `tests/eval/stella-release/wiring.test.ts`,
nuevo: confirma el nombre exacto del script, que apunta al harness correcto, y
que el entrypoint no contiene `fetch`/URLs http(s)/secretos/activación de
flags). Referencia: `14/14 checks passed` vía `pnpm test:stella:release-eval`,
mismas cifras que el tren 1.

**3. `tests/database-entrypoint-safety.test.ts` → reparado, no es
ambiental.** El fallo (colecta 0 de 49 tests de integración sin `.env.local`)
se reprodujo antes de tocar nada: `vitest.setup.integration.ts` y
`tests/integration/_guard.ts` resuelven `UELLIX_RUNTIME_DATABASE_URL` en el
momento de LISTAR pruebas, no sólo de ejecutarlas, así que un subproceso que
hereda este entorno (sin `.env.local`, sin la variable exportada) aborta antes
de listar nada. La reparación inyecta una URL sintética de loopback
(`postgresql://uellix_app:...@127.0.0.1:56322/postgres`, el rol y puerto que
el guard exige) sólo en el `env` de los dos `spawnSync` que listan la
suite de integración — sin `.env.local`, sin BD real, sin credencial real. El
guard se probó activo tras el cambio: un rol incorrecto o un host remoto en
esa misma variable siguen colectando 0 pruebas. `122/122` tests verdes.

**4. Flake bajo carga — dos instancias, ambas reparadas.**

- La documentada por el tren 1: `tests/database-runtime-entrypoints.test.ts`,
  un `await import(...)` dentro de un `it()` con el `testTimeout` por defecto
  de 5s, corriendo bajo la batería completa. Convertido a import estático de
  los tres módulos inspeccionados (`@/lib/auth/session`,
  `@/lib/auth/database-context`, `@/db/identity-context`) — el costo de
  transformar/ejecutar el módulo se paga durante la colección del archivo, sin
  timeout de prueba, no dentro del `it()`. `187/187` verdes en aislamiento.
- Una **segunda instancia no documentada por el tren 1**, encontrada durante
  la verificación de esta unidad: `tests/sroi-decimal-config.test.ts` ›
  `importing fx-oracle.ts re-applies the pinned config`. Mismo patrón
  estructural — `vi.resetModules()` + `await import('@/lib/pipeline/fx-oracle')`
  dentro de un `it()` de 5s — pero aquí el `resetModules()` es intencional (la
  prueba verifica el efecto de una importación *fresca*), así que no se podía
  simplemente izar a import estático sin perder lo que la prueba verifica.
  Reproducida con evidencia antes de aceptar la clasificación: **3 de 4**
  corridas completas de `pnpm test:unit` fallaron ahí (siempre el mismo
  `it()`), **0 de 2** en aislamiento — el archivo que se importa
  (`lib/pipeline/fx-oracle.ts`) no tiene efectos de import más allá de un
  `Set` literal, así que el costo es enteramente de *transformación en frío*
  bajo contención de CPU, no del código en sí. Reparación: un import estático
  de sólo-efecto-secundario (`import '@/lib/pipeline/fx-oracle'`) al principio
  del archivo de prueba, que precalienta la caché de transformación de Vite
  durante la colección; el `vi.resetModules()` posterior sigue forzando una
  re-ejecución fresca del módulo para la aserción real — no se debilitó nada
  que la prueba verifica. Validado con **2 corridas completas consecutivas en
  verde** tras el cambio (0/2 fallos, contra 3/4 antes).
  No se tocó `fx.ts` (mismo patrón, misma línea): no mostró fallos en las 4
  corridas observadas y tocarlo sin evidencia habría sido un cambio no
  verificado.
  **No se aumentó ningún timeout, global ni de prueba, en ningún punto de
  esta reparación.**

**5. Tres warnings de lint nuevos del tren 1 → 0.** `44 → 41` warnings totales
(0 errores en ambos extremos). Los tres pertenecían a archivos nuevos del tren
1: `tests/eval/stella-release/harness.ts` (`readFileSync` y
`ProviderOutputContractError`, ambos importados sin uso) y
`components/stella/__tests__/StellaContextualAdvisorPanel.test.tsx` (una prop
`output` desestructurada en `TargetHarness` que el componente nunca consumía —
el único sitio que la pasaba también llamaba `success(TWO_SUGGESTIONS_OUTPUT)`
por separado, que es lo que realmente configura el mock; eliminarla no cambia
ningún comportamiento observable). Los 41 warnings restantes son históricos,
anteriores al tren 1, y no se tocaron.

**Batería final de esta unidad:** `test:unit` **3927 passed / 0 failed / 125
skipped** (162 archivos, 1 skip de suite) — verificado en **2 corridas
completas consecutivas en verde** tras las reparaciones de #3 y #4 (contra 1
corrida en verde de 6 corridas totales antes de la segunda reparación de
flake) · `typecheck` limpio · `lint` **0 errores / 41 warnings** (ninguno
nuevo) · `build` verde. `GEMINI_API_KEY` se retiró sólo del entorno del
proceso de prueba (`env -u`, ningún archivo `.env` tocado) antes de correr
`test:unit`, siguiendo la práctica ya establecida por el tren 1. Cero
escrituras a base de datos, cero acceso remoto, cero `fetch`/`pull`, cero
`supabase start`, cero stack persistente, cero push.

`TRAIN_2_ROOT_HEAD` = el commit `chore(integration): prepare shared Stella
train 2 root` que contiene esta sección. Los cuatro worktrees de desarrollo
(`uellix-stella-capabilities`, `-grounding`, `-product`, `-release`) deben
arrancar el tren 2 desde ese HEAD mediante fast-forward estricto sobre
`codex/stella-integration` — ninguno tenía commits propios más allá de lo ya
integrado en el tren 1 al momento de esta preparación.

## Integración del tren 2 — 2026-08-04

Cuatro merges `--no-ff` sobre `597819b` (`TRAIN_2_ROOT_HEAD`), en el orden
CAPABILITIES → GROUNDING → PRODUCT → RELEASE. Sin cherry-pick, sin reescribir
ninguna rama, sin borrar ninguna rama ni worktree, sin push, sin acceso remoto.

Las cuatro ramas tocaron **rutas disjuntas**, así que Git no señaló un solo
conflicto. Eso no significa que no los hubiera: los tres conflictos reales del
tren 2 fueron **semánticos**, vivían en archivos distintos, y ninguno era
visible desde dentro de la línea que lo causó.

### Los tres desacuerdos entre líneas, y su resolución

**1. Dos clasificaciones de relevancia.** GROUNDING publicó `high >= 0.4` /
`medium >= 0.2` (`grounding-relevance-2026-08-local-1`); PRODUCT publicó
`>= 0.6` / `>= 0.3` (`product-relevance-v1`). No era cosmético: **0.42** —el
caso principal de la propia prueba de PRODUCT— era `medium` para una línea y
`high` para la otra. Resuelto a favor de GROUNDING como fuente única; los
umbrales de PRODUCT quedan retirados del módulo y del barrel. Detalle en
[INTEGRATION-001 §6-bis](contracts/INTEGRATION-001_grounding_product_citation_adapter.md).

**2. `CitableChunkRecord` cambió de forma bajo el harness de RELEASE.**
GROUNDING sustituyó `{ contentHash, organizationId }` por un registro con
**scope completo** —el cierre de A-F1—, y RELEASE construía ese mapa a mano.
Compilaba en su worktree y **lanzaba en la primera corrida integrada**. Resuelto
proyectando con `toCitableChunkRecord`, el helper que GROUNDING publicó para
esto; copiar los campos a mano habría compilado y reproducido el bug viejo en un
sitio nuevo.

**3. Un hallazgo cerrado seguía afirmado como abierto.** El harness llevaba A-F1
codificado como nota al pie *dentro de una aserción viva*. Convertido en la
aserción inversa: si `validateAnswerCitations` deja de reportar
`citation_out_of_scope`, el check falla como `isolation-violation`.

### Estado de contratos tras la integración

| Contrato | Antes | Después |
|---|---|---|
| GR-001 | `solicitado` | **`aceptado`** |
| GR-002 | `solicitado` | **`aceptado`** |
| PRODUCT-001 | `parcialmente satisfecho` | **`aceptado`** |
| INTEGRATION-001 | `solicitado` | **`aceptado`** |
| GR-CAP-002 (`EXTRACTOR_VERSION`) | — | **`solicitado`** (fila nueva, → GROUNDING tren 3) |

### Hallazgos del tren 1 cerrados en el HEAD integrado

| # | Estado | Evidencia |
|---|---|---|
| A-F1 | **CLOSED** | `CitableChunkRecord` lleva `GroundingScope`; el scope se comprueba **antes** que cualquier issue más suave; 6 casos en `lib/grounding/__tests__/isolation.test.ts` |
| A-F2 | **CLOSED** | `capabilityUnavailable` reconciliado con `stripeCapabilityUnavailable`; +5 casos en `tests/stripe-webhook-capability.test.ts` |
| A-F3 | **CLOSED** | `contradictory_evidence` tiene un único productor comprobado; ya no es convención documentada |
| A-F9 | **CLOSED** | `capability-isolation` recorre también `db/` |
| A-F10 | **CLOSED** | `abstention-correctness` deja de contar presentación de cuota y `requires_human_review`; ambos se mueven a `structural-regression` |
| B-M3 | **CLOSED** | `components/stella/index.ts:66-67` exporta `stellaErrorPresentation` y `StellaPanelErrorCode` |
| B-M4 | **CLOSED** | el check detecta paquetes de cero bytes y exclusiones de config; control negativo `nc-cap-surface-zero-byte-packages` |
| B-M5 | **CLOSED** | el check de contradicción discrimina prosa real; control negativo `nc-contradiction-detector-silent-prose` |
| B-M6 | **CLOSED** | `structural-regression` se emite con `value: 1` (6/6); `latency` ya no se declara en checks que no pueden medirla |

**B-M3 — decisión adicional, con medición.** Cerrar el hallazgo no obliga a
mover la ruta de import. Medido 3× cada variante: consumir el barrel lleva el
eval de RELEASE de **6.2 s a 11.7 s (+90 %)**, porque arrastra ~15 paneles React
a un script Node offline que necesita un solo mapa de presentación de errores.
El import directo se conserva, y ahora es una elección con evidencia en vez de
un rodeo por un export que faltaba.

### Lo que NO se cerró, y por qué

- **Riesgos hosted** — ningún gate externo (G1…G9) se ejecutó ni puede
  ejecutarse offline.
- **pgvector (G5 P3)** — `grounding_0003` es deliberadamente pgvector-free
  precisamente para no forzar esa decisión; sigue abierta.
- **Calibración final de umbrales (R4)** — los umbrales canónicos siguen
  declarados como calibración local provisional. No hay conjunto etiquetado
  contra el que medirlos.
- **Retrieval con proveedor** — no existe. Las tres métricas dependientes de
  proveedor siguen `null` **con razón estructurada y gate nombrado**, no
  estimadas.
- **R6 (`no_matching_evidence`) y R7 (diversidad de fuentes)** — se calibran
  contra scores reales; cerrarlos ahora sería declarar calibrada una heurística
  que nadie midió.
- **Capacidades no habilitadas** — ninguna bandera cambió; ningún paquete SQL se
  aplicó a ninguna base.

### `command.test.ts`

Se **mantiene** en `pnpm test:unit`. Medido ~**15.9 s** (10 casos, 2
subprocesos). **No hay recursión**: lanza `tsx scripts/eval-release-offline.ts`,
no `vitest`. No duplica una batería: `harness.test.ts` mide los checks a nivel de
módulo; esto mide el **comando empaquetado** —exit code, salida estructurada,
determinismo entre procesos—, que ningún test de módulo puede observar.
Excluirlo exigiría un glob en `vitest.shared.ts`, y el propio harness tiene un
control negativo (`nc-cap-regression-test-excluded`) que existe porque los globs
de exclusión se tragan pruebas de regresión en silencio.

### Pruebas cruzadas nuevas

`tests/cross-workstream/` — 47 casos, 3 archivos, propiedad de integración:

| Archivo | Qué prueba |
|---|---|
| `grounding-to-product.test.ts` | conduce el retrieval **real** de GROUNDING sobre sus fixtures y lo mete en el adaptador **real** de PRODUCT: el score cruza intacto, el bucket no se recalcula, cross-project muere antes de la UI, el `ContradictionMarker` llega íntegro, y un chunk ausente nunca produce excerpt |
| `capabilities-to-grounding.test.ts` | el SQL entregado satisface GR-001 §5 y GR-002 §2, medido con el **parser de CAPABILITIES** y no con uno nuevo; scope compartido; `extractor_version` con contrato explícito y abierto |
| `grounding-product-to-release.test.ts` | las fixtures de RELEASE cierran su cadena de verificación con las primitivas de GROUNDING; el harness **no reimplementa** provenance ni umbrales; el check de aislamiento falla con proyecto cruzado; las métricas reconocen la forma integrada |

Ninguna usa fixtures inventadas por integración para representar el artefacto de
otra línea: una fixture así la escribiría la parte con menos razón para notar que
se desvió, que es exactamente cómo se rompió el harness de RELEASE.

## Documentos de línea

- [`docs/ops/workstreams/CAPABILITIES.md`](workstreams/CAPABILITIES.md)
- [`docs/ops/workstreams/GROUNDING.md`](workstreams/GROUNDING.md)
- [`docs/ops/workstreams/PRODUCT.md`](workstreams/PRODUCT.md)
- [`docs/ops/workstreams/RELEASE.md`](workstreams/RELEASE.md)

### Tren 3 — integrado 2026-08-05

`INTEGRATION_ROOT_HEAD` = `4d59348`. Las cuatro líneas entregaron dos commits
cada una, las cuatro descendían del root **sin commits intermedios no
declarados**, y los cuatro worktrees estaban limpios (staging vacío, untracked
vacío, sin upstream). PRODUCT se verificó específicamente: el rango
`4d59348..61a36ba` contiene exactamente `556a57e` y `61a36ba`, y no se
reescribió su historia.

| Línea | HEAD integrado | Commits fusionados | Pruebas focalizadas |
|---|---|---|---|
| CAPABILITIES | `6e3cbee` | `233f2f6`, `6e3cbee` | 201 + 851 passed / 18 skipped |
| GROUNDING | `65c6c2c` | `21949a5`, `65c6c2c` | 271 passed (14 archivos) |
| PRODUCT | `61a36ba` | `556a57e`, `61a36ba` | 363 passed (17 archivos) |
| RELEASE | `8eaf760` | `b0bcc3b`, `8eaf760` | 120 passed (5 archivos) |

Merges explícitos `--no-ff`, en ese orden. Sin cherry-pick, sin rebase, sin
reescritura de historia, sin push, sin acceso a remoto.

#### Qué añadió integración

El tren 3 tenía objetivo propio además de fusionar: convertir cuatro
bibliotecas en un **recorrido runtime alcanzable y fail-closed**.

| Pieza | Ruta | Nota |
|---|---|---|
| Server action | `app/actions/stella/grounded-query.ts` | bandera primero, scope derivado, mapeo único |
| Adaptador de repositorio | `db/grounding/grounding-chunk-repository.ts` | sobre `uellix_grounding.chunks_in_scope` |
| Wrapper server/client | `app/app/projects/[projectId]/pipeline/StellaGroundedQuerySection.tsx` | **no montado** |
| Bandera | `STELLA_GROUNDED_QUERY_ENABLED` | **`false`** |
| Gate de runtime | `runtime-entrypoint` (12.ª) | degrada `local-runtime-ready` |
| Pruebas cruzadas | `tests/cross-workstream/runtime-grounded-query.test.ts` | 22 casos |

#### Rutas ocupadas por integración en este tren

Registradas aquí en vez de asumirse como propiedad tácita (§7):

| Ruta | Motivo |
|---|---|
| `app/actions/stella/grounded-query.ts` | PRODUCT-002 pide explícitamente que la escriba integración |
| `db/grounding/**` | costura de persistencia entre `db/**` (CAPABILITIES) y `lib/grounding/**` (GROUNDING); ninguna de las dos puede escribirla sin cruzar a la otra |
| `app/app/projects/[projectId]/pipeline/StellaGroundedQuerySection.tsx` | cableado; no es una ruta |
| `.env.example` | ya `INTEGRATION-OWNED` (§7) |
| `lib/stella/config.ts` | una bandera nueva, `false`; la bandera es la mitad del contrato PRODUCT-002 §5 |
| `components/stella/grounding-adapter.ts`, `index.ts`, `StellaGroundedAnswerPanel.tsx` | reconciliación de contradicciones atribuidas: PRODUCT cerró antes de que GROUNDING publicara los campos |
| `tests/eval/stella-release/local-release-gate.{ts,test.ts}` | la instrucción de integración prohíbe conservar `local-runtime-ready=true` sin costura real |

#### Estado al cerrar

- Ninguna bandera encendida.
- Ningún paquete SQL aplicado a ninguna base persistente.
- Ningún proveedor externo llamado; ningún embedding remoto.
- Sin `service_role` en ninguna ruta nueva.
- Stack persistente no usado; toda la evidencia de base de datos viene de un
  contenedor desechable sin red.
- PRODUCT-002 queda `IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE`:
  el único montaje pendiente está documentado y es una línea.

---

## Tren 4 — integración (2026-08-05)

**Estado: DISEÑO + RUNTIME LOCAL VERIFICADO PARCIALMENTE. Nada aplicado a
ninguna base persistente. Ninguna bandera habilitada en el repositorio.**

Resultado global: **`STELLA_PARALLEL_TRAIN_4_INTEGRATION_BLOCKED_IDEMPOTENCY`**.
El recorrido local completo se ejecuta y pasa; lo único que falta para
`local-runtime-ready` es INT-INT-001 — ver
[`CONTRACT_LEDGER.md`](contracts/CONTRACT_LEDGER.md#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4).

### Resultado del tren 4

**`STELLA_PARALLEL_TRAIN_4_INTEGRATION_BLOCKED_IDEMPOTENCY`**

Las cuatro ramas se fusionaron con `--no-ff` y sus contratos cruzados quedaron
reconciliados. El recorrido local completo —documentos reales, extracción,
normalización, versión, chunks persistidos, retrieval SQL atestado, generación
extractiva, citas verificadas, presentación de Product, decisión humana local—
**se ejecuta en un contenedor desechable y pasa**.

`local-runtime-ready` **no** pasa a `true`, por una causa única y nombrada:
INT-INT-001. `consume_stella_quota` exige una clave de idempotencia y esta
aplicación no tiene fuente canónica para una. Toda clave derivable o bien cobra
dos veces un reintento, o bien deduplica una consulta legítima repetida. La
llamada **no** se hace, en vez de hacerse con una clave que parecería cerrar el
hueco y cobraría de más en silencio.

No se abre el tren 5.


---

## Tren 4.1 — INT-INT-001 CERRADO (integración, 2026-08-05)

**`runtime-quota-charged` pasa a `true`** por evidencia ejecutada, no por
diseño: la causa única que lo bloqueaba —la clave de idempotencia sin fuente
canónica— está cerrada.

**`local-runtime-ready` NO se flipa en este tren, y la distinción importa.**
El gate de cuota exigido por INT-INT-001 está satisfecho y medido, pero la
lista de criterios del E2E incluye «ticket cross-project: rechazo, cero cargo»
y ese criterio **no se cumple**: `bind_operation_ticket` y
`complete_operation_ticket` no reciben el proyecto contra el que se ejecuta la
consulta, así que la base no puede compararlo con el del ticket. Es R2-INT.
Declarar `local-runtime-ready=true` afirmaría una propiedad que la propia
batería mide como falsa.

**Qué se cableó.** `db/prepared/stella_0014_operation_tickets.sql` aplicado a
una base desechable; `app/actions/stella/grounded-query.ts` reestructurado a
`issue → bind → ejecutar → complete | abort`; canonicalización en
`lib/stella/operation-ticket/canonical-query-hash.ts`; emisor real de los diez
eventos en `lib/stella/operation-ticket/ticket-observability.ts`; adaptador en
`db/stella/operation-tickets.ts`; el ticket viaja como **segundo argumento** del
runner y el payload funcional sigue siendo `{ query }`.

**Con qué se probó.** `scripts/stella-ticket-e2e.sh` — PostgreSQL desechable
(sin volúmenes, publicado sólo en loopback, destruido al salir), baseline +
`grounding_0002/0003/0004` + `stella_0013` + `stella_0014`, server action real,
adapters reales, generador extractivo local, **cero proveedor**
(`env -u GEMINI_API_KEY`, reafirmado dentro del proceso). 22 escenarios, todos
verdes. Cada cargo se mide como **delta de filas de `stella_interactions`**
leído por una conexión distinta de la del runtime.

**El gate.** `runtime-quota-charged` ya no acepta un informe de dos campos:
exige nueve pruebas medidas (primer cargo, reintento sin cargo, ticket nuevo con
cargo, abort sin cargo, cross-scope sin cargo, concurrencia, semántica explícita
del reintento post-cobro, observabilidad runtime limpia, teardown sin residuos),
y un control negativo comprueba que **retirar cualquiera de las nueve** lo hace
fallar.

**Lo que NO cambió.** Banderas en `false` en el repositorio. `staging-blocked` y
`hosted-blocked` siguen en `true`. `consume_stella_quota` no se tocó. La
política R1 sigue siendo la conservadora: nunca exceder cuota, nunca mostrar
como exitosa una respuesta no cobrada.

**Riesgos abiertos**: R1 (armonización entre acciones hermanas), R2-INT
(atribución cross-proyecto, MAJOR), R3-INT, R4-INT, R5-INT, R6-INT, R7-INT — los
siete detallados en
[`CONTRACT_LEDGER.md`](contracts/CONTRACT_LEDGER.md#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4).

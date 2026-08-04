# Línea de trabajo: RELEASE Y CALIDAD

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-release`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-release`
- **HEAD base:** `INTEGRATION_ROOT_HEAD` = `ff1ffb66565d8f7b9377b6b05435e26ce80fa4a4`
  (`docs(ops): define parallel Stella workstreams` — el commit único de
  gobernanza sobre `c7c9736` que crea `STELLA_PARALLEL_WORKSTREAMS.md` y los
  cuatro documentos de `docs/ops/workstreams/`; confirmado por inspección
  directa de `git log` al abrir esta unidad, no asumido).
- **Propietario:** sin asignar

## Rutas autorizadas

- E2E (bajo `tests/**` que esta línea defina para ese propósito).
- Evals de calidad/latencia/costo (distintas de las evals funcionales de
  GROUNDING — coordinar por contrato si se solapan).
- Observabilidad, logging, métricas.
- Presupuestos de latencia y costos.
- Pruebas de aislamiento.
- Scripts de release.
- Staging y runbooks (`docs/ops/runbooks/**`).
- `.github/workflows/ci.yml`, `.github/workflows/p1a-validation.yml` — bajo
  el mismo protocolo de ruta compartida que el resto de `INTEGRATION-OWNED`
  (§7 del documento de gobernanza), porque estos workflows afectan a las
  cuatro líneas.

## Rutas prohibidas

- `db/**`, `supabase/**`, `db/prepared/**` y cualquier migración, SQL
  preparado, policy, rol o función SQL — propiedad exclusiva de CAPABILITIES.
- Contratos funcionales (interfaces TypeScript publicadas por GROUNDING,
  PRODUCT o CAPABILITIES) — RELEASE los consume, no los modifica.
- Composer, UI de la experiencia Stella (propiedad de PRODUCT).
- Extracción, normalización, retrieval, ranking, provenance de grounding
  (propiedad de GROUNDING).

## Dependencias

- Depende de que las otras tres líneas entreguen unidades verdes a
  integración para poder ejercer E2E y evals de extremo a extremo con
  contenido real.
- Coordina con integración cualquier cambio a `ci.yml` /
  `p1a-validation.yml` antes de aplicarlo (§7 del documento de gobernanza).

## Contratos requeridos

Ninguno registrado todavía. Esta unidad consumió exclusivamente contratos ya
publicados por GROUNDING (`lib/stella/context/**`, `lib/stella/schemas/**`)
y por PRODUCT (`components/stella/error-messages.ts`) — de solo lectura, sin
necesitar nada nuevo de otra línea.

## Unidad actual

`STELLA_RELEASE_EVALUATION_FOUNDATION_TRAIN_1` — primera base de
evaluaciones y criterios de release para Stella. Alcance: matriz de
evaluación versionada, harness local offline, y criterios de release por
entorno. Sin cambios a configuración compartida, sin acceso a base de datos,
sin acceso remoto, sin gates pesados.

### Qué se entregó

1. **Matriz de evaluación versionada** — [`tests/eval/stella-release/matrix.ts`](../../../tests/eval/stella-release/matrix.ts),
   `RELEASE_EVAL_MATRIX_VERSION = '1.0.0'`, 14 entradas (una por categoría
   requerida). Ver §Matriz de evaluación.
2. **Fixtures versionadas** — [`tests/eval/stella-release/fixtures.ts`](../../../tests/eval/stella-release/fixtures.ts),
   `RELEASE_FIXTURES_VERSION = '1.0.0'`. Dos tenants sintéticos
   (`organization-alpha-1` / `organization-beta-1`) con marcadores únicos
   para los casos de aislamiento, más fixtures de evidencia suficiente,
   insuficiente, contradictoria y de documento adversarial. Sin datos
   personales reales; todo id/nombre es ficticio.
3. **Harness local offline** — [`tests/eval/stella-release/harness.ts`](../../../tests/eval/stella-release/harness.ts) +
   [`tests/eval/stella-release/harness.test.ts`](../../../tests/eval/stella-release/harness.test.ts) +
   [`scripts/eval-release-offline.ts`](../../../scripts/eval-release-offline.ts).
   Ver §Harness local.
4. **Este documento** — criterios de release por entorno, gates, riesgos que
   bloquean hosted, flags que deben permanecer apagadas.

## Matriz de evaluación

Fuente de verdad: [`tests/eval/stella-release/matrix.ts`](../../../tests/eval/stella-release/matrix.ts)
(`RELEASE_EVAL_MATRIX`, validada por `validateReleaseEvalMatrix` — falla
cerrado ante `checkId` duplicado/faltante, categoría faltante, o una entrada
`offlineMeasurable: false` sin `offlineLimitation` declarada).

| Categoría | `checkId` | Medible offline hoy | Métrica(s) |
|---|---|---|---|
| evidencia suficiente | `sufficient-evidence-citation-resolves` | Sí | citation-precision, citation-coverage |
| evidencia insuficiente | `insufficient-evidence-empty-sentinel` | Sí | unsupported-claim-rate, abstention-correctness |
| contradicción | `contradiction-acknowledgment-heuristic` | **No** — heurística de palabras clave, no juicio semántico. Grading real requiere G1 | unsupported-claim-rate |
| cita correcta | `citation-correct-decodes` | Sí | citation-precision |
| cita incorrecta | `citation-incorrect-rejected` | Sí | citation-precision, unsupported-claim-rate |
| documento con instrucciones maliciosas | `malicious-document-envelope-holds` | Sí | isolation-violations |
| aislamiento cross-organization | `cross-organization-no-leak` | Sí (capa de aplicación; no sustituye RLS/G3) | isolation-violations |
| aislamiento cross-project | `cross-project-no-leak` | Sí | isolation-violations |
| abstención | `abstention-schema-enforced` | Sí | abstention-correctness |
| provider unavailable | `provider-unavailable-presentation` | Sí | latency (presentación, no medición real) |
| cuota agotada | `quota-exhausted-non-retryable` | Sí | abstention-correctness |
| reintento | `retryable-code-set-pinned` | Sí | latency (semántica de reintento, no medición real) |
| decisión humana | `human-decision-literal-true` | Sí | abstention-correctness |
| regresión CAP-01 a CAP-05 | `cap-01-05-regression-surface-present` | Sí (presencia estructural; NO ejecuta el gate pesado de CAPABILITIES) | structural-regression |

**Por qué 14 y no más:** son exactamente las 14 categorías pedidas para esta
unidad. Ampliar la matriz (más casos por categoría, cobertura de más pasos
del pipeline advisor además de `evidence`) es trabajo legítimo de una
próxima unidad de RELEASE, no de esta.

### Cómo se miden las métricas pedidas

Implementado en `computeReleaseMetrics()` dentro de `harness.ts`:

- **citation precision** — proporción de checks de citación (correcta +
  incorrecta + suficiente) que resolvieron/rechazaron como se esperaba.
- **citation coverage** — binaria: si la evidencia real en contexto es
  alcanzable vía una cita válida.
- **unsupported-claim rate** — `1 - (canarios de reclamo no soportado
  correctamente rechazados / total de esos canarios)`.
- **abstention correctness** — proporción de los 4 contratos de
  abstención/revisión-humana que se sostuvieron (insuficiencia de evidencia,
  esquema de abstención, cuota agotada, `requires_human_review` literal).
- **isolation violations** — conteo (no proporción) de fugas estructurales
  detectadas entre los 3 checks de aislamiento/inyección. Objetivo: 0 en
  todos los entornos, siempre.
- **latency, token usage, estimated provider cost** — **no medibles
  offline, y así se reportan explícitamente** (`measurable: false`, `value:
  null`, con la razón). Ninguna de las tres se puede fabricar sin una
  llamada real a un proveedor (gate G1). `lib/stella/cost-model.ts`
  (GROUNDING) ya documenta la fórmula de costo a aplicar una vez existan
  tokens reales — y declara sus propios supuestos como estimación de orden
  de magnitud pendiente de calibración contra facturación real (gate G9).
  Esta unidad no inventa un número donde no hay baseline.

## Harness local

[`scripts/eval-release-offline.ts`](../../../scripts/eval-release-offline.ts)
mirror exacto de `scripts/eval-offline.ts` / `scripts/eval-roles-offline.ts`
(mismo patrón `check()`/reporte/`process.exit(1)` en fallo).

```bash
pnpm exec tsx scripts/eval-release-offline.ts
```

**Nota de wiring:** esta línea no puede tocar `package.json`
(`INTEGRATION-OWNED`, §7 del documento de gobernanza). El script deja un
comentario "WIRING NOTE" pidiendo agregar
`"eval:release": "tsx scripts/eval-release-offline.ts"` al bloque
`scripts`, justo después de `"eval:roles"`, cuando integración lo aplique —
igual que hizo `scripts/eval-roles-offline.ts` en su momento para
`eval:roles`.

`tests/eval/stella-release/harness.test.ts` corre automáticamente bajo
`pnpm test:unit` (no requiere ningún cambio a `vitest.config.ts`: el include
por defecto ya cubre `tests/eval/**/*.test.ts`, y sólo `tests/integration/**`
está excluido — verificado leyendo `vitest.shared.ts` antes de escribir el
harness, no asumido).

### Garantías del harness (Fase 3)

- **Sin red, sin DB, sin proveedor, sin secretos de entorno.** El único I/O
  es `readFileSync`/`existsSync` sobre archivos ya versionados en el propio
  repo (`db/prepared/*.sql`, `tests/capability-*.test.ts`) para el check de
  regresión CAP — nunca se ejecutan ni se leen para interpretarlos, sólo se
  confirma su existencia.
- **Fixtures versionadas** — `RELEASE_FIXTURES_VERSION` y
  `RELEASE_EVAL_MATRIX_VERSION`, ambas `1.0.0`. Un cambio de fixtures que
  altere el comportamiento esperado de un check obliga a revisar esa
  versión.
- **Distingue error de sistema de respuesta abstencionista** (requisito
  explícito de la Fase 3): cada resultado lleva un `outcome` —
  `'pass' | 'abstention-response' | 'system-error' | 'isolation-violation'`
  — no sólo un booleano. Los checks `insufficient-evidence-empty-sentinel`,
  `abstention-schema-enforced` y `quota-exhausted-non-retryable` se
  clasifican como `abstention-response` cuando pasan: el pipeline decide
  correctamente no afirmar algo que no puede sostener. Cualquier otro tipo
  de fallo — una excepción del tipo equivocado, un esquema que no debería
  haber aceptado algo, un archivo de regresión ausente — se clasifica como
  `system-error`. `harness.test.ts` fija ambas clasificaciones con
  aserciones explícitas, no las infiere.
- **Falla cerrado ante desincronización matriz↔harness** —
  `assertChecksMatchMatrix()` lanza `ReleaseEvalHarnessError` si una entrada
  de la matriz no tiene check implementado, o si un check implementado no
  tiene entrada en la matriz. Probado en `harness.test.ts`.
- **Sin datos personales** — los dos tenants sintéticos y sus proyectos son
  ficticios; ningún nombre, id o texto libre en `fixtures.ts` corresponde a
  una organización, proyecto o persona real.

### Resultado de la corrida de referencia (Fase 3, este worktree)

```bash
pnpm exec tsx scripts/eval-release-offline.ts
```

`14/14 checks passed` — 11 `pass`, 3 `abstention-response`
(`insufficient-evidence-empty-sentinel`, `abstention-schema-enforced`,
`quota-exhausted-non-retryable`), 0 `system-error`, 0
`isolation-violation`, 0 `providerCalls`.

Métricas de esa corrida: `citation-precision=1`, `citation-coverage=1`,
`unsupported-claim-rate=0`, `abstention-correctness=1`,
`isolation-violations=0`; `latency`/`token-usage`/`estimated-provider-cost`
reportadas como no medibles offline (ver arriba).

## Criterios de release

Dos niveles previos ya definidos por la campaña Fable Moonshot
(`docs/ops/STELLA_FABLE_RELEASE_CRITERIA.md`) siguen vigentes y esta unidad
no los reemplaza: `STELLA_OFFLINE_RELEASE_CANDIDATE_READY` (offline, ya
alcanzado por esa campaña) y `PRODUCTION_READY` (requiere G1–G10 +
aprobación de Lorenzo). Lo que sigue añade el peldaño intermedio que faltaba
— criterios explícitos por entorno de despliegue, no sólo offline-vs-producción.

### Local integration

- **Gates obligatorios:** `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`
  (incluye ahora `tests/eval/stella-release/harness.test.ts`),
  `pnpm exec tsx scripts/eval-offline.ts`, `pnpm exec tsx scripts/eval-roles-offline.ts`,
  `pnpm exec tsx scripts/eval-release-offline.ts`.
- **Gates informativos:** `pnpm test:integration` / `pnpm test:rls` contra
  el stack local (requiere Supabase local levantado; no obligatorio para
  cada commit, sí antes de entregar una unidad a integración).
- **Evidencias requeridas:** salida de los comandos anteriores registrada
  (ver §Pruebas ejecutadas de este documento como plantilla).
- **Flags:** todas las `STELLA_*_ENABLED` en `false` (default de
  `.env.example`) — local integration nunca necesita habilitarlas para
  correr los gates de esta lista.

### Staging

- **Gates obligatorios:** todo lo de local integration, más
  `pnpm test:integration` / `pnpm test:rls` en verde contra el stack de
  staging, y los paquetes de gate G2/G3
  (`docs/ops/gates/G2_PACKAGE.md`, `G3_PACKAGE.md`) ejecutados por su dueño
  humano.
- **Gates informativos:** smoke test manual de gate G8
  (`docs/ops/gates/G8_PACKAGE.md`) sobre Preview.
- **Presupuestos por definir:** latencia p50/p95 y costo estimado por
  interacción — **sin baseline todavía**; esta unidad no fija un número
  porque no hay una corrida real que lo respalde (ver §Harness local,
  métricas no medibles offline). Definir tras la primera corrida de G1.
- **Evidencias requeridas:** resultado de G2/G3 archivado en
  `docs/ops/gates/*`, captura o log del smoke test G8.
- **Flags:** `STELLA_ENABLED` puede activarse en staging únicamente tras G2
  aplicado; los flags de rol de Fase 5b
  (`STELLA_DECISIONS_PERSISTENCE_ENABLED`, `STELLA_PROXY_REVIEWER_ENABLED`,
  `STELLA_EVIDENCE_REVIEWER_ENABLED`, `STELLA_AUDIT_ASSISTANT_ENABLED`)
  permanecen en `false` — activarlas es un gate propio posterior (G4),
  nunca automático por llegar a staging.

### Hosted (Preview/producción expuesta a tráfico real, aunque sea limitado)

- **Gates obligatorios:** todo lo de staging en verde, más gate G1
  (`docs/ops/gates/G1_PACKAGE.md`, evaluación con Gemini real) ejecutado y
  revisado por Lorenzo, gate G4 (`docs/ops/gates/G4_PACKAGE.md`, activación
  de flags en Vercel) con valores explícitos por cohorte, y gate G7
  (`docs/ops/gates/G7_PACKAGE.md`, revisión legal) con aptitud firmada si el
  tráfico incluye usuarios externos.
- **Riesgos que bloquean hosted (verificados contra el repo en esta unidad,
  no re-derivados):**
  - **RR-CAP-14-A** — la base de datos no puede verificar una firma de
    Stripe; esa comprobación vive enteramente en el manejador Node, así que
    la credencial de `uellix_stripe` ES la frontera de confianza (MAJOR,
    ABIERTO, inherente al diseño — `docs/ops/gates/G3_PACKAGE.md:476`,
    `docs/ops/capabilities/ADVERSARIAL_FINDINGS.md`). Antes de hosted:
    confirmar que la credencial `uellix_stripe` está rotada y fuera de
    cualquier servicio compartido (DP-CAP-07).
  - **RR-CAP-10-C** — `service_role` conserva `UPDATE` de tabla completa y
    `BYPASSRLS` sobre `organizations` **y** `users`; la *service key* de
    Supabase puede mover una cuota o escalar a super-admin sin escribir
    fila de auditoría (MAJOR, ABIERTO, fuera de alcance declarado —
    territorio de RR-CAP-7). Antes de hosted: inventariar quién tiene la
    *service key* real y confirmar que no vive en ningún proceso expuesto
    a usuarios.
  - **RR-CAP-02-H** — `verify_report` devuelve `public_summary` sin un
    booleano de visibilidad propio, a diferencia de los otros seis campos
    de disclosure (MAJOR, ABIERTO, decisión de producto pendiente). Antes
    de habilitar verificación pública de cara a usuarios externos: decidir
    si se añade `show_public_summary` o se acepta el argumento contrario ya
    registrado (que el campo es el objeto de la publicación, no una fuga).
  - **RR-CAP-02-I** — los 4 triggers de la cadena de auditoría de
    disclosures se crean con `tgenabled='O'`, así que
    `session_replication_role='replica'` los suprime (MINOR, ABIERTO,
    residual aceptado). Antes de hosted: confirmar que ningún proceso
    operativo cambia `session_replication_role` contra la base de
    producción sin pasar por un runbook que lo advierta.

  Ninguno de los cuatro se corrige en esta unidad — RELEASE no modifica
  SQL ni contratos funcionales (§ Rutas prohibidas). Se registran aquí
  porque hosted es exactamente el punto en el que dejan de ser teóricos.
- **Evidencias requeridas:** paquete G1 con resultados reales archivados,
  configuración G4 aplicada y visible en Vercel, aptitud legal G7 (si
  aplica), y una nota explícita de qué mitigación operativa cubre cada
  riesgo de la lista anterior mientras las causas raíz siguen abiertas.
- **Flags que deben permanecer apagadas en hosted hasta su propio gate:**
  las 4 de Fase 5b (`STELLA_DECISIONS_PERSISTENCE_ENABLED`,
  `STELLA_PROXY_REVIEWER_ENABLED`, `STELLA_EVIDENCE_REVIEWER_ENABLED`,
  `STELLA_AUDIT_ASSISTANT_ENABLED` — activación de a una por vez, sólo tras
  `eval:roles` en verde, per `.env.example:22-27`).

### Release candidate

- **Gates obligatorios:** todos los de hosted en verde y estables durante
  una ventana observada (no sólo en el instante de la corrida), más C1–C18
  de `docs/ops/STELLA_FABLE_RELEASE_CRITERIA.md` sin regresión.
- **Gates informativos:** gate G9 (`docs/ops/gates/G9_PACKAGE.md`,
  calibración de costos reales) — informativo para RC porque requiere
  tráfico real post-G1/G8, que un RC recién cortado todavía no acumuló.
- **Presupuestos por definir:** los mismos de staging, ahora con datos
  reales de G1/G8 — este es el punto en el que `estimated-provider-cost`
  dejaría de ser `null` en este harness si se decidiera extenderlo a
  consumir un reporte de G9 (fuera del alcance de esta unidad).
- **Evidencias requeridas:** `docs/ops/STELLA_FABLE_TEST_LEDGER.md`
  actualizado con la ventana observada; registro de qué P0/P1 del
  `RISK_REGISTER` siguen abiertos y por qué ninguno bloquea el corte de RC.
- **Riesgos que bloquean hosted (arriba) siguen bloqueando RC** — un RC no
  es una excepción a esa lista, es un punto donde además deben tener
  mitigación operativa documentada, no sólo registrada.
- **Flags:** las mismas restricciones que hosted.

### Production

- **Gates obligatorios:** G1–G9 superados con evidencia real (no
  preparada) + gate G10 (`docs/ops/gates/G10_PACKAGE.md`) con aprobación
  explícita de Lorenzo en sus dos puntos de decisión (piloto y producción).
  Ningún agente de ninguna línea puede declarar `PRODUCTION_READY` — sólo
  Lorenzo, per `docs/ops/STELLA_FABLE_RELEASE_CRITERIA.md`.
  - **RR-CAP-14-A** y **RR-CAP-10-C** en particular no tienen un gate que
    los cierre — son inherentes al diseño actual (custodia de credenciales)
    y quedan como riesgo operativo aceptado explícitamente en G10, no como
    ítem pendiente de un futuro paquete SQL.
- **Gates informativos:** monitoreo continuo post-piloto (parte del propio
  G10).
- **Evidencias requeridas:** todo lo acumulado en RC, más el registro de
  piloto controlado (cohortes, criterios de éxito/aborto) que G10 exige.
- **Flags:** activación gradual por cohorte, nunca "todas en `true`" de una
  vez — mismo criterio que G4 ya documenta.

## Riesgos

- Esta unidad no ejecuta gates pesados ni toca DB/remoto — los riesgos de
  esa naturaleza (RK-04* del `RISK_REGISTER`) no aplican a su alcance.
- **Suite `pnpm test:unit` completa: 7 tests fallando en 8 archivos, los 8
  preexistentes y no relacionados con esta unidad** (confirmado:
  `git status` antes de este cambio mostraba árbol limpio, y el diff de esta
  unidad son únicamente archivos nuevos bajo `tests/eval/stella-release/` y
  `scripts/eval-release-offline.ts` — ninguno de los archivos que fallan
  fue tocado). Dos causas raíz distintas, ninguna de esta unidad:
  1. Una variable de entorno `GEMINI_API_KEY` ambiental está presente en el
     shell de este worktree (no en ningún archivo del repo — `.env` real no
     está trackeado). Rompe las aserciones de invariante de seguridad "does
     not read GEMINI_API_KEY env var" en `StellaAdvisorPanel.test.tsx`,
     `StellaValidatorPanel.test.tsx`, `contextual-advisor.test.ts` y
     probablemente los paneles/acciones hermanos que comparten el mismo
     patrón de aserción. **Acción recomendada para quien retome esta
     línea:** limpiar `GEMINI_API_KEY` del entorno del shell antes de correr
     `pnpm test:unit`; no es un secreto de este repo, es contaminación de
     sesión.
  2. Una aserción de regex sobre un comentario literal en
     `tests/prepared-stella-sql.test.ts:2311` no matchea contra el texto
     actual del archivo fuente — no investigado en profundidad por ser
     propiedad de CAPABILITIES (`db/prepared/**` y sus tests son ruta
     prohibida para RELEASE).
  - Ninguna de las dos causas es accionable dentro de esta unidad sin salir
    de sus rutas autorizadas. Se registra aquí para que integración lo vea
    antes de asumir que `pnpm test:unit` está en rojo por esta entrega.
- **Categoría "contradicción" es heurística, no semántica** (ver matriz) —
  riesgo de falsos negativos/positivos si se usa como gate duro. Se marca
  `offlineMeasurable: false` explícitamente por eso; no debe promoverse a
  gate obligatorio sin pasar primero por G1.
- **El check de aislamiento cross-organization/cross-project opera en la
  capa de aplicación (context builders), no contra RLS real.** No sustituye
  `tests/integration/rls.test.ts` (CAPABILITIES) ni gate G3. Está declarado
  así en la matriz para que nadie lo lea como cobertura de RLS.

## Pruebas ejecutadas

Todas en este worktree, sin red, sin DB, sin secretos reales:

| Comando | Resultado |
|---|---|
| `pnpm install --frozen-lockfile` | `node_modules` no existía en este worktree; instalado sin tocar `pnpm-lock.yaml` |
| `pnpm exec tsc --noEmit` | limpio, 0 errores |
| `pnpm exec tsx scripts/eval-release-offline.ts` | `14/14 checks passed`, 0 `system-error`, 0 `isolation-violation`, 0 `providerCalls` |
| `pnpm exec vitest run tests/eval/stella-release` | `1 test file passed`, `14/14 tests passed` |
| `pnpm exec vitest run` (suite completa, no-integración) | `146 passed / 8 failed` archivos, `3563 passed / 7 failed / 125 skipped` tests — los 8 archivos fallando son preexistentes y ajenos a esta unidad (ver §Riesgos) |

No se ejecutó `pnpm test:integration` ni `pnpm test:rls` (requieren un
stack Supabase local levantado; fuera del alcance "sin gates pesados" de
esta unidad, y esta unidad no toca ninguna ruta que esas suites cubran).

## Estado de entrega a integración

Lista para integración. Árbol limpio salvo los dos commits de esta unidad
(`test(stella): add grounding and isolation evaluation fixtures` y
`docs(ops): define Stella release evidence criteria`), ninguna ruta
`INTEGRATION-OWNED` ni de otra línea tocada, sin push, sin acceso remoto,
sin gates pesados ejecutados. `pnpm typecheck` y el harness nuevo en verde;
la suite completa tiene fallas preexistentes documentadas arriba, ninguna
introducida por esta entrega.

`STELLA_RELEASE_TRAIN_1_READY_FOR_INTEGRATION`

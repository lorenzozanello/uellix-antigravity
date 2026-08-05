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

---

## Integración — tren 1 (2026-08-04)

**Fusionada.** HEAD integrado `55a9e48`, commits `74d559a` y `55a9e48`, merge
commit `847795d` (`--no-ff`). Última de las cuatro en entrar, sin conflictos —
esta línea no tocó ningún archivo compartido ni ninguna ruta de otra línea.

### Pruebas en el HEAD integrado

| Comando | Resultado |
|---|---|
| `vitest run tests/eval/stella-release/harness.test.ts` | **14 passed** |
| `tsx scripts/eval-release-offline.ts` | **14/14 checks**, `pass=11 abstention=3 system-error=0 isolation-violation=0`, cero `providerCalls` |

Confirmado en el árbol integrado:

- Matriz versionada: `RELEASE_EVAL_MATRIX_VERSION = '1.0.0'`, fixtures `1.0.0`.
- **14 casos**, ni uno más ni uno menos, y el harness falla si un check
  implementado no tiene entrada en la matriz.
- **Cero dependencia de red**: ninguna llamada `fetch`/HTTP ni lectura de
  `GEMINI_API_KEY`/`GOOGLE_*` en todo `tests/eval/stella-release/` ni en el
  script.
- Métricas no baselined reportadas como `null` con razón explícita, nunca
  fabricadas: `latency`, `token-usage` y `estimated-provider-cost` salen
  `measurable: false, value: null` apuntando a los gates G1 y G9.
- Riesgos hosted conservados: `RR-CAP-14-A`, `RR-CAP-10-C`, `RR-CAP-02-H` y
  `RR-CAP-02-I` siguen listados con su estado y su mitigación operativa
  requerida.

### La suite completa, resuelta

Esta línea entregó registrando **7 tests fallando en 8 archivos** y dos causas
raíz sospechadas. Integración las verificó y **ambas eran correctas**; una está
cerrada y la otra caracterizada:

1. **`GEMINI_API_KEY` ambiental — confirmada y neutralizada.** Eliminando la
   variable únicamente del entorno del proceso de prueba (`env -u`, sin tocar
   ningún archivo `.env`), los fallos de `StellaAdvisorPanel`,
   `StellaValidatorPanel` y `contextual-advisor` desaparecen. La recomendación
   de esta línea era la correcta.
2. **La aserción de regex de `tests/prepared-stella-sql.test.ts` — no era el
   texto del comentario, era CRLF.** Es CT-CAP-003: con `core.autocrlf=true` el
   checkout materializaba `db/prepared/**` en CRLF y las aserciones anclan en
   `\n`. Cerrado por integración con `db/prepared/** text eol=lf` en
   `.gitattributes`. La suite entrega ahora **687 passed** junto a las otras
   tres afectadas. Esta línea hizo bien en no investigarlo: era ruta prohibida.

**`pnpm test:unit` en el HEAD integrado: 3920 passed / 2 failed / 125 skipped**
(162 archivos). Los 2 restantes, clasificados con evidencia:

- `tests/database-entrypoint-safety.test.ts` — **ambiental, no regresión.** La
  suite de integración colecta 0 de 49 porque el worktree no tiene `.env.local`.
  Los cinco archivos implicados tienen 0 commits desde `ff1ffb6`.
- `tests/database-runtime-entrypoints.test.ts` — **flake por carga.** Un import
  dinámico excede el `testTimeout` de 5 s bajo la batería completa. El mismo
  archivo, en el mismo HEAD, pasa en aislamiento (308 passed) y dentro de la
  corrida focalizada de capacidades. No se cambiaron timeouts.

### Gates pesados integrados

Serializados, un gate a la vez (§11): `typecheck` limpio · `lint` 0 errores /
44 warnings · `build` verde · `capability-baseline-verify` **38/107/10** ·
`capability-dry-run` forward **42/151/7/10/1**, **132/132** aserciones vivas
(concurrencia **7/7**), rollback **40/108**, reaplicación **42/151/7/10/1**.
Todas las cifras idénticas a las vigentes antes del tren: la integración no
movió el comportamiento de la base de datos, que es lo que se esperaba porque
ninguna línea aplicó ni modificó un paquete SQL.

Dry-run en contenedor desechable con `--network none` sobre `db/baseline/**`,
destruido al salir. Cero escrituras a ninguna base real.

### Criterios de release tras el tren 1

**Local integration:** todos los gates obligatorios en verde salvo los dos
fallos caracterizados arriba, ninguno de los cuales es una regresión. Las
banderas `STELLA_*_ENABLED` siguen en `false` y
`WEBHOOK_DATABASE_IDENTITY_AVAILABLE` sigue en `false`.

**Staging y superiores:** sin cambio. Ningún gate G1–G10 se ejecutó ni se
declaró superado en esta integración, y nada aquí acerca ni aleja los cuatro
riesgos que bloquean hosted.

### Trabajo de entrada del tren 2

Extender el harness a los contratos de grounding cuando exista retrieval real
(hoy la matriz evalúa el contrato del advisor, no el de `lib/grounding`), y
definir los presupuestos de latencia p50/p95 y costo por interacción — que
siguen sin baseline porque siguen requiriendo G1.

### Hallazgos de la revisión adversarial de integración

Ninguno es regresión: los cuatro MAJOR son defectos internos del harness
entregado. Integración no los parcheó porque exigen lógica nueva, que es trabajo
de esta línea.

- **B-M4 (MAJOR)** — `cap-01-05-regression-surface-present`
  (`harness.ts:523-544`) es `existsSync` sobre 13 rutas **más una tautología**:
  `CAP_REGRESSION_TEST_FILES.every((f) => !f.startsWith(tests/integration/))`
  evalúa un array literal contra un prefijo literal y es `true` por
  construcción. El comentario afirma que confirma que las pruebas de regresión
  no están excluidas del vitest config por defecto; nunca lee un config.
  Truncar `stella_0008_*.sql` a cero bytes deja el check en verde.
- **B-M5 (MAJOR)** — `contradiction-acknowledgment-heuristic`
  (`harness.ts:176-201`) comprueba que `CONTRACTION_KEYWORDS` matchea un
  literal definido tres líneas más arriba. La entrada de matriz declara
  `offlineMeasurable: false` y aun así se cuenta en `passed`, sin distinción,
  dentro del titular «14/14».
- **B-M6 (MAJOR)** — `structural-regression` está declarada
  (`matrix.ts:27`, `:171`) y **no se emite** en `computeReleaseMetrics`.
  Simétricamente, `matrix.ts:139` y `:155` declaran `metrics: [latency]` para
  dos checks mientras `latency` está cableada a `measurable:false, value:null`
  sin leerlos. `validateReleaseEvalMatrix` valida ids, duplicados, categorías y
  limitaciones — nunca el enlace matriz-métrica.
- **B-M3 (rebajado a MINOR por integración)** — `harness.ts:38` importa
  `@/components/stella/error-messages`, un interno de PRODUCT, en vez del
  barrel. El revisor leyó `Record<StellaPanelErrorCode, boolean>` como
  acoplamiento que bloquearía a PRODUCT; **es el propósito declarado del
  check**, que se llama `retryable-code-set-pinned` y existe para fallar si
  alguien añade un código sin decidir su retryabilidad. Queda por corregir sólo
  la ruta de import (PRODUCT exporta, RELEASE consume el barrel).
- **B-M2 (corregido por integración)** — la cabecera de `fixtures.ts`
  atribuía `lib/stella/context/**` a GROUNDING. Es código de fundación
  preexistente; GROUNDING nunca lo tocó y su superficie publicada es
  `lib/grounding/contracts/index.ts`, que **nadie importa**. Borrar los 18
  archivos del tren de GROUNDING dejaría estos 14 checks en verde. Comentario
  corregido para que la tabla de evidencias no se lea como cobertura de
  grounding.
- **A-F10 (MINOR)** — `abstention-schema-enforced` es `offlineMeasurable: true`
  sin `offlineLimitation`, pese a evaluar dos literales escritos a mano.
  `cross-organization-no-leak` sí declara la limitación en la misma situación.
  Además `abstention-correctness: 4/4` incluye dos checks que no son de
  abstención (`quota-exhausted-non-retryable`, `human-decision-literal-true`).
- **B-m5 (MINOR)** — `scripts/eval-release-offline.ts` sólo es invocable como
  `pnpm exec tsx …`: falta la entrada `eval:release` en `package.json`, que es
  `INTEGRATION-OWNED` (§7). Esta línea lo anotó como nota pero **no abrió fila
  de contrato**, a diferencia de CT-CAP-004, que sí la tiene para el mismo tipo
  de necesidad. Abrirla es trabajo de entrada del tren 2.

## Preparación de raíz compartida — tren 2 (integración, 2026-08-04)

**B-m5 → cerrado.** `package.json` gana
`"test:stella:release-eval": "tsx scripts/eval-release-offline.ts"` (nombre
`test:stella:release-eval` en vez de `eval:release`, sin conflicto real con
ningún script existente). Sigue invocable también como `pnpm exec tsx
scripts/eval-release-offline.ts`. Nueva prueba estructural,
`tests/eval/stella-release/wiring.test.ts`, fija que el script apunta
exactamente al harness correcto y que el entrypoint no contiene llamadas de
red, secretos ni activación de proveedor/flags — no ejecuta el harness (eso ya
lo cubre `harness.test.ts`), sólo la superficie de `package.json`. Resultado
de referencia sin cambios: `14/14 checks`,
`pass=11 abstention=3 system-error=0 isolation-violation=0`, cero
`providerCalls`.

**El flake por carga de `tests/database-runtime-entrypoints.test.ts` →
reparado**, no sólo caracterizado. El `await import(...)` dentro del `it()`
que competía con el `testTimeout` de 5s bajo la batería completa se convirtió
en import estático de los tres módulos que la prueba inspecciona
(`@/lib/auth/session`, `@/lib/auth/database-context`, `@/db/identity-context`)
— el costo se paga en la colección del archivo, no en la prueba. `187/187`
verdes en aislamiento; `0/2` fallos en dos corridas completas de `test:unit`
tras el cambio (detalle completo, incluida una **segunda instancia** del mismo
patrón encontrada en un archivo ajeno a esta línea, en
[`STELLA_PARALLEL_WORKSTREAMS.md` §13](../STELLA_PARALLEL_WORKSTREAMS.md#preparación-de-raíz-compartida-para-el-tren-2--2026-08-04)).

No se tocó ningún hallazgo MAJOR de esta sección (B-M4/M5/M6): siguen siendo
trabajo de entrada de RELEASE en el tren 2, sin cambios.

---

# Tren 2 — `STELLA_RELEASE_EVALUATION_HARDENING_TRAIN_2`

**HEAD base:** `597819b` (`chore(integration): prepare shared Stella train 2
root`, = `TRAIN_2_ROOT_HEAD`). Árbol limpio al abrir y al cerrar. Sin push, sin
acceso a remoto, sin llamadas a proveedor, sin gates pesados, sin tocar
`db/**`, `supabase/**`, contratos funcionales ni ninguna ruta
`INTEGRATION-OWNED`.

**Alcance:** cerrar B-M4, B-M5 y B-M6; hacer que ningún check pueda pasar por
construcción; emitir de verdad las métricas declaradas; y dejar criterios
medibles de grounding y aislamiento listos para el tren 2 integrado.

## El problema real del tren 1, y por qué no se arregló función por función

Los tres MAJOR no eran tres errores independientes. Los dos primeros comparten
una forma: **el check afirma una propiedad del sistema pero sólo evalúa datos
que el propio check acaba de construir.** Reescribir esas dos funciones no
habría impedido la tercera aparición del mismo patrón.

Reproducidos antes de tocar nada:

| Hallazgo | Reproducción |
|---|---|
| **B-M4** | Se replicó la lógica exacta de `checkCapRegressionSurfacePresent` contra un root sintético donde los 13 archivos existen y **pesan cero bytes**: `missing.length = 0`, `stillOwnedByDefaultConfig = true`, veredicto **PASS**. Y `CAP_REGRESSION_TEST_FILES.every(f => !f.startsWith('tests/integration/'))` sobre un array literal de módulo evalúa `true` para las tres rutas, siempre. El comentario afirmaba confirmar que las pruebas no están excluidas del config por defecto; nunca leía un config. **La reproducción no tocó `db/**`** — se hizo en un directorio temporal fuera del repo. |
| **B-M5** | `acknowledging` y `silent` estaban declarados tres líneas por encima de la aserción que los comparaba (`harness.ts:177-179` del tren 1). Nada fuera de esas tres líneas podía cambiar el resultado. Además la entrada de matriz declara `offlineMeasurable: false` y el check contaba en `passed` sin ninguna distinción en el titular «14/14». |
| **B-M6** | Directamente en la salida de referencia del tren 1: la matriz declara `structural-regression` y el bloque de métricas emite **8**, sin ella. Simétricamente, dos entradas declaraban `metrics: ['latency']` mientras `latency` estaba cableada a `null` sin leerlas. Nada reconciliaba los dos catálogos. |

Por eso el cambio es **estructural**: un check ya no prueba nada por devolver
`ok`. Debe además demostrar que **el mismo evaluador** rechaza una entrada
donde la propiedad está rota a propósito. Un check que pasa mientras su propia
mutación también pasa se reporta como `system-error` con prefijo
`TAUTOLOGICAL` y **hace fallar el proceso** — un check que no puede fallar
declara una cobertura que no existe, y eso es peor que no tener el check.

## Controles negativos

[`tests/eval/stella-release/negative-controls.ts`](../../../tests/eval/stella-release/negative-controls.ts)
(nuevo). **37 controles, uno o más por cada uno de los 19 checks**, todos
detectando en la corrida de referencia. Una sonda que lanza cuenta como **no
detectada**: «no se pudo establecer» nunca puede leerse como «establecido».

Cobertura exigida por la Fase 2:

| Propiedad | Control | Qué muta |
|---|---|---|
| aislamiento de organización | `nc-cross-organization-planted-marker` | fixture de alpha con el marcador de beta plantado |
| aislamiento de organización | `nc-cross-organization-wrong-org-id` | `organizationId` esperado que no coincide |
| aislamiento de proyecto | `nc-cross-project-planted-evidence` | evidencia del proyecto dos dentro del proyecto uno |
| aislamiento de proyecto (contrato) | `nc-scope-sibling-project-citation` | cita a un proyecto hermano de la **misma** organización |
| cita inexistente | `nc-scope-citation-without-source`, `nc-adapter-phantom-chunk` | `chunkId` que ningún retrieval produjo |
| cita incorrecta | `nc-adapter-drifted-quote`, `nc-provenance-tampered-text` | `quotedTextHash` que no corresponde al pasaje |
| abstención incorrecta | `nc-abstention-human-review-false`, `nc-reviewer-false-not-rescued-by-low-risk` | `requires_human_review: false`, y con el resto de campos «buenos» |
| contradicción ignorada | `nc-contradiction-ignored`, `nc-contradiction-auto-resolved` | ambos lados citados sin marcador; marcador que afirma resolución automática |
| prompt injection aceptada | `nc-injection-detector-benign-document` | documento benigno que el detector **no** debe marcar |
| error de sistema como abstención | `nc-system-error-not-classified-as-abstention` | `TypeError` a través del clasificador compartido |

Además hay controles de **no-sobre-rechazo**, que es el fallo simétrico y el
que un control negativo ingenuo no ve: `nc-rejector-still-accepts-valid`
(un decodificador que rechazara todo satisfaría las tres variantes de
«cita incorrecta» y sería inútil), `nc-provider-not-everything-retryable`,
`nc-quota-echo-is-code-specific`.

**Ningún control compara una constante con otra constante.** Los que evalúan
texto lo toman de fixtures (`CONTRADICTION_ACKNOWLEDGMENT_TEXT` frente al
`narrativeSummary` del propio `CONTRADICTORY_CONTEXT`), y el check se niega a
correr si esa narrativa está vacía — un detector que respondiera `true` a todo
seguiría devolviendo `false` sobre `''`, y ese verde sería falso.

### Verificación de extremo a extremo, no sólo por prueba unitaria

Se comprobó dos veces que el harness **falla de verdad**, mutando el árbol y
revirtiendo después:

| Mutación | Resultado |
|---|---|
| marcador de beta plantado en `ORG_ALPHA_CONTEXT` | `EXIT 1`; `FAIL [isolation-violation] cross-organization-no-leak`; `isolation-violations: 1`; dos razones de fallo reportadas |
| `BENIGN_DOCUMENT_PAYLOAD` reescrito para parecer una inyección | `EXIT 1`; `FAIL [system-error] malicious-document-envelope-holds — TAUTOLOGICAL`; `negativeControlsUndetected: 1` |

Ambas mutaciones fueron revertidas; el árbol entregado no las contiene.

## B-M4 — cerrado

`cap-01-05-regression-surface-present` ya no es `existsSync` más una
tautología:

- **Contenido, no presencia.** Cada paquete debe superar un piso de 1024 bytes
  y conservar su marcador estructural (`uellix_capability` en los forward,
  `DROP` en los rollback). Los reales pesan 27–62 kB.
- **El config real, no un literal.** Las rutas de los tests de regresión se
  comparan contra las globs de exclusión **leídas de `vitest.shared.ts`**
  (sólo lectura; el archivo es `INTEGRATION-OWNED` y no se modificó). Si
  alguien mueve un test de CAP bajo una ruta excluida, o añade una exclusión
  que se lo trague, el check lo dice.
- **Sonda inyectable.** El control negativo presenta un root donde todo existe
  y todo pesa cero **sin escribir un solo archivo**. El harness declara que su
  único I/O es lectura de archivos versionados; demostrar un punto violando esa
  garantía habría cambiado una afirmación falsa por otra.

## B-M5 — cerrado

- Los dos textos de sonda vienen de fixtures, no de literales internos.
- La propiedad **estructural** («ambos lados de la contradicción llegan al
  catálogo de citas») ahora se mide con control negativo: un contexto al que se
  le quita un lado debe reportarse.
- El titular ya no puede esconder la limitación: la salida separa
  `offline coverage: N fully measurable, M offline-limited`. En la corrida de
  referencia son **18 y 1**.
- La entrada de matriz sigue `offlineMeasurable: false`, y su
  `offlineLimitation` ahora distingue explícitamente lo que sí se mide offline
  (la parte estructural) de lo que no (calificación semántica de prosa
  **generada**, que requiere G1).

Se añadió además una categoría nueva de contradicción sobre el contrato de
GROUNDING — ver `grounding-contradiction-marked` más abajo — que sí mide la
regla dura: citar ambos lados sin `ContradictionMarker` y sin abstenerse es un
fallo.

## B-M6 — cerrado

- `structural-regression` **se emite**. Vale `1` (6/6) en la corrida de
  referencia.
- `assertMetricsMatchMatrix()` reconcilia los dos catálogos en cada corrida y
  lanza si la matriz declara una métrica que nadie emite, o si se emite una que
  nadie declara. Ese enlace era exactamente lo que no existía.
- Las métricas dependientes de proveedor **ya no se atan a ningún check**. Se
  declaran una sola vez en `PROVIDER_DEPENDENT_METRICS`, y
  `validateReleaseEvalMatrix` **rechaza** una entrada que pretenda alimentarlas.
  Declarar una métrica que un check no puede producir es exactamente cómo un
  tablero termina mostrando un número que nadie calculó.
- Los dos checks que declaraban `latency` (`provider-unavailable-presentation`,
  `retryable-code-set-pinned`) alimentan ahora `structural-regression`, que es
  lo que de verdad fijan.

## A-F10 — cerrado

- `abstention-schema-enforced` declara su `offlineLimitation`: evalúa fixtures
  contra un esquema Zod, y lo que mide es que el **contrato** rechaza lo que
  debe rechazar, no que un modelo real se abstenga cuando debe.
- `abstention-correctness` dejó de incluir dos checks que no son de abstención.
  `quota-exhausted-non-retryable` (agotar la cuota no es que el pipeline decida
  abstenerse: es que no llegó a ejecutarse) y `human-decision-literal-true` (un
  literal de contrato que el esquema impone siempre) pasaron a
  `structural-regression`. La métrica bajó de 4/4 a **3/3** y ahora cuenta
  contratos de abstención genuinos.

## Matriz de evaluación — v2.0.0

`RELEASE_EVAL_MATRIX_VERSION = '2.0.0'`, `RELEASE_FIXTURES_VERSION = '2.0.0'`,
`RELEASE_HARNESS_VERSION = '2.0.0'` (el harness gana su propia versión: la
semántica de los checks puede cambiar sin que cambie la forma de la matriz).

**19 entradas**, 19 categorías. Las 14 del tren 1 conservan su `checkId` y su
categoría; cambian su implementación, su descripción (que ahora nombra el
control negativo que la mantiene honesta) y, en cuatro casos, la métrica que
alimentan. Las 5 nuevas son de contrato de grounding:

| Categoría | `checkId` | Métrica | Offline |
|---|---|---|---|
| grounding — project scope | `grounding-project-scope-enforced` | isolation-violations, unsupported-claim-rate | Sí (contrato, no RLS) |
| grounding — provenance | `grounding-provenance-canonical` | citation-coverage | Sí |
| grounding — score | `grounding-retrieval-score-ordering` | structural-regression | Sí |
| grounding — contradicción | `grounding-contradiction-marked` | abstention-correctness | Sí |
| grounding — adaptador PRODUCT | `grounding-product-adapter-input-complete` | citation-precision | Sí |

**Ampliar la matriz era trabajo previsto**: el propio documento del tren 1 lo
declaró como «trabajo legítimo de una próxima unidad de RELEASE».

## Métricas emitidas — corrida de referencia

```bash
pnpm test:stella:release-eval
```

`19/19 checks passed` · `pass=15 abstention=4 system-error=0
isolation-violation=0` · `offline coverage: 18 fully measurable, 1
offline-limited` · `negative controls: 37 run, 0 undetected` · `providerCalls=0`

| Métrica | Valor | Base |
|---|---|---|
| `citation-precision` | `1` | 4/4 checks de citación resolvieron/rechazaron/proyectaron correctamente |
| `citation-coverage` | `1` | 2/2 — la evidencia real es alcanzable por una cita válida **y** su cadena de provenance cierra |
| `unsupported-claim-rate` | `0` | 4/4 canarios de reclamo no soportado rechazados (`1 - caught/total`) |
| `abstention-correctness` | `1` | 3/3 contratos de abstención genuinos (ver A-F10) |
| `isolation-violations` | `0` | conteo, no proporción, sobre 4 checks |
| `structural-regression` | `1` | 6/6 contratos estructurales fijados |
| `latency` | `null` | `requires-provider-call`, gate **G1** |
| `token-usage` | `null` | `requires-provider-usage-metadata`, gate **G1** |
| `estimated-provider-cost` | `null` | `requires-token-usage-and-calibration`, gate **G9** |

**Cada `null` lleva razón estructurada** — código, gate y una frase — y el
harness lanza si una métrica es `null` sin razón, o si lleva valor **y** razón
a la vez. Un `null` desnudo es indistinguible de cero en un log y de «no
calculado» en un reporte.

### Latencia: por qué sigue en `null` habiendo una medición local

La Fase 3 pide latencia «cuando sea medible localmente». Se mide y se emite,
pero **fuera del bloque determinista** y con otro nombre:
`observation (non-deterministic): harnessWallClockMs=…`. No se reporta como
`latency` por dos razones, y conviene que queden escritas:

1. **No mide a Stella.** El harness hace cero llamadas a proveedor. Ese
   número es el costo de transformar y ejecutar módulos en la máquina que corrió
   la suite; publicarlo como `latency` invitaría a compararlo con un
   presupuesto p50/p95 que describe otra cosa por completo.
2. **Rompería el determinismo** que la Fase 4 exige de la salida estructurada.

`latency` como métrica de release sigue significando ida y vuelta real al
proveedor, y eso sigue siendo G1. **Es una decisión de esta unidad, no una
omisión** — si integración prefiere que el reloj local no se emita en absoluto,
es un cambio de una línea en el script.

## Salida y fallo

La salida estructurada (`[eval:release] json …`, una sola línea) incluye
**versión** (harness, matriz, fixtures), y por cada check **`checkId`**,
**`fixtureId`**, **`result`**, **`outcome`** y sus controles negativos con
veredicto; más el bloque completo de métricas con sus razones de nulidad y los
totales. Es **determinista**: dos procesos distintos producen la línea
byte-idéntica, y eso está probado, no afirmado.

`releaseEvalFailureReasons()` vive en el harness y no en el script,
precisamente para que «el proceso falla ante un aislamiento» sea demostrable
contra un resumen sintético en vez de requerir una fuga real. **Todas** las
razones aplicables se reportan, no sólo la primera: una corrida que fuga entre
tenants **y** fabrica una cita debe decir las dos cosas, porque colapsarlas es
cómo la segunda se arregla un release más tarde.

El proceso sale distinto de cero ante: cualquier check en rojo, **cualquier
check tautológico**, cualquier control negativo no detectado, **cualquier
violación de aislamiento**, **cualquier fallo de validación de citación**,
cualquier `system-error`, y cualquier llamada a proveedor.

`system-error` y `abstention-response` siguen siendo `outcome` distintos, y
ahora el clasificador que los separa (`classifyRejection`) tiene su propio
control negativo.

## Fixtures para el tren 2 integrado

Construidas **sólo** contra el barrel publicado `lib/grounding/contracts`
(la superficie que §7.1 declara como contrato de GROUNDING). No se importa
`lib/grounding/ingest/**` ni código de ninguna rama que no esté ya en la raíz
compartida.

- **project-scope enforcement** — tres scopes (`alphaProjectOne`,
  `alphaProjectTwo`, `betaProjectOne`, más `alphaOrgWide`) y chunks reales en
  cada uno. El caso que importa es el proyecto **hermano de la misma
  organización**: una comparación por organización no puede distinguirlo.
- **provenance canónica** — los chunks se construyen con hashes reales
  (`hashContent`, `deriveChunkId`, `lineRangeForSpan`), así que la cadena de
  verificación **cierra**: el texto re-hashea a `contentHash` y el `chunkId`
  se re-deriva. Una cita a ellos puede falsificarse como describe `chunks.ts`,
  que es el motivo de no usar hex escrito a mano.
- **score numérico** — `RetrievalResult` con puntajes literales (deterministas),
  ranking monótono y ambos contadores de descarte poblados, más sus mutaciones:
  ranking invertido, candidato bajo umbral admitido, y `NaN`.
- **contradiction marker** — `ContradictionMarker` con ambos lados anclados y
  `resolution: 'requires_human_resolution'`, frente a la respuesta que ignora la
  contradicción y la presenta como hecho.
- **adaptador de PRODUCT** — se mide **completitud de la entrada**, no el
  adaptador: `components/stella/grounding-adapter.ts` no existe
  (INTEGRATION-001 sigue `solicitado`, propietaria PRODUCT). RELEASE no lo
  implementa ni importa nada de otra línea; fija el criterio de aceptación que
  ese adaptador tendrá que cumplir cuando PRODUCT lo escriba.

### A-F1 queda registrado, no parcheado

`validateAnswerCitations` compara **sólo** `organizationId`, y su mapa
`availableChunks` ni siquiera puede llevar `projectId`. El check
`grounding-project-scope-enforced` **no depende de esa función**: mide la
propiedad con `scopeContains`, que GROUNDING sí publica y que sí compara
proyecto. El harness deja constancia en su propio `detail` de que la función
del contrato sigue sin ver el caso proyecto-hermano. **Corregirla es de
GROUNDING** (§ Rutas prohibidas: RELEASE consume contratos funcionales, no los
modifica); el criterio medible ya está puesto y seguirá sosteniéndose cuando
A-F1 se cierre.

## Pruebas ejecutadas

Sólo focalizadas, sin `test:unit` completo, sin `build`, sin gates pesados
(§11). Sin red, sin BD, sin secretos reales.

| Comando | Resultado |
|---|---|
| `pnpm exec tsc --noEmit` | limpio, 0 errores |
| `pnpm exec eslint tests/eval/stella-release scripts/eval-release-offline.ts` | **0 errores, 0 warnings** |
| `pnpm exec vitest run tests/eval/stella-release` | **3 archivos, 77 tests passed** (`harness` 62, `command` 10, `wiring` 5) |
| `pnpm test:stella:release-eval` | `19/19 checks`, `pass=15 abstention=4 system-error=0 isolation-violation=0`, 37 controles negativos todos detectando, 0 `providerCalls` |
| Mutación adversarial ×2 (revertidas) | `EXIT 1` en ambas — ver §Verificación de extremo a extremo |

### La prueba del comando oficial

[`tests/eval/stella-release/command.test.ts`](../../../tests/eval/stella-release/command.test.ts)
**ejecuta** `pnpm test:stella:release-eval` como subproceso y comprueba código
de salida, versiones, `fixtureId` por check, distinción abstención/error de
sistema, controles negativos, razones estructuradas de nulidad, cero llamadas a
proveedor y **determinismo entre dos procesos distintos**.

`wiring.test.ts` ya fijaba la cadena de `package.json`; eso es otra cosa. Una
entrada de script puede apuntar a un archivo que existe, parsear bien, y aun
así salir distinto de cero, no imprimir nada estructurado o variar entre
corridas — nada de eso se ve desde el manifiesto.

**`package.json` no fue modificado.** El comando ya existía desde la unidad de
preparación de raíz del tren 2. Si `pnpm` no estuviera en el `PATH`, la prueba
**falla**, no se salta: una prueba de extremo a extremo silenciosamente omitida
declara una cobertura que no está dando. Cuesta ~12 s (dos procesos); es el
único test de esta línea que arranca un subproceso.

## Riesgos abiertos de esta línea

- **B-M3 sigue abierto y está bloqueado fuera de esta línea.** El harness
  importa `@/components/stella/error-messages` (interno de PRODUCT) porque
  `components/stella/index.ts` **no exporta** `stellaErrorPresentation` ni
  `StellaPanelErrorCode` — verificado en este árbol, no supuesto. RELEASE no
  puede editar el barrel (propiedad de PRODUCT). **Acción pendiente: abrir fila
  de contrato a PRODUCT.** No se abrió en esta unidad porque la Fase 7 de la
  instrucción limita las escrituras de documentación a este archivo; es la
  primera acción de la próxima unidad de RELEASE, o de integración si prefiere
  resolverlo antes.
- **`command.test.ts` corre bajo `pnpm test:unit`** y arranca un subproceso.
  Bajo la batería completa compite por CPU con el resto; lleva `timeout` de
  180 s por eso, y **no se aumentó ningún timeout global**. Si integración
  prefiere sacarlo de la batería por disciplina de recursos (§11), moverlo a un
  glob aparte es decisión suya: la ruta es `INTEGRATION-OWNED`.
- **El aislamiento sigue siendo de capa de aplicación y de contrato, nunca
  RLS.** Ni los 3 checks de contexto ni `grounding-project-scope-enforced`
  sustituyen `tests/integration/rls.test.ts` ni el gate G3. Está declarado en
  la matriz para que nadie lo lea como cobertura de RLS.
- **Sin baseline de latencia ni de costo.** Siguen requiriendo G1 (y G9 para
  calibración). Esta unidad **no fijó ningún umbral final**, y los presupuestos
  p50/p95 de §Staging siguen sin definir por la misma razón que en el tren 1.
- **`grounding-retrieval-score-ordering` mide invariantes sobre puntajes de
  fixture**, no sobre un motor de retrieval — no existe uno. El criterio está
  puesto antes que la implementación a propósito, para que no se escriba
  después para encajar con ella.

## Estado de entrega a integración

Dos commits, árbol limpio, ninguna ruta `INTEGRATION-OWNED` ni de otra línea
modificada, sin push, sin acceso a remoto, sin gates pesados, cero escrituras a
base de datos, cero llamadas a proveedor.

`STELLA_RELEASE_TRAIN_2_READY_FOR_INTEGRATION`

---

## Estado en el HEAD integrado del tren 2 (integración, 2026-08-04)

Sección añadida por **integración**, no por esta línea. No reescribe nada de lo
anterior: registra qué de lo que esta línea declaró queda confirmado sobre el
árbol fusionado, y qué cambió al cruzarlo con las otras tres.

**Hallazgos:** B-M3 → **CLOSED**, B-M4 → **CLOSED**, B-M5 → **CLOSED**,
B-M6 → **CLOSED**, A-F10 → **CLOSED**, B-m5 → **CLOSED** (la fila de
`package.json` la cerró la preparación de raíz del tren 2).

**Esta línea se rompió en el merge, y la rotura era la correcta.**

`harness.test.ts` lanzaba `Cannot read properties of undefined (reading
'organizationId')`. Causa: `AVAILABLE_CHUNKS` se construía a mano contra la
firma pre-merge `{ contentHash, organizationId }`, y GROUNDING la sustituyó por
`CitableChunkRecord` con **scope completo** — el cierre de A-F1. El harness
compilaba en este worktree porque el contrato viejo era el único que veía.

La lección es estrecha y vale la pena enunciarla: **un harness de evaluación que
re-declara la forma que está juzgando no puede detectar que la forma se movió.**
Reconciliado proyectando con `toCitableChunkRecord`; copiar los campos a mano
—incluso los nuevos— habría compilado y reproducido el bug viejo en un sitio
nuevo.

**Un hallazgo cerrado seguía afirmado como abierto.** El check
`grounding-project-scope-enforced` llevaba A-F1 codificado como nota al pie
dentro de una aserción viva («validateAnswerCitations alone still misses the
sibling-project case»). Eso ya no era cierto, y mantenerlo no es conservadurismo
inocuo: un lector de la salida del eval seguiría tratando al validador de
GROUNDING como incapaz de ver el alcance de proyecto, y seguiría construyendo la
capa compensatoria que este check solía ser.

Convertido en **aserción**, y en la dirección estricta: si
`validateAnswerCitations` deja de reportar `citation_out_of_scope`, el check
falla como `isolation-violation`. `evaluateProjectScopeEnforcement` se conserva
igualmente, midiendo la misma propiedad desde el otro lado — dos caminos
independientes a «¿puede leerse esto?» es el número correcto cuando la respuesta
es una frontera de aislamiento.

**Una afirmación obsoleta más, corregida:** `matrix.ts` y `harness.ts` decían que
`components/stella/grounding-adapter.ts` «no existe». Existe desde el merge de
PRODUCT. El **alcance** del check sigue siendo correcto —mide la ENTRADA, no el
adaptador— y se conserva por eso, no por la ausencia del adaptador.

**B-M3 — cerrado, y la ruta de import se queda donde está.** Los exports existen
(`components/stella/index.ts:66-67`). Pero medido 3× cada variante, consumir el
barrel lleva el eval de **6.2 s a 11.7 s (+90 %)**, porque arrastra ~15 paneles
React a un script Node offline que necesita un solo mapa. Cerrar el hallazgo no
obliga a aceptar el coste que su remedio literal implicaba; el import directo es
ahora una elección con evidencia, no un rodeo por un export que faltaba.

**`command.test.ts` — se mantiene en `test:unit`, y es INTEGRATION-OWNED.**
Medido: **~15.9 s**, 10 casos, 2 subprocesos. **No hay recursión** — lanza
`tsx scripts/eval-release-offline.ts`, no `vitest`. **No duplica una batería** —
`harness.test.ts` mide los checks a nivel de módulo; esto mide el comando
empaquetado (exit code, salida estructurada, determinismo entre procesos), que
ningún test de módulo puede observar. Excluirlo exigiría un glob en
`vitest.shared.ts`, y este mismo harness tiene un control negativo
(`nc-cap-regression-test-excluded`) que existe porque los globs de exclusión se
tragan pruebas de regresión en silencio.

**Verificado en el árbol integrado:** 19/19 checks, 37 controles negativos con
**0 no detectados**, `tautologicalChecks: []`, `structural-regression` emitida
con `value: 1`, tres métricas `null` **con `code` y `gate`** (G1/G1/G9), salida
byte-idéntica entre procesos, wall-clock fuera del bloque determinista,
`providerCalls: 0`.

---

# Tren 3 — `STELLA_RELEASE_RUNTIME_GATE_FOUNDATION_TRAIN_3`

**HEAD base:** `4d59348` (`chore(integration): reconcile Stella train 2
contracts`). Árbol limpio al abrir y al cerrar. Sin push, sin acceso a
remoto, sin llamadas a proveedor, sin gates pesados, sin tocar `db/**`,
`supabase/**`, contratos funcionales ni ninguna ruta `INTEGRATION-OWNED`.

**Alcance:** cerrar el único tramo del recorrido runtime que la matriz del
tren 2 no medía — la **decisión humana** sobre una sugerencia
(aceptar/rechazar/deshacer) y sus dos modos de fallo (bandera apagada, error
de persistencia) — y, sobre esa matriz ampliada, definir los 11 gates locales
de la Fase 3, el contrato mínimo de observabilidad de la Fase 4, y el harness
de release-gate local de la Fase 5.

## Por qué exactamente 5 checks nuevos, y no más

El recorrido pedido es evidencia → ingestion → version → chunks → retrieval →
grounded answer → citations → decisión humana. Los ocho pasos hasta
"citations" ya estaban cubiertos por los 19 checks del tren 2 (contrato de
`lib/grounding/contracts`, aislamiento, provenance, score, contradicción,
adaptador de PRODUCT). El único tramo sin check era el último: nada en la
matriz medía qué pasa cuando un humano decide sobre una sugerencia de Stella.

Ese tramo SÍ tiene contrato real y versionado —
[`app/actions/stella/decisions.ts`](../../../app/actions/stella/decisions.ts) +
[`decisions-schema.ts`](../../../app/actions/stella/decisions-schema.ts),
código de fundación pre-reparto paralelo, fuera de las rutas prohibidas de
RELEASE (no es SQL, no es contrato de otra línea, no es UI de Composer)— así
que los 5 checks se construyeron contra él, nunca contra una base simulada:

| Caso pedido | `checkId` | Categoría |
|---|---|---|
| feature flag off | `stella-decision-feature-flag-blocks-persistence` | `feature-flag-desactivada` |
| decisión aceptada | `stella-decision-accepted-contract-valid` | `decision-aceptada` |
| decisión rechazada | `stella-decision-rejected-contract-valid` | `decision-rechazada` |
| rollback de decisión | `stella-decision-rollback-append-only` | `decision-rollback` |
| error de persistencia | `stella-decision-persistence-error-non-leaking` | `error-persistencia-decision` |

**"Evidencia parcial" y "abstención"** del enunciado no generaron una sexta
entrada: ya son exactamente `insufficient-evidence-empty-sentinel` +
`abstention-schema-enforced` del tren 1/2 — escribir una categoría paralela
habría medido la misma propiedad dos veces con nombres distintos.

## Ninguno de los 5 ejecuta `recordStellaDecision`

`recordStellaDecision` es una **server action async con I/O real** (auth,
Postgres). El harness completo —24 checks, `CHECKS: Record<string, () =>
ReleaseCaseResult>`— es deliberadamente **síncrono**: `runReleaseEvalHarness`
mapea la matriz con `.map()`, no con `Promise.all`. Convertirlo a async para
ejecutar la función real habría tocado los 5 puntos de llamada de
`harness.test.ts`/`scripts/eval-release-offline.ts` que ya estaban en verde
desde el tren 1, y — más importante — habría requerido mockear auth/DB para
que la ejecución no fallara por falta de sesión real, exactamente el tipo de
recreación que este documento lleva dos trenes evitando.

En vez de eso, cada uno de los 5 checks es **o bien una llamada real a
esquema/config síncrona, o bien inspección ESTRUCTURAL de código fuente
(lectura, nunca ejecución)** — la misma disciplina que
`cap-01-05-regression-surface-present` ya aplicaba desde el tren 1:

- **`stella-decision-feature-flag-blocks-persistence`** — lee
  `stellaConfig.isDecisionsPersistenceEnabled` (booleano real, computado en
  runtime desde `process.env`, no recreado) y confirma que es `false`; falla
  cerrado si el entorno lo contaminó a `true` en vez de asumir el default.
  Además confirma por inspección de texto que el gate de la bandera es
  textualmente el **primero** en `recordStellaDecision`, antes de
  `StellaDecisionInputSchema.safeParse` y antes de `requireOrganizationAccess`.
- **`stella-decision-accepted-contract-valid`** /
  **`-rejected-contract-valid`** / **`-rollback-append-only`** — llaman al
  `StellaDecisionInputSchema.safeParse` REAL (no recreado) contra los 4
  valores documentados (`accepted`, `accepted_edited`, `rejected`, `undone`).
  El caso de rollback es el más estricto: el esquema real es `.strict()` y no
  lleva ningún campo (`id`/`decisionId`) capaz de señalar una fila existente
  para mutarla — el control negativo confirma que un `decisionId` inyectado
  por el cliente es rechazado, así que "append-only" es una propiedad del
  contrato, no un comentario en el código.
- **`stella-decision-persistence-error-non-leaking`** — lee el código fuente
  de `decisions.ts` (normalizado a LF antes de comparar: este worktree lo
  checkea en CRLF) y confirma tres invariantes de no-fuga: el retorno
  `DB_ERROR` es un literal fijo (nunca interpola el error capturado), el log
  de servidor imprime sólo `error.name`, y `logStellaAudit` atrapa su propio
  fallo sin relanzar — un audit_logs caído nunca cambia lo que ve el usuario.

**Consecuencia declarada, no oculta:** ninguno de los 5 prueba que la tabla
`stella_suggestion_decisions` funcione una vez habilitada. Esa tabla existe
sólo como SQL preparado
(`db/prepared/stella_0003_suggestion_decisions.sql`) — aplicarla es gate G2,
propiedad de CAPABILITIES, y esta unidad no la toca ni la simula.

## Matriz de evaluación — v3.0.0

`RELEASE_EVAL_MATRIX_VERSION = '3.0.0'`, `RELEASE_FIXTURES_VERSION = '3.0.0'`,
`RELEASE_HARNESS_VERSION = '3.0.0'`. **24 entradas** (19 del tren 2 sin
cambio de `checkId` ni de categoría + 5 nuevas). Las 5 nuevas alimentan
`structural-regression` — igual que `human-decision-literal-true` y
`retryable-code-set-pinned` ya hacían: fijan un contrato, no una decisión de
abstención.

```bash
pnpm test:stella:release-eval
```

`24/24 checks passed` · `pass=19 abstention=5 system-error=0
isolation-violation=0` · `offline coverage: 23 fully measurable, 1
offline-limited` (sin cambio: sigue siendo sólo `contradiction-acknowledgment-heuristic`)
· `negative controls: 45 run, 0 undetected` (37 del tren 2 + 8 nuevos: 2+2+1+1+2
por los 5 checks nuevos) · `providerCalls=0`.

`structural-regression` sube de `1` (6/6) a `1` (**11/11**) — los 5 contratos
de decisión se suman a los 6 ya fijados sin bajar la proporción.

## Fase 3 — 11 gates locales

Nuevo módulo
[`tests/eval/stella-release/local-release-gate.ts`](../../../tests/eval/stella-release/local-release-gate.ts).
Cada gate lee el `ReleaseEvalSummary`/`results` del harness — ninguno
reimplementa una propiedad que el harness ya mide, todos la **reducen** a un
booleano con detalle:

| Gate | Fuente |
|---|---|
| `contract-complete` | `totalChecks === results.length`, `failed === 0`, `tautologicalChecks.length === 0` |
| `isolation` | `isolationViolations === 0` |
| `citation-validity` | `citationValidationFailures === 0` |
| `unsupported-claims` | métrica `unsupported-claim-rate === 0` |
| `abstention-correctness` | métrica `abstention-correctness === 1` |
| `contradiction-attribution` | `contradiction-acknowledgment-heuristic` + `grounding-contradiction-marked` en verde |
| `feature-flag-safety` | `stella-decision-feature-flag-blocks-persistence` en verde |
| `decision-provenance` | los 4 checks de decisión (accepted/rejected/rollback/persistence-error) en verde |
| `no-provider-calls` | `providerCalls === 0` |
| `no-secrets` | `provider-unavailable-presentation` + `stella-decision-persistence-error-non-leaking` en verde |
| `determinism` | dos corridas independientes del harness producen resumen y resultados byte-idénticos |

`determinism` es el único gate que `releaseEvalFailureReasons` (tren 2) no
podía ver — necesita una SEGUNDA corrida para comparar, y una función que
recibe un solo `ReleaseEvalSummary` no tiene con qué. `scripts/eval-release-offline.ts`
ahora corre el harness dos veces (~30 ms cada una) y lo añade como razón de
fallo explícita, separada de `releaseEvalFailureReasons`.

**Resultado de referencia:** los 11 gates en verde sobre el árbol de esta
unidad — ver la corrida citada arriba.

## Fase 5 — release gate local: 5 niveles de disponibilidad

`computeLocalReleaseGateReport()` reduce los 11 gates a una jerarquía
estricta, no a un booleano plano:

- **`library-ready`** — `contract-complete` en verde, cero controles
  negativos no detectados, cero checks tautológicos. Es la condición mínima:
  el harness es honesto consigo mismo.
- **`integration-ready`** — `library-ready` **y** `no-provider-calls` **y**
  `determinism`. Corresponde a los gates obligatorios de "Local integration"
  ya definidos en el tren 1 (`pnpm typecheck`, `test:unit`,
  `test:stella:release-eval`).
- **`local-runtime-ready`** — `integration-ready` **y** los 11 gates en
  verde. El recorrido completo (evidencia → ingestion/version/chunks →
  retrieval → grounded answer → citations → decisión humana) queda verificado
  contra todo lo que este harness puede ver sin base de datos ni proveedor.
- **`staging-blocked`** — **siempre `true`**. No existe combinación de
  entradas que lo vuelva `false`: `STELLA_DECISIONS_PERSISTENCE_ENABLED` es
  `false` en todo entorno que este harness pueda observar, y la tabla de
  decisiones no fue aplicada a ninguna base desde este worktree. La única
  forma real de cambiarlo es correr el gate G2 de verdad, fuera de este
  harness.
- **`hosted-blocked`** — **siempre `true`**, por las mismas razones más G1,
  G4, G7 y los 4 riesgos abiertos de la sección de hosted más abajo.

**`missingForStaging`** y **`missingForHosted`** listan la evidencia exacta
que falta (nunca un "bloqueado" desnudo) — ver la corrida de referencia en
§Pruebas ejecutadas. `missingForHosted` es superset aditivo de
`missingForStaging`, probado en
[`local-release-gate.test.ts`](../../../tests/eval/stella-release/local-release-gate.test.ts).

**Resultado de referencia sobre esta unidad:** `library-ready=true
integration-ready=true local-runtime-ready=true staging-blocked=true
hosted-blocked=true`.

## Fase 4 — contrato mínimo de observabilidad

Nuevo módulo
[`tests/eval/stella-release/observability-contract.ts`](../../../tests/eval/stella-release/observability-contract.ts).
**Contrato, no implementación** — ningún evento se emite de verdad; nada aquí
se conecta a un logger o exportador real.

**13 eventos** (`STELLA_OBSERVABILITY_EVENT_NAMES`), exactamente los pedidos:
`ingestion.started/completed/failed`, `retrieval.started/completed/abstained`,
`citations.validated/rejected`, `response.produced`,
`human_decision.recorded`, `retry.attempted`, `quota.rejected`,
`permission.rejected`.

**Exclusiones — por allowlist, no por denylist.** Cada evento declara los
campos que SÍ puede llevar (`EVENT_SPECIFIC_ALLOWED_FIELDS`); cualquier campo
fuera de esa lista se rechaza, aunque el nombre parezca inofensivo. Además,
tres guardas independientes de la allowlist, para que un campo permitido no
se convierta en fuga por otra vía:

1. **Lista permanente de nombres prohibidos** (`prompt`, `systemPrompt`,
   `fullText`, `evidenceText`, `apiKey`, `secret`, `authToken`, …) — gana
   sobre cualquier allowlist futura que los incluya por error.
2. **Tope de longitud** (`MAX_EVENT_FIELD_VALUE_LENGTH = 200`) — un prompt o
   un texto de evidencia completo excede esto por construcción; un
   identificador o código no.
3. **Detector de secretos compartido** — reutiliza `hasForbiddenPattern` de
   `lib/stella/context/sanitize.ts` (el mismo que ya usa
   `provider-unavailable-presentation`), en vez de reimplementarlo — los dos
   contratos no pueden divergir silenciosamente.

**Métricas — 7 dimensiones separadas** (`STELLA_OBSERVABILITY_METRIC_CATEGORIES`):
latencia, uso de tokens, costo, aislamiento, unsupported claims, abstención,
errores. Las 3 dependientes de proveedor (latencia, tokens, costo) — mismo
principio que `PROVIDER_DEPENDENT_METRICS` en `matrix.ts`, declarado aparte a
propósito para que un cambio en un contrato no mueva el otro en silencio — se
fuerzan `measurable:false, value:null` con razón estructurada vía
`assertProviderDependentMetricsAreNull`, que además rechaza un `null` sin
razón y un valor con razón simultáneamente.

`isValidObservedDecisionValue` pinea el campo `decision` de
`human_decision.recorded` contra `STELLA_DECISION_VALUES`, el enum real de
`decisions-schema.ts` — no una recreación de los 4 valores.

## Pruebas ejecutadas

Sólo focalizadas, sin `test:unit` completo, sin `build`, sin gates pesados
(§11 del documento de gobernanza). Sin red, sin BD, sin secretos reales.

| Comando | Resultado |
|---|---|
| `pnpm exec tsc --noEmit` | limpio, 0 errores |
| `pnpm exec eslint tests/eval/stella-release scripts/eval-release-offline.ts` | **0 errores, 0 warnings** |
| `pnpm exec vitest run tests/eval/stella-release` | **5 archivos, 118 tests passed** (`harness` 67, `command` 10, `wiring` 5, `observability-contract` 19, `local-release-gate` 17) |
| `pnpm exec tsx scripts/eval-release-offline.ts` | `24/24 checks`, `pass=19 abstention=5 system-error=0 isolation-violation=0`, 45 controles negativos todos detectando, 11/11 gates locales en verde, `library-ready=true integration-ready=true local-runtime-ready=true staging-blocked=true hosted-blocked=true`, 0 `providerCalls` |

No se ejecutó `pnpm test:unit` completo, `pnpm build`, `test:integration` ni
`test:rls` — fuera del alcance "sin gates pesados" de esta unidad (Fase 6 de
la instrucción de origen los prohíbe explícitamente).

## Riesgos abiertos de esta línea

- **Los 5 checks nuevos son estructurales/contractuales, no de ejecución.**
  Ninguno demuestra que `recordStellaDecision` funcione end-to-end contra una
  base real, ni que la tabla `stella_suggestion_decisions` acepte las
  escrituras que el código espera — eso requiere gate G2 aplicado y una base
  levantada, ambos fuera de alcance. Declarado arriba, no oculto.
- **`stella-decision-persistence-error-non-leaking` compara contra literales
  de texto exactos** (mensaje `DB_ERROR`, línea de `console.error`, bloque
  `catch` de `logStellaAudit`). Un refactor de `decisions.ts` que preserve el
  comportamiento pero cambie la redacción exacta de esas líneas haría fallar
  el check por `system-error` — no porque la propiedad de no-fuga se haya
  roto, sino porque el marcador textual se movió. Es el mismo trade-off que
  `cap-01-05-regression-surface-present` ya acepta desde el tren 1
  (comparación de marcador, no un parser AST) — mantenido por consistencia,
  no por descuido.
- **`missingForStaging`/`missingForHosted` son listas de hechos verificados
  contra el árbol actual, no una proyección.** Si CAPABILITIES aplica G2 en un
  tren futuro, esta lista queda obsoleta de inmediato y debe regenerarse, no
  editarse a mano — es exactamente la corrida (`pnpm test:stella:release-eval`)
  la que la recalcula, nunca este documento.
- **El determinismo del gate de release depende de que `Date.now()`/timers no
  entren en la ruta determinista.** Ya era cierto desde el tren 2
  (`harnessWallClockMs` vive fuera de `summary`); esta unidad no añadió
  ninguna fuente de no-determinismo nueva — los 5 checks nuevos son puros
  (mismo input, mismo output).
- **`hasForbiddenPattern` es un detector heurístico**, no una prueba
  formal de ausencia de secretos — comparte la misma limitación que ya tenía
  declarada en `provider-unavailable-presentation` desde el tren 1/2. El
  contrato de observabilidad lo reutiliza tal cual, a propósito: dos
  implementaciones divergentes serían peor que una heurística compartida.

## Estado de entrega a integración

Dos commits, árbol limpio, ninguna ruta `INTEGRATION-OWNED` ni de otra línea
modificada, sin push, sin acceso a remoto, sin gates pesados, cero escrituras
a base de datos, cero llamadas a proveedor.

`STELLA_RELEASE_TRAIN_3_READY_FOR_INTEGRATION`

## Integración — tren 3 (2026-08-05)

`4d59348..8eaf760`, merge `--no-ff`. Dos commits declarados, nada más.

### Conteos, derivados y no asumidos

| Magnitud | Valor derivado |
|---|---|
| Versión de matriz runtime | `3.0.0` |
| Checks | **24** |
| Controles negativos ejecutados | **45** (0 no detectados) |
| Checks tautológicos | 0 |
| Eventos de observabilidad | **13** |
| Gates locales | **12** (11 de Fase 3 + `runtime-entrypoint`) |
| Llamadas a proveedor | **0** |

Los seis primeros se leen del propio arnés (`runReleaseEvalHarness`,
`RELEASE_EVAL_MATRIX`, `STELLA_OBSERVABILITY_EVENT_NAMES`), no de esta tabla.

### Verificado

- allowlist de campos por evento + lista prohibida + detector de secretos;
- cero prompts completos, cero evidencia completa, cero texto privado completo;
- tokens y coste `null` **con razón estructurada** (`nullReason`), nunca un
  `null` pelado — el arnés hace cero llamadas a proveedor;
- salida determinista: dos corridas independientes producen `summary` y
  `results` byte a byte idénticos (el reloj de pared vive fuera de `summary`).

### `local-runtime-ready` NO se conservó automáticamente

**Degradado a `integration-ready=true` / `local-runtime-ready=false`.**

Las once gates de Fase 3 leen la salida del propio arnés sobre sus propios
fixtures. Las once estuvieron **verdes durante todo el tren 2**, cuando no
existía ningún server action y `components/stella/` tenía cero call sites — es
decir, un conjunto de gates que no distinguía una biblioteca de un sistema en
marcha. Integración añadió una **duodécima**, `runtime-entrypoint`, que hace
una pregunta que los fixtures no pueden responder: ¿existe la costura en
disco, de extremo a extremo?

`runtime-entrypoint` **pasa**: los cinco módulos existen (contrato de cliente,
panel, server action, adaptador de repositorio, wrapper). Pero **existencia no
es alcanzabilidad**, y `computeLocalReleaseGateReport` ahora separa las dos.
`missingForLocalRuntime` enumera lo que falta, nunca un booleano pelado:

1. ninguna `page.tsx` bajo `app/` renderiza `StellaGroundedQuerySection` —
   PRODUCT-002 es `IMPLEMENTED_UNMOUNTED_PENDING_CANONICAL_SURFACE`;
2. `grounding_0002` + `grounding_0003` existen como SQL preparado y **no están
   aplicados a ninguna base**; hasta que lo estén, toda consulta fundamentada
   devuelve `provider_unavailable`;
3. no existe generador de respuestas fundamentadas: el proveedor inyectado
   **rechaza** por contrato, así que la costura se ejercita completa pero no
   produce borrador — eso es el gate G1.

`missingForStaging` es ahora un superconjunto de `missingForLocalRuntime`, y
`missingForHosted` de aquél.

### Staging y hosted siguen bloqueados

Sin cambios: `stagingBlocked` y `hostedBlocked` son literalmente `true` en el
tipo. Este módulo es **estructuralmente incapaz** de concederlos. Se añadió a
la lista de staging que `STELLA_GROUNDED_QUERY_ENABLED` debe llegar allí en
`false`.

### Pruebas ajustadas, no debilitadas

Tres aserciones propiedad de RELEASE codificaban el supuesto que este tren
tenía instrucción de romper. Se **actualizaron con su razón**, no se borraron
ni se saltaron:

- «tiene exactamente 11 gates» → 12, con los doce enumerados por nombre;
- «es local-runtime-ready sobre la matriz limpia» → afirma la degradación y
  **exige que se diga por qué**;
- «staging/hosted siguen bloqueados» → ahora también comprueba que las doce
  gates pasan **y aun así** `localRuntimeReady` es `false`, que es la propiedad
  interesante.

# Tren 4 — `STELLA_RELEASE_LOCAL_END_TO_END_GATE_TRAIN_4`

**HEAD base:** `6f3c543` (`chore(integration): reconcile Stella train 3
runtime`). Árbol limpio al abrir. Sin push, sin acceso a remoto, sin llamadas
a proveedor, sin gates pesados, sin tocar `db/**`, `supabase/**`, contratos
funcionales ni ninguna ruta `INTEGRATION-OWNED`. Se usó el stack Docker local
(disponible en este entorno) para contenedores **desechables** — nunca el
stack Supabase persistente que ya corría en la máquina para otro proyecto.

**Alcance:** construir el arnés ejecutable que integración usará para
demostrar `evidencia real → extracción → versión → chunks persistidos →
retrieval SQL → generación extractiva → citas → resultado de Product →
decisión humana local`, contra una base Postgres **desechable, sin red, sin
volumen persistente**, distinguiendo `local-runtime-harness-ready` (¿el
arnés desechable demuestra la capa de persistencia/retrieval de verdad?) de
`local-runtime-ready` (¿un humano puede alcanzarlo en la aplicación
desplegada?) — la primera es alcanzable desde esta línea, la segunda sigue
bloqueada por ramas paralelas (PRODUCT-002 sin montar, INT-CAP-001 abierto,
gate G1).

## Qué se construyó

- **Fixture real** (Fase 2) —
  [`tests/eval/stella-release/fixtures/e2e/documents/`](../../../tests/eval/stella-release/fixtures/e2e/documents/):
  dos documentos `text/plain` reales sobre el mismo proyecto ficticio (Río
  Verde), cada uno con una afirmación numérica verificable (saplings
  plantados) y una **contradicción controlada** (1.240 vs. 1.180) más un
  hecho no contradictorio (riego). El resultado NUNCA se preconstruye: emerge
  de `ingestDocument()` real sobre estos bytes.
- **Generador extractivo local** (no proveedor, no LLM) —
  [`tests/eval/stella-release/e2e/local-extractive-generator.ts`](../../../tests/eval/stella-release/e2e/local-extractive-generator.ts):
  extrae la afirmación por patrón sobre texto YA recuperado, construye
  citas con `quotedTextHash` leído del propio chunk (nunca recalculado sobre
  una paráfrasis), marca contradicción con `ContradictionClaimAttribution`
  por lado. Probado offline (5 tests) contra la `validateAnswerCitations`
  real.
- **Constructor de SQL de ingesta real** —
  [`build-ingestion-sql.ts`](../../../tests/eval/stella-release/e2e/build-ingestion-sql.ts):
  corre `ingestDocument()` de verdad y emite el SQL de siembra
  (`organizations/users/organization_members/projects/evidence_items`) y de
  ingesta (`register_document_version → insert_evidence_chunks →
  finalize_document_ingestion`, encadenado por `\gset` de psql) — nunca
  construye un chunk a mano.
- **Reporte y gate fail-closed** —
  [`tests/eval/stella-release/harness-report.ts`](../../../tests/eval/stella-release/harness-report.ts):
  tipo `LocalRuntimeHarnessReport` + `evaluateLocalRuntimeHarnessReadiness`,
  con **20 campos verificables independientemente** (red del contenedor,
  destrucción, volumen, método de verificación, paquetes aplicados,
  pipeline real, funciones SQL invocadas, aislamiento cross-project,
  idempotencia, tipo de generador, validación de citas, contradicción,
  abstención, cuota, scope autenticado, estado de la bandera, llamadas a
  proveedor, sanidad de observabilidad, fila de decisión, bandera de
  persistencia de decisiones). **24 controles negativos** (Fase 6): la buena
  corrida pasa, cada mutación individual —fixture como runtime, DB omitida,
  SQL no aplicado, cuota reclamada falsamente, scope no comprobado, cita
  inventada, resultado no derivado de retrieval, generador mock, bandera
  global, llamada a proveedor, evento con violación, contenedor no
  destruido, red distinta de `none`, volumen persistente, verificación
  "sólo archivos", fila de decisión persistida, bandera de decisiones
  encendida, cada función SQL requerida ausente una por una, reaplicación no
  idempotente, contradicción no atribuida, abstención no observada, scope no
  atestiguado— se rechaza con una razón específica.
- **`localRuntimeHarnessReady`** añadido a
  [`local-release-gate.ts`](../../../tests/eval/stella-release/local-release-gate.ts)
  como decimotercera salida, **opcional y externa**: el módulo sigue sin
  abrir una conexión SQL él mismo (mismo compromiso desde el tren 3); recibe
  un `LocalRuntimeHarnessReport` ya calculado y lo reduce. Sin reporte
  (el caso de todo `pnpm test:stella:release-eval` en CI), `false` con razón
  explícita. **Deliberadamente independiente de `localRuntimeReady`** — ver
  el comentario del campo.
- **Orquestador del recorrido** —
  [`run-local-journey.ts`](../../../tests/eval/stella-release/e2e/run-local-journey.ts):
  siembra + ingiere dos veces (idempotencia) vía `docker exec psql`, bajo una
  sesión real autenticada (`request.jwt.claims` vía `set_config`, el mismo
  mecanismo de `db/identity-context.ts`), recupera con
  `uellix_grounding.chunks_in_scope` real para el proyecto correcto y para un
  proyecto señuelo del mismo org (aislamiento), genera con el extractor
  local, valida citas con `validateAnswerCitations` real, adapta el
  resultado con `adaptGroundedAnswer`/`presentationInputFromRetrieval`
  reales (vista de Product), confirma que `stella_interactions_stella_role_check`
  sigue sin admitir `grounded_query` (INT-CAP-001), confirma fila 0 en
  `stella_suggestion_decisions`, valida eventos de observabilidad reales, y
  demuestra que `STELLA_GROUNDED_QUERY_ENABLED` puede ser `true` en un
  **proceso hijo deliberadamente aislado** sin tocar el proceso padre ni
  ningún archivo persistente.
- **Arnés desechable** —
  [`scripts/stella-release-e2e-dry-run.sh`](../../../scripts/stella-release-e2e-dry-run.sh):
  mismo patrón que `scripts/grounding-dry-run.sh` (contenedor `docker run -d
  --network none`, restore desde `db/baseline/**`, destrucción en el
  `EXIT` trap, sin volumen). Aplica `grounding_0002` + `grounding_0003`
  (**requerido**, aborta si falla), intenta `stella_0003` en **mejor
  esfuerzo** (ver hallazgo abajo), busca un paquete `grounding_0004*` para
  un futuro Train 4 de integración (no existe todavía — documentado, no
  sustituido), corre el recorrido, **destruye el contenedor antes de
  evaluar el gate** (para que `containerDestroyed` sea un hecho confirmado,
  no una promesa), y corre `print-harness-gate.ts` para la decisión final.

## Hallazgo mayor: `uellix_cap_grounding` no puede leer lo que él mismo escribe

**Confirmado por ejecución real, reproducido de forma aislada, no es un bug
del arnés.** Con una sesión REAL autenticada (rol `uellix_app`, GUC
`request.jwt.claims` con un `sub` que sí es miembro de la organización vía
`organization_members`), llamar a
`uellix_grounding.register_document_version(...)` — la única función
`EXECUTE`-otorgada a `uellix_app` para registrar una versión — falla con:

```
ERROR:  new row violates row-level security policy for table "evidence_document_versions"
```

**Causa raíz, aislada con un contenedor de diagnóstico independiente:**
`register_document_version` termina con `INSERT ... RETURNING id INTO
v_id`. PostgreSQL exige, para el `RETURNING` de un `INSERT`, que la fila
recién insertada pase también la política **SELECT** de la tabla — no sólo
la de `INSERT`. La política
`evidence_document_versions_select` (`db/prepared/grounding_0002_document_versions.sql`)
está otorgada `TO authenticated, uellix_app, uellix_auditor` — **sin
`uellix_cap_grounding`**, el propio dueño `SECURITY DEFINER` de la función.
Reproducido con un `INSERT` crudo idéntico: sin `RETURNING` tiene éxito; con
`RETURNING id` falla con el mismo error, como `uellix_cap_grounding`, dentro
y fuera de la función.

**El mismo patrón se repite en cascada, confirmado también por ejecución
directa:**

- `evidence_chunks_definer_write` (grounding_0003) exige, en su `WITH
  CHECK`, un `EXISTS` contra `evidence_document_versions` — que
  `uellix_cap_grounding` tampoco puede leer por la misma ausencia de
  política, así que **`insert_evidence_chunks` también falla** para
  cualquier chunk cuyo `INSERT` directo se pruebe.
- `evidence_chunks_select` (`TO authenticated, uellix_app, uellix_auditor`)
  tampoco incluye `uellix_cap_grounding`, así que `chunks_in_scope` (que lee
  `evidence_chunks` desde dentro de su propio cuerpo `SECURITY DEFINER`) y
  `finalize_document_ingestion` (que hace `SELECT count(*) FROM
  evidence_chunks`) leerían **cero filas** aunque las filas existan — el
  `GRANT SELECT ... TO uellix_cap_grounding` que sí existe en ambos paquetes
  no sustituye a una política RLS que lo incluya.

Es la misma clase de bug que el propio `grounding_0002` ya documentó y
corrigió una vez («train 2 adversarial review... cada llamada moría con
42501... un dry-run que inspecciona estructura sin invocar no puede verlo»)
— pero un caso **nuevo y no detectado** de esa clase, porque
`scripts/grounding-dry-run.sh`'s 6-bis se queda deliberadamente anónimo
(para probar `U0102`) y 6-ter usa `SET ROLE uellix_owner` (bypassa RLS como
dueño) para sus pruebas de integridad — **ningún arnés anterior había
invocado estas funciones con una sesión real, autenticada, de principio a
fin**. Es exactamente lo que "ejecución real" está diseñado para encontrar.

**No es archivo de esta línea.** `db/prepared/grounding_0002_document_versions.sql`
y `grounding_0003_evidence_chunks.sql` son GROUNDING/CAPABILITIES-owned;
RELEASE tiene prohibido tocar `db/**`. Documentado aquí con reproducción
exacta para que integración lo convierta en un contrato abierto (candidato:
añadir `uellix_cap_grounding` a `evidence_document_versions_select` y
`evidence_chunks_select`, o eliminar el `RETURNING`/las lecturas internas y
resolver el id/count por otra vía). El arnés **falla de forma clara** cuando
esto ocurre (Fase 3: «el arnés debe fallar de forma clara si... falla una
función») — ver la corrida de referencia abajo — y aun así **destruye el
contenedor y corre el gate**, en vez de abortar a mitad de camino.

## Hallazgo secundario: `stella_0003` no aplica sobre el baseline actual

`db/baseline/stella_g2_schema.sql` (usado también por
`scripts/grounding-dry-run.sh`) ya contiene una versión **más nueva** de
`public.stella_suggestion_decisions` que la que hoy vive en
`db/prepared/stella_0003_suggestion_decisions.sql`: el baseline trae una
política `INSERT` (`stella_suggestion_decisions_insert_member_or_admin`,
otorgada a `uellix_app`) y concede `SELECT, INSERT` directo a
`uellix_writer`; el paquete preparado asume escritura exclusiva del dueño de
tabla, sin política `INSERT`. La propia autoverificación de
`stella_0003_suggestion_decisions.sql` lo detecta y aborta: «expected
exactly 1 RLS policy, found 2». Tampoco es archivo de esta línea
(`db/baseline/**` y `db/prepared/**` están ambos prohibidos). El arnés
trata `stella_0003` como **mejor esfuerzo** (no es un paquete requerido por
la Fase 3 original) y el recorrido tolera que la tabla no exista.

## Recorrido E2E (Fase 4) — definido y ejecutado; bloqueado en el mismo punto que el hallazgo mayor

Las 18 etapas pedidas están todas **codificadas** en `run-local-journey.ts` y
se ejecutan en orden hasta el bloqueador: ingestión completa, versión
activa, chunks reales, retrieval del proyecto correcto, rechazo de otro
proyecto, consumo de cuota (INT-CAP-001, confirmado abierto contra la base
viva), idempotencia, generación extractiva, citas reconstruibles,
`quotedTextHash`, contradicción atribuida, abstención, payload sólo `query`
(tipado, verificado por construcción con `Object.keys().length === 1`),
flag false sin DB (proceso principal), flag true sólo en proceso local
controlado (subproceso con `env` sobrescrito, nunca persistido), resultado
Product, decisión local no persistida, eventos sin datos sensibles. Ninguna
llama a proveedor. El hallazgo mayor bloquea las etapas que dependen de un
`document_version_id` real emitido por `register_document_version` — el
resto del recorrido (contenedor, aplicación de paquetes, generador,
adaptador, observabilidad, aislamiento de bandera) se probó de forma
independiente donde no dependía de ese paso.

## Pruebas ejecutadas

Sólo focalizadas — Fase 7: sin `test:unit` completo, sin `build`.

| Comando | Resultado |
|---|---|
| `pnpm exec tsc --noEmit` | limpio, 0 errores |
| `pnpm exec eslint tests/eval/stella-release/e2e tests/eval/stella-release/harness-report.ts tests/eval/stella-release/harness-report.test.ts tests/eval/stella-release/local-release-gate.ts tests/eval/stella-release/local-release-gate.test.ts tests/eval/stella-release/fixtures/e2e` | 0 errores, 0 warnings |
| `pnpm exec vitest run tests/eval/stella-release` | **7 archivos, 152 tests passed** (`harness` 67, `command` 10, `wiring` 5, `observability-contract` 19, `local-release-gate` 22, `local-extractive-generator` 5, `harness-report` 24) |
| `bash scripts/stella-release-e2e-dry-run.sh` (arnés desechable real, Docker local) | baseline íntegro, `grounding_0002`+`grounding_0003` aplicados y auto-verificados, `stella_0003` bloqueado (hallazgo secundario documentado), recorrido E2E bloqueado en el hallazgo mayor con reporte completo emitido, contenedor destruido y confirmado ausente, gate evaluado: `local-runtime-harness-ready=false` con 12 razones específicas listadas |

No se ejecutó `pnpm test:unit` completo ni `pnpm build` — fuera del alcance
de la Fase 7. El arnés desechable SÍ se ejecutó contra Docker real (el
entorno de esta sesión lo tenía disponible) — no es una simulación.

## Riesgos abiertos de esta línea

- **`local-runtime-harness-ready` es `false` en esta rama**, y se espera que
  lo sea: depende de un bug real en `db/prepared/grounding_0002` +
  `grounding_0003` que esta línea no puede tocar. La infraestructura del
  arnés (contenedor, ciclo de vida, generador, adaptador, gate) está
  verificada hasta donde el bloqueador lo permite; el camino feliz completo
  queda pendiente de que GROUNDING/CAPABILITIES cierre el hallazgo mayor.
- **El hallazgo mayor no se "arregló probando otra cosa".** Se consideró y
  se descartó construir el recorrido contra `SET ROLE uellix_owner` (que sí
  bypassa RLS) en vez de `uellix_app` — habría ocultado exactamente el bug
  que una sesión real de aplicación expone, y el enunciado de esta línea
  prohíbe sustituir un componente que falta por un atajo.
- **`stella_0003` no se aplicó** — la tabla de decisiones no existe en el
  contenedor desechable de esta corrida; `run-local-journey.ts` lo tolera
  (`to_regclass` antes de contar filas) pero la verificación de "decisión
  local no persistida" queda parcial: prueba que el flag está en `false` en
  el proceso, no que la tabla real rechace escrituras no autorizadas.
- **Ningún paquete `grounding_0004*` existe todavía** — la etapa 6 del arnés
  (Fase 3, punto 6) queda como "not-yet-available", documentado, no
  simulado.
- **El generador extractivo es un patrón fijo sobre un fixture fijo** — no
  es una capa de scoring; la abstención se demuestra alimentando el
  generador con cero candidatos (lo que un scorer real filtraría), no con
  una consulta que de verdad recorra `chunks_in_scope` y salga vacía por
  relevancia. El scorer real (`LexicalChunkScorer`) ya está cubierto por el
  arnés offline existente (tren 1/2) y no se reprueba aquí.

## Estado de entrega a integración

Sólo se tocaron `tests/eval/stella-release/**`, `scripts/stella-release-e2e-dry-run.sh`
y este documento. Ningún archivo `db/**`, `supabase/**`, `package.json`,
config de vitest ni workflow. Sin push, sin acceso a remoto, cero llamadas a
proveedor, cero recursos persistentes (contenedor desechable, sin volumen,
destruido y confirmado en cada corrida).

`STELLA_RELEASE_TRAIN_4_READY_FOR_INTEGRATION`

---

## Tren 4 — integración (2026-08-05)

**Estado: DISEÑO + RUNTIME LOCAL VERIFICADO PARCIALMENTE. Nada aplicado a
ninguna base persistente. Ninguna bandera habilitada en el repositorio.**

Resultado global: **`STELLA_PARALLEL_TRAIN_4_INTEGRATION_BLOCKED_IDEMPOTENCY`**.
El recorrido local completo se ejecuta y pasa; lo único que falta para
`local-runtime-ready` es INT-INT-001 — ver
[`CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md#int-int-001--clave-de-idempotencia-sin-fuente-canonica-tren-4).

### El arnés dejó de tener paquetes best-effort

`scripts/stella-release-e2e-dry-run.sh` aplica **cuatro paquetes obligatorios**
en orden derivado por dependencias, y falla cerrado si cualquiera no aplica:

```
baseline -> grounding_0002 -> grounding_0003 -> stella_0013 -> grounding_0004
```

`stella_0003` **ya no se aplica**. Sirve sólo a la persistencia de decisiones,
que este recorrido no camina (INT-PR-001 abierto, bandera apagada, ninguna
escritura). No es dependencia SQL real del recorrido local. Su ausencia **no**
debilita la afirmación de no-persistencia: `stella_suggestion_decisions` ya
viene en `db/baseline/stella_g2_schema.sql`, así que el paso 6 sigue tomando
una decisión local real y sigue demostrando que la tabla que **podría** haberla
recibido tiene cero filas. (El paquete estaba además bloqueado por un drift
real entre baseline y prepared; ahora simplemente no está en esta ruta.)

### El hallazgo RLS, vuelto a ejecutar

El §5 del arnés interroga el **catálogo vivo**, no el `.sql`: que
`uellix_cap_grounding` esté nombrado por una policy SELECT permisiva en las dos
tablas, que `authenticated` no conserve grants sobre `evidence_chunks`, y que
`chunks_in_scope_attested` exista con sus 20 nombres de argumento (3 IN + 17
OUT). La distinción es la razón de ser del chequeo: **un GRANT ausente lanza;
una POLICY ausente calla**, y un dry-run estructural no ve ninguna de las dos.

Resultado de la ejecución: sin conjunto vacío silencioso, sin `42501`
inesperado, sin error lavado como `provider_unavailable`.

### Lo que la ejecución produjo

Contenedor desechable, `--network none`, sin volumen, destruido y confirmado
ausente antes de evaluar el gate:

| Etapa | Resultado |
|---|---|
| ingestión real de dos `text/plain` | pipeline real de `lib/grounding/ingest` |
| reingesta idéntica | convergente (A=1, B=1 estables) |
| retrieval atestado | 2 filas, cada una con su propio scope, todas coincidentes |
| ataque cross-project | 0 filas desde el proyecto señuelo |
| generación extractiva | `local-extractive-test-only`, 0 llamadas a proveedor |
| validación de citas | 0 incidencias contra los chunks realmente recuperados |
| contradicción | atribuida a ambos lados (1.240 vs 1.180) |
| abstención | `status: 'abstained'` con cero candidatos |
| vista de Product | `partially_grounded`, 1 claim, 1 contradicción |
| decisión local | tomada, **0 filas** en la tabla |
| observabilidad | 9 eventos, 0 violaciones |
| bandera | `enabled-in-process-only` |

`local-runtime-harness-ready = false`, y el reductor nombra **una sola** causa:
`quotaChargedByRuntime` (INT-INT-001). Ese es el estado honesto: todo el
recorrido funciona y la cuota impuesta no puede cobrarse.

### Riesgos operativos que la revisión adversarial dejó registrados

**La cadena de grounding se aplica y se revierte entera.** `grounding_0003`
re-aplicado aisladamente revierte en silencio las dos reparaciones de
`grounding_0004` (el `SELECT` de `authenticated` vuelve, y
`uellix_cap_grounding` sale de la policy, con lo que toda lectura gobernada
pasa a devolver vacío sin lanzar). Documentado como aviso operativo en
`db/prepared/README.md`; no se arregla estructuralmente porque exigiría editar
`grounding_0003` por razones ajenas a su rollback.

**La observabilidad de este flujo no se ha observado.** Ningún módulo de
`app/**`, `lib/grounding/**` ni `db/grounding/**` emite un evento con nombre.
El arnés construye nueve eventos representativos y los valida contra el
contrato real — lo que prueba que el validador funciona, no que la telemetría
del flujo esté limpia. El reporte lo declara ahora en
`observabilityEventSource: 'harness-constructed'`, y el reductor **exige**
`'runtime-emitted'`, de modo que el gate no puede declarar listo un runtime
cuya telemetría nunca se miró.

**Menores registrados, no corregidos:** exhaustión de cuota disputable contra
la ruta de escritura directa de las cinco acciones hermanas; el corte mensual
supone `TimeZone = UTC` sin precondición que lo afirme; el guard del rechazo de
`stella_0013_rollback` depende de que la columna `idempotency_key` exista; el
índice de idempotencia no lleva componente temporal (restricción de diseño a
tener en cuenta al elegir la fuente canónica de INT-INT-001); el tope de 25
ítems de evidencia por consulta no se comunica al usuario; y la agrupación por
corroboración del generador extractivo fija el `statement` al primer pasaje del
grupo, de modo que una segunda fuente citada puede diferir en espaciado o
capitalización.

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

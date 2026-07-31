# STELLA FABLE MOONSHOT — STATUS (punto de recuperación)

> Este archivo es la fuente de verdad para retomar la campaña tras cualquier
> interrupción. Se actualiza en cada checkpoint. Nunca se declara aquí un estado
> que no tenga evidencia en TEST_LEDGER o en commits.
>
> **Reconciliación documental 2026-07-31:** este archivo fue reescrito para
> eliminar contradicciones entre la cabecera (estado final) y el cuerpo (que
> había quedado congelado en el bootstrap). Motivo: auditoría independiente
> `STELLA_MOONSHOT_INDEPENDENT_VERIFICATION` (2026-07-31) — resultado
> `MOONSHOT_BLOCKED_DOCUMENTATION_INTEGRITY`. El código, las pruebas y el
> árbol de git fueron verificados como correctos por esa auditoría; el
> bloqueo era exclusivamente documental. Ningún código, prueba o SQL fue
> tocado en esta reconciliación.

## Cabecera

- **Timestamp final:** 2026-07-31 (reconciliación documental sobre el checkpoint final de campaña)
- **Base SHA:** `dd36a4eca1f8d323c0ed2a57fb14844ea2f1d5f8` (merge PR #45, verificado en `git log`)
- **Branch coordinadora:** `codex/stella-fable-moonshot`
- **HEAD inicial de esta corrección:** `15af6bb48096a9131423f1c43452396c72da0cc2` (cierre de campaña, sin cambios de código desde entonces)
- **Ramas de workstreams:** 9 creadas, integradas y auditadas — ninguna con trabajo sin integrar (0 commits de diferencia entre cada tip `moonshot/*` y HEAD, verificado con `git rev-list --count HEAD..<rama>`)
- **Worktrees propios:** `uellix-stella-fable-moonshot` (coordinador) + `uellix-moonshot-ws1/ws3/ws4/ws5` (worktrees de workstream, conservados para inspección). Ajenos (NO tocados por esta campaña): `uellix-antigravity`, `uellix-antigravity-b1c-integration`, `uellix-stella-autonomous`
- **Fase de campaña:** CAMPAÑA CERRADA — Olas 1, 2 y 3 integradas y auditadas
- **Estado general:** **`STELLA_OFFLINE_RELEASE_CANDIDATE_READY`** (criterios C1–C18 de RELEASE_CRITERIA; C6 = `SATISFIED_OFFLINE_WITH_EXTERNAL_GATE`, ver nota abajo). **NO es PRODUCTION_READY** — gates externos G1–G10 pendientes de ejecución/aprobación humana.
- **Checkpoint final:** `15af6bb` — typecheck / lint (0 errores) / `test:unit` (**2246/2246**) / `eval:offline` (6/6, 28/28) / `eval:roles` (5/5, 14/14, 5/5 canaries) / `pnpm build` (producción) — **TODOS VERDES**, reproducidos de forma independiente.
- **Commits de la campaña:** 93 (84 sin merges + 9 merges de workstream) desde `dd36a4e`.
- **Archivos modificados en toda la campaña:** 178 (94 añadidos, 83 modificados, 1 borrado); +20 497 / −1 315 líneas.
- **Trabajo sin integrar:** cero.
- **Cambios remotos:** cero — `origin/main` permanece en `dd36a4e`; ninguna rama `moonshot/*` existe en remoto; cero push, cero PR.
- **Migraciones aplicadas:** cero — todo el SQL de la campaña vive en `db/prepared/`, fuera de `db/migrations/`, sin aplicar contra ningún stack real.
- **Llamadas a proveedor real:** cero — `providerCalls: 0, geminiCalls: 0` afirmado por ambos gates de eval y verificado en la reproducción de esta reconciliación.
- **Secretos:** cero en el diff completo `dd36a4e...HEAD` (barrido de patrones de claves/tokens/connection-strings sobre líneas añadidas, sin coincidencias reales).

## Nueve merges de workstream (orden cronológico real)

| Ola | SHA completo | Workstream | Descripción |
|-----|---|------|-------------|
| 1 | `61988e8b6214a643222853759f9709d91f73324c` | WS5 Grounding | spec, extracción, chunking, retrieval, paquete DB preparado |
| 1 | `5ffbf52315ee7cc24b8814fe31f594ac43ce4e58` | WS4 Composer | motor determinístico endurecido + numeric guard |
| 1 | `24b122c17be176aa12e896d4878b2136fc8c18a8` | WS1 Context | paridad de contexto de producción + R1–R6 offline + scoring real de harness |
| 1 | `2ecd76676774b5fd8b6e91dfa29af48155aab7a7` | WS3 Security | envelope, suites de inyección, redacción PII, gate de rol, caps del adapter |
| 2 | `de860ca3ce1d9cbb2a5d006644c9dee4c85f38e1` | WS7 Ops | visibilidad de costos, coherencia de billing, legal EN, alertas, soporte |
| 2 | `8f39d2a05cd7046b205ad98d3494adce824c9969` | WS6 Roles & Eval | contextos por rol, contratos de rol, evals offline de roles |
| 2 | `3e967d03b7e6751f8e869d0a52db0c013f6c8e43` | WS3b Persistencia | SQL preparado de hardening, audit trail, observabilidad, decisiones dormantes |
| 2 | `0d0791a2ee09bc99643c344e7d88a2a7047493b9` | WS2 Advisor UX | panel contextual, ciclo de vida de sugerencias, taxonomía, a11y |
| 3 | `c28c1353afc5d3bacefe38de4b19cf2b799deeca` | WS3c Final hardening | gate de poblaciones sensibles, observabilidad de stepMismatch, aviso de fallback KV, adapter de decisión |

Verificación: los 9 SHA son ancestros de HEAD (`git merge-base --is-ancestor <sha> HEAD`). Los 9 tips de rama `moonshot/*` correspondientes tienen 0 commits que no estén ya en HEAD.

## Fase activa por workstream (estado final, no bootstrap)

| WS | Estado | Rama | Notas |
|----|------|------|-------|
| WS1 Context & References | **INTEGRADO** (merge `24b122c`) | `moonshot/ws1-context` | Paridad 18/18 campos con test estricto; R1–R6 resueltas offline; harness con scoring medido (no constante); `pnpm eval:offline` 6/6; paquete G1 con dry-run y reservas §7. Wiring de readiness en `advisor.ts` y mapeo `PAYLOAD_TOO_LARGE` en `run-contextual-advisor.ts`: **RESUELTO** (`ea892ca`, wiring transversal del coordinador) |
| WS2 Advisor UX | **INTEGRADO** (merge `0d0791a`) | `moonshot/ws2-advisor-ux` | Panel contextual con fuentes legibles (RK-03 cerrado), ciclo completo con undo LIFO global + confirmación de staleness, composer sin DOM imperativo, taxonomía 12 códigos (RK-13/13b), DISABLED como prop (inerte), a11y (RK-34/34b). Invariante sin-escritura-automática verificado en código (`StellaContextualAdvisorField.tsx`: `onApply` sólo actualiza estado local). Adapter `onDecision`↔`recordStellaDecision` (D-007): **RESUELTO** (`dec8915`/`c28c135`, `components/stella/decision-adapter.ts`) |
| WS3 Security & Audit | **INTEGRADO** (merge `2ecd766`) | `moonshot/ws3-security` | Envelope `UNTRUSTED_PROJECT_DATA` en los 4 builders legacy, suite adversarial de inyección (30 payloads), redacción PII, `canUseStella` en las 5 acciones, caps de payload/tokens en el adapter |
| WS3b Persistencia & DB security | **INTEGRADO** (merge `3e967d0`, + wiring `568e70d`) | `moonshot/ws3b-persistence` | `stella_0002`/`0003` preparados con rollback (RK-04 → PREPARADO, aplicación = G2), `audit_logs` completo (RK-12), Sentry sanitizado (RK-23), decisiones dormantes con verificación org+proyecto del `interactionId`, casos RLS listos (G3), retención DP-04 en borrador |
| WS3c Final hardening | **INTEGRADO** (merge `c28c135`) | `moonshot/ws3c-final-hardening` | RK-08 (poblaciones sensibles, detector de 5 categorías), RK-19 (`stepMismatch` surfaced), RK-24 (aviso once-per-process de fallback KV), adapter de decisión D-007 |
| WS4 Composer determinístico | **INTEGRADO** (merge `5ffbf52`) | `moonshot/ws4-composer` | Decimal pinneado (incl. `fx.ts`), `parseNum` caracterizado, goldens exactos, 13 clases de bloqueo testeadas, guard numérico+referencias con contexto de value-claim. Wiring del guard en `composer.ts`: **RESUELTO** (`ea892ca`, fail-closed, verificado en código) |
| WS5 Grounding documental | **INTEGRADO** (merge `61988e8`) | `moonshot/ws5-grounding` | Spec+ADR, G5_PACKAGE, extracción csv/txt real, chunking+anclas (invariante de reconstrucción testeada), retrieval con aislamiento estructural, paquete pgvector en `db/prepared/` (NO aplicado). PDF/XLSX correctamente bloqueados en código citando G5 (`G5_GATED_FORMATS`), no implementados de forma encubierta |
| WS6 Roles & Eval | **INTEGRADO** (merge `8f39d2a`, + wiring `791fa9b`) | `moonshot/ws6-roles-eval` | Contextos por rol con linkage de outcomes (RK-17 cerrado offline), contratos versionados con pins de keys+enums, `pnpm eval:roles` 5/5, fixture agua-segura conectada (RK-27 cerrado — ver corrección en RISK_REGISTER). Paso de `role` a `buildReviewerContext`: **RESUELTO** (`568e70d`, verificado en `reviewer.ts:118`). Reformulation fuera de alcance por decisión de producto (DP en DECISIONS) |
| WS7 Ops & Comercial | **INTEGRADO** (merge `de860ca`) | `moonshot/ws7-ops` | Tokens+costo por org visibles en admin (RK-22 mitigado parcial), billing veraz (RK-25 mitigado, ya no usa el fallback `\|\| 10`), legal EN borrador (insumo de G7), alertas sobre señales reales (A1–A6), insumos G8/G9, playbook de soporte |

**Dueños de zonas calientes (ciclo Ola 2, histórico):** `app/actions/stella/**`, `lib/stella/config.ts`, `lib/audit/**`, `db/prepared/**` → WS3b · `components/**`, páginas pipeline/report → WS2 · contextos/prompts/schemas validator-composer-reviewer, `.env.example`, `tests/eval/stella-roles` → WS6 · admin/billing/legal-EN/`lib/stella/cost-model.ts` → WS7 · `package.json` → coordinador.

**Dueños de zonas calientes (ciclo Ola 1, histórico):** `lib/stella/config.ts`, `sanitize.ts`, prompts legacy, `app/actions/stella/**` → WS3 · builders de contexto advisor, `advisor-contextual-system.ts`, `tests/eval/**`, `package.json` (solo script eval:offline) → WS1 · `lib/pipeline/sroi-*`, `composer-output.ts` + guard numérico → WS4 · wiring cross-WS (readiness en advisor.ts, guard en composer.ts) → coordinador en integración.

## Documentos maestros (bootstrap, todavía vigentes como estructura)

- `docs/ops/STELLA_FABLE_MOONSHOT.md`
- `docs/ops/STELLA_FABLE_STATUS.md` (este archivo)
- `docs/ops/STELLA_FABLE_DECISIONS.md`
- `docs/ops/STELLA_FABLE_RISK_REGISTER.md`
- `docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`
- `docs/ops/STELLA_FABLE_TEST_LEDGER.md`
- `docs/ops/STELLA_FABLE_DEPENDENCY_MAP.md` (marcado como plan de arranque/histórico — ver el propio archivo)
- `docs/ops/STELLA_FABLE_RELEASE_CRITERIA.md`
- `docs/ops/gates/G1_PACKAGE.md` … `G9_PACKAGE.md` (inventario completo abajo)
- `.gitignore`: sin cambios netos vs `dd36a4e` (la entrada `/artifacts/` del bootstrap fue revertida — D-006; los artifacts deben permanecer SIN seguimiento pero VISIBLES en `git status` para auditoría local)
- `.claude/settings.local.json` (protecciones deny — NO rastreado, no se comitea; incluye bloqueo de `git add artifacts*`, `git add .`, `-A`, `--all`, `-f`)

## Pruebas (checkpoint final, reproducido de forma independiente 2026-07-31)

| Comando | Resultado | Detalle |
|---|---|---|
| `pnpm typecheck` | VERDE | `tsc --noEmit` sin errores |
| `pnpm lint` | VERDE | 0 errores, 51 warnings preexistentes (`no-unused-vars` + 1 directiva sobrante) |
| `pnpm eval:offline` | VERDE | 6/6 gates, 28/28 casos, 0 violaciones R1–R6, `providerCalls: 0` |
| `pnpm eval:roles` | VERDE | 5/5 gates, 14/14 casos, 5/5 canaries rechazados, contratos 1.0.0 consistentes |
| `pnpm test:unit` | VERDE | **131 archivos, 2246 tests** (baseline `dd36a4e`: 95 archivos/1372 tests → +874 tests netos) |
| `pnpm build` | VERDE | build de producción Next.js (Turbopack) exitoso, 40 rutas |

**Omitidas deliberadamente (política de campaña, sin cambios):** `pnpm test:integration`, `pnpm test:rls` — apuntan a BD remota por defecto, prohibidas por regla de campaña. Detalle completo, incluida la baseline `dd36a4e`, en TEST_LEDGER.md.

## Gates externos

**No todos los gates tienen paquete preparado.** Estado real (detalle en `EXTERNAL_GATES.md`):

- **G1–G5, G8 y G9**: tienen paquete (`docs/ops/gates/G<N>_PACKAGE.md`), ninguno ejecutado.
- **G6** (`report_variant` + layout ejecutivo): **heredado / N/A para esta campaña** — pertenece a `reference_pdf_generation` (sprint anterior), no a Fable Moonshot. Sin paquete propio por decisión de alcance, no por omisión.
- **G7** (revisión legal): paquete creado en esta reconciliación — `docs/ops/gates/G7_PACKAGE.md`. Los borradores (términos, privacidad, retención) ya existían de WS7; lo que faltaba era el checklist de puntos que el asesor legal externo debe validar.
- **G10** (declaración PRODUCTION_READY / piloto): definido en esta reconciliación — `docs/ops/gates/G10_PACKAGE.md`. Depende de G1–G9 superados con evidencia real más aprobación explícita de Lorenzo. Ningún agente de esta campaña puede declararlo.

Ningún gate fue ejecutado por esta campaña ni por esta reconciliación. Ver `EXTERNAL_GATES.md` para el registro completo.

### Endurecimiento pre-ejecución de G2 (2026-07-31, offline)

Tras `STELLA_G2_READINESS_AUDIT` se resolvieron offline sus hallazgos R1–R6, **sin ejecutar G2 ni tocar ninguna base de datos**:

- **Fuente de verdad (R1):** decidida y documentada en `docs/21_DB_OBJECT_SOURCE_OF_TRUTH_ADR.md`. `stella_suggestion_decisions` y `evidence_chunks` permanecen deliberadamente fuera de `db/schema.ts` y del snapshot de Drizzle, con 4 salvaguardas automáticas en `tests/prepared-sql-source-of-truth.test.ts` y un procedimiento de promoción modelado sobre el precedente `db/migrations/0016_fat_mac_gargan.sql`. Motivo verificado: drizzle emite `CREATE TABLE` **sin** `IF NOT EXISTS`, que fallaría contra una base donde G2 ya corrió.
- **SQL endurecido (R5, R6):** los 3 scripts forward y los 3 rollbacks fijan `SET search_path = public`, cualifican todo con `public.`, y **abortan con mensaje accionable** si faltan precondiciones o si la tabla destino existe con forma incompatible — en vez del no-op silencioso de `CREATE TABLE IF NOT EXISTS`. Reconciliación convergente de constraints, índices, grants, RLS y política.
- **Transaccionalidad (R2):** `psql -1 -v ON_ERROR_STOP=1` es ahora el método principal en `G2_PACKAGE.md` **y** en el addendum de grounding; el SQL Editor queda como último recurso con verificación explícita de estado parcial.
- **Criterios de aborto:** A1–A8 en `G2_PACKAGE.md` (host equivocado, backup no verificable, migraciones base ausentes, flag encendido, forma incompatible, fallo post-apply, estado parcial, G5 ausente) y GA1–GA6 propios del addendum.
- **Alcance (R3):** RK-14 reescrito — la signed URL de descarga y el trigger de inmutabilidad de `content_hash` **no** forman parte de G2 y no tienen script preparado; `stella_0004` no existe.
- **Pendiente (R4):** añadir `STELLA_DECISIONS_PERSISTENCE_ENABLED=false` a `.env.example`. Bloqueado por la deny-list del harness (D-002 cubre `.env*`); requiere edición manual de Lorenzo. Registrado como `it.todo` en la suite.

- **Auditoría independiente del diff (3 pasadas):** un agente separado revisó los 6 scripts. Ronda 1: 1 BLOCKER + 3 MAJOR + 9 MINOR — el BLOCKER lo había introducido el propio endurecimiento (`SET search_path = public` rompía la resolución del tipo `vector` en Supabase hosted, donde pgvector vive en `extensions`). Ronda 2: los 13 resueltos, pero el fix del BLOCKER había roto a su vez la variante léxica de G5 (1 MAJOR + 6 MINOR nuevos). Ronda 3: verificación final. Todo lo serio corregido; detalle en TEST_LEDGER.

Pruebas tras el endurecimiento y las dos rondas de correcciones: typecheck VERDE · lint 0 errores · `test:unit` **132 archivos / 2312 tests + 1 todo** (+66 sobre 2246) · suites focalizadas de `db/prepared` 154 tests. Detalle en TEST_LEDGER.

## Bloqueos actuales

Ninguno operativo sobre el trabajo offline — todo lo demostrable sin tocar sistemas remotos está demostrado y reproducido. El trabajo restante depende exclusivamente de gates externos (acción humana / acceso remoto autorizado / decisión de producto), nunca de código pendiente.

## Estado final verificado por componente (2026-07-31, evidencia con file:line — reemplaza la tabla de porcentajes del bootstrap)

| Componente | Estado | Evidencia |
|---|---|---|
| Advisor contextual (server + UI) | **Cerrado offline** | `StellaContextualAdvisorPanel.tsx` montado en los 7 steps; ciclo completo aceptar/rechazar/editar/preview/aplicar |
| Contexto de producción | **Cerrado offline** | Paridad 18/18 campos, `build-advisor-context.parity.test.ts` + `eval:offline` R3 |
| Contrato sourceRefIndexes/sourceFields | **Cerrado offline** | R4 (fuga de índices) con detector de bordes probado; activo en el path shipped |
| Calidad de referencias (R1–R6) | **Cerrado offline, con reserva documentada** | Las 6 reservas resueltas con fixtures/tests; R2 (pertinencia semántica plena) queda como heurística hasta G1 — documentado en `gates/G1_PACKAGE.md` §7 |
| Reformulation | **Fuera de alcance por decisión de producto** | Declarativo puro; DP pendiente en DECISIONS.md, no bloquea el RC offline |
| Ciclo de sugerencias (accept/reject/edit/undo) | **Cerrado offline** | Undo LIFO global con confirmación de staleness; sin DOM imperativo |
| Persistencia de interacciones y decisiones | **Preparado, activación = G2** | Acción `recordStellaDecision` + adapter cableados; tabla dormante tras flag hasta que G2 aplique `stella_0003` |
| Audit trail | **Cerrado offline; append-only = G2** | 4 acciones nuevas en `audit_logs` (metadata-only); trigger append-only preparado en `stella_0002`, aplicación es gate externo |
| Prompt injection | **Cerrado offline** | 30 payloads × builders, envelope `UNTRUSTED_PROJECT_DATA` en los 4 builders legacy + contextual |
| PII | **Cerrado offline** | `redactPii` unicode en todos los caminos libres; retención = DP-04 pendiente de decisión |
| Poblaciones sensibles | **Cerrado offline** | Detector de 5 categorías ES/EN + aviso estático fuera del sobre confiable |
| Aislamiento organizacional | **Cerrado offline** | orgId siempre de sesión; verificado además en `interactionId` (org+proyecto) |
| RLS Stella | **Preparado, verificación real = G3** | Casos RLS editados y listos; ejecución contra stack real es gate externo |
| Roles/permisos de invocación | **Cerrado offline** | `canUseStella(role)` en las 5 acciones, antes de cuota |
| Rate limits / cuotas | **Mitigado parcial** | KV con fallback en memoria advertido once-per-process (RK-24); limitación per-instance en serverless persiste por diseño |
| Payload/timeout/token caps | **Cerrado offline** | `maxOutputTokens`, temperatura, tope de prompt activos |
| Secretos | **Cerrado offline** | Redacción por substring exacto; 0 secretos en el diff de campaña (auditado línea por línea) |
| Grounding documental | **Cerrado offline hasta el límite seguro; PDF/XLSX = G5** | Extracción csv/txt real, chunking+anclas, retrieval con embeddings léxicos deterministas; formatos binarios explícitamente bloqueados en código citando G5 |
| Motor SROI determinístico | **Cerrado offline** | Decimal pinneado, goldens exactos re-derivados por auditor |
| Composer | **Cerrado offline** | Guard numérico+referencias fail-closed, cableado y verificado en `composer.ts` |
| Validator | **Cerrado offline; enforcement = decisión de producto** | `risk_level=high` persistido y auditado; bloquear publicación es DP-06 pendiente de Lorenzo |
| Reviewer roles (5b) | **Cerrado offline, dark por diseño** | `requires_human_review` hardcodeado `z.literal(true)`; 3 flags en `false` en `.env.example` |
| Feature flags | **Cerrado offline** | 3 flags de rol documentados en `.env.example` |
| Eval offline | **Cerrado offline** | Scoring medido sobre violaciones reales (no constante); limitación de short-circuit documentada en G1 §7 |
| Eval real (harness) | **Preparado, ejecución = G1** | Harness parametrizado, guards cuádruples, dry-run verificado con 0 llamadas de red |
| Observabilidad | **Cerrado offline** | `Sentry.captureException` con mensaje truncado y stack reconstruido, sin fragmentos de prompt |
| Costos | **Modelo preparado, calibración real = G9** | `cost-model.ts` con supuestos explícitos; tokens+costo visibles en admin |
| Preparación comercial | **Borradores listos, revisión externa = G7** | ES y EN Stella-aware; billing veraz (ya no usa `\|\| 10`); checklist legal creado en esta reconciliación |

## Baseline histórico `dd36a4e` (auditoría pre-campaña, 2026-07-31 — NO es el estado final)

> Esta sección se conserva únicamente como registro histórico de dónde partió
> la campaña. **No describe el estado actual.** El estado final está en la
> sección anterior. Para trazabilidad, la campaña citó estos porcentajes al
> definir el alcance de cada workstream (ver `DEPENDENCY_MAP.md`).

| Componente | % (baseline, pre-campaña) | Nota clave (histórica) |
|------------|---|-----------|
| Advisor contextual (server) | 85 | Sin consumidor UI; `stepMismatch` descartado |
| Contexto de producción | 40 | Paridad rota: 7 campos nunca poblados (RK-01) |
| Contrato sourceRefIndexes/sourceFields | 95 | Sólido; sólo activo en path no shipped |
| Calidad de referencias (R1–R6) | 30 | Las 6 reservas seguían abiertas en código (RK-02) |
| Reformulation | 15 | Declarativo puro |
| UI Stella (modelo legacy) | 70 | Contextual: 0 %; errores colapsados; a11y parcial |
| Ciclo de sugerencias (accept/reject/edit/undo) | 20 | Sólo preview + apply DOM imperativo |
| Persistencia de interacciones | 70 | Invocaciones sí; decisiones 0 %; denegaciones sin rastro |
| Audit trail | 50 | Fuera de `audit_logs`; append-only sin trigger ni tests (RK-04) |
| Prompt injection | 55 | Contextual fuerte; legacy sin delimitar; 0 tests (RK-07) |
| PII | 70 | Minimización real; narrativas sin redactar (RK-09) |
| Poblaciones sensibles | 0 | Nada (RK-08) |
| Aislamiento organizacional | 90 | El área más fuerte |
| RLS Stella | 50 | Policy existe; 0 tests; grants contradictorios |
| Roles/permisos de invocación | 40 | `viewer` podía invocar (RK-21) |
| Rate limits / cuotas | 75 | Fallback en memoria per-instance; cuota por request |
| Payload/timeout/token caps | 40 | Sin maxOutputTokens ni tope de prompt (RK-22) |
| Secretos | 85 | Redacción exact-substring |
| Grounding documental | 0 (pipeline) / 90 (upload+hash) | Greenfield: sin extracción/RAG/pgvector; archivos write-only |
| Motor SROI determinístico | 90 | Decimal sin `Decimal.set`; parseFloat en %; sin golden ratio test |
| Composer | 85 | IDs de referencias sin validar contra contexto |
| Validator | 90 | HIGH no bloquea publicación |
| Reviewer roles (5b) | 85 (dark) | Contexto prestado del validator; flags indescubribles |
| Feature flags | 80 | Sin protección de typo; 3 flags fuera de .env.example |
| Eval offline | 70 | Harness con scores constantes (RK-05); sin goldens |
| Eval real (harness) | 85 | Sólo advisor contextual; guards ejemplares |
| Observabilidad | 30 | Gemini invisible para Sentry (RK-23) |
| Costos | 25 | tokens_used nunca leído; sin modelo de costo |
| Preparación comercial | 50 | ES legal Stella-aware; EN stub; billing contradictorio (RK-25) |

## Riesgos

9 P0 (RK-01..RK-09): **8 mitigados offline, 1 preparado (RK-04, aplicación = G2)**. 20 P1, 8 P2 — ver RISK_REGISTER.md (reconciliado: RK-27 cerrado, RK-13/13b y RK-34/34b fusionados, RK-04 corregido a PREPARADO).

## Decisiones pendientes

DP-01..DP-06 (DECISIONS.md) — todas de Lorenzo, ninguna bloquea el estado offline alcanzado; todas condicionan pasos posteriores vía gates.

## Próximo comando seguro

```
git status && git log --oneline -5 && pnpm test:unit
```

(la coordinadora debe estar limpia sobre el checkpoint final; la suite debe dar 2246 verdes).

## Instrucciones exactas para retomar (post-campaña)

1. Worktree `C:\Users\Lorenzo\Documents\uellix-stella-fable-moonshot`, rama `codex/stella-fable-moonshot`, HEAD descendiente del checkpoint final (`15af6bb` o posterior de reconciliación documental).
2. Confirmar protecciones (`.claude/settings.local.json` deny list; probar `git push --dry-run` → denegado).
3. **El trabajo restante depende de gates externos y decisiones de Lorenzo** — ejecutar en este orden:
   - G2 (aplicar `stella_0002`/`0003` + grounding en staging, por checklist de `gates/G2_PACKAGE.md`) → luego G3 (`test:rls` local→staging, flip de skips, checklist `gates/G3_PACKAGE.md`).
   - G1 (evaluación real del advisor: `gates/G1_PACKAGE.md`, empezar por canary).
   - Decisiones: DP-01/G5 (grounding: formatos+libs+pgvector), DP-03 (panel contextual vs legacy), DP-04 (retención), DP-06 (validator HIGH bloquea publicación), G7 (revisión legal externa: `gates/G7_PACKAGE.md`).
   - G4 (rollout por rol, un flag a la vez, ventanas de 72h) → G8 (smoke Preview) → G9 (calibración de costos) → G10 (piloto/production readiness, `gates/G10_PACKAGE.md`).
4. Trabajo offline residual opcional (no bloquea el RC): signed URL de descarga de evidencia + trigger de inmutabilidad de `content_hash` (futuro `stella_0004`, notas en RK-14), cuota por tokens (tras G9), PDF/XLSX tras G5, reformulation tras decisión de producto.
5. Las ramas `moonshot/*` ya integradas pueden borrarse localmente cuando Lorenzo lo decida; los worktrees `uellix-moonshot-ws1/3/4/5` quedan para inspección.
6. **Nunca declarar PRODUCTION_READY** sin: G1 real aprobado por humano, G2/G3 aplicados y verificados, G8 smoke en Preview, revisión legal G7 y piloto controlado (G10 con aprobación explícita de Lorenzo).

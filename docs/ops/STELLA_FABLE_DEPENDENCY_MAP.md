# STELLA FABLE MOONSHOT — Mapa de Dependencias

> Última actualización: 2026-07-31 · Base: `dd36a4e`

## Leyenda

- `[I]` inmediata (sin dependencias, arrancable ya)
- `[C]` depende de contexto (WS1)
- `[S]` depende de seguridad (WS3)
- `[DB]` depende de paquete DB (preparación local; la APLICACIÓN es gate G2)
- `[P]` depende de proveedor real (gate G1 — nunca en esta campaña)
- `[D]` depende de decisión de producto (gates G5/G6/DP-xx)

## Grafo por workstream

### WS1 — Production Context & Reference Quality
- `[I]` T1.1 Test de paridad `buildAdvisorContext` ↔ `ContextualAdvisorContext` (hoy los 7 campos contextuales nunca se pueblan en producción — hallazgo crítico de auditoría)
- `[I→T1.1]` T1.2 Poblar contexto real: `projectName`, `stakeholdersSnapshot`, `activitiesSummary`, `calculationReadiness`, `filterSetsSummary`, `calculationSnapshot`, `reportSections`, `proxySummary.value/currency`, linkage en `evidenceMetadata`
- `[I]` T1.3 R1: sentinela citable para colecciones vacías en `canonical-source-field-paths.ts`
- `[I]` T1.4 R4: regla de prompt + validación post-proceso contra fuga de índices en texto libre
- `[T1.2]` T1.5 R3: catálogo filtrado por step en `build-advisor-step-context.ts`
- `[I]` T1.6 R6: prohibición categórica de certificación en prompt + test
- `[T1.2]` T1.7 R5: fixtures `complete` realmente completos (28 casos revisados)
- `[T1.4]` T1.8 R2: heurística de pertinencia de referencias (score offline; la validación semántica plena es G1)
- `[I]` T1.9 Dedup + tope de cardinalidad en `decode-provider-source-ref-indexes.ts`
- `[I]` T1.10 Fallback contextual (hoy sólo existe fallback legacy)
- `[T1.1..T1.10]` T1.11 Gate automatizable de calidad de referencias (script + umbral)
- `[T1.11]` T1.12 `[P]` Paquete G1: harness real parametrizado + criterios (preparar, no ejecutar)
- `[I]` T1.13 Arreglar harness: scores hardcodeados (safety/schema/numeric = 2 constantes) → medición real; aplicar detectores a findings/suggestions, no sólo a summary

### WS2 — Advisor Product Experience
- `[C:T1.2]` T2.1 Componente contextual: findings (severidad, explicación, fuentes legibles), suggestions (proposedText, rationale, missingInformation), incertidumbre/limitations
- `[T2.1]` T2.2 Acciones: aceptar / rechazar / editar / vista previa / aplicar (estado React controlado — NO escritura DOM imperativa como el Composer actual)
- `[T2.2]` T2.3 Historial + deshacer (requiere T3.6 persistencia de decisiones)
- `[I]` T2.4 Taxonomía de errores completa en paneles (RATE_LIMITED con reset, TIMEOUT, PARSE_ERROR…); DISABLED como prop inicial del servidor (no post-click)
- `[I]` T2.5 Accesibilidad: aria-live montado en idle, jerarquía de headings, foco al resultado, tokens de color en vez de hex
- `[I]` T2.6 Tests de StellaReviewerPanel (hoy cero)
- `[T2.1..T2.5]` T2.7 Tests de integración: panel montado en página real del pipeline
- `[D:DP-03]` T2.8 Convivencia/reemplazo del panel legacy

### WS3 — Security, Privacy & Audit
- `[I]` T3.1 Suite adversarial prompt injection (contexto + documental) offline
- `[I]` T3.2 Revisión PII/minimización + poblaciones sensibles (reglas + tests)
- `[I]` T3.3 Reemplazar placeholders `expect(true).toBe(true)` de anti-regression por asserts reales (no-import de cálculo, no-write DB)
- `[DB]` T3.4 Migración preparada: trigger append-only para `stella_interactions` + corrección de `GRANT UPDATE/DELETE` de 0033 + reconciliar CHECK de roles entre 0012 y schema.ts
- `[DB]` T3.5 Tests RLS offline (pglite/local) para `stella_interactions` — aislamiento org + append-only
- `[DB]` T3.6 Persistencia de decisiones: tabla `stella_suggestion_decisions` (o equivalente) + acciones + registro de denegaciones (quota/rate-limit hoy no dejan rastro)
- `[I]` T3.7 Auditoría en `audit_logs` de invocaciones Stella (acciones nuevas en AUDit_ACTIONS) o decisión documentada de por qué no
- `[I]` T3.8 Versionado de prompts + hash en interacción
- `[I]` T3.9 Contadores de tokens/costo/latencia por llamada (estructura offline)
- `[T3.4..T3.6]` T3.10 `[DB]` Paquete G2 (SQL + rollback + checklist) y G3 (tests RLS staging)
- `[I]` T3.11 Envolver los 4 builders legacy en sobre delimitado `UNTRUSTED_PROJECT_DATA` (patrón ya existente en `advisor-contextual-system.ts:64`); activar `markAsData()` (hoy dead code); añadir marcadores de inyección a `FORBIDDEN_PATTERNS`
- `[I]` T3.12 `canUseStella(role)` en `lib/auth/permissions.ts` + enforcement en las 4 acciones (RK-21)
- `[I]` T3.13 Redacción PII (emails/teléfonos/IDs) sobre narrativas y campos libres antes del prompt (RK-09)
- `[I]` T3.14 Gate de poblaciones sensibles: flag por proyecto + guardrail + revisión elevada (RK-08); usar `stakeholderGroups.type` como señal
- `[I]` T3.15 Caps en adapter: `maxOutputTokens`, temperature, tope agregado de tamaño de prompt (límite de arrays en builders) (RK-22)

### WS4 — Deterministic Composer & Numeric Integrity
- `[I]` T4.1 Tests de propiedad del motor (attribution/deadweight/displacement/drop-off/duración/sensibilidad/redondeo/FX)
- `[I]` T4.2 Contrato del composer: ninguna cifra nueva en texto generado (validador numérico output↔motor)
- `[I]` T4.3 Bloqueo por datos incompletos: casos borde + mensajes
- `[T4.2]` T4.4 Trazabilidad: cada cifra del texto mapeada a línea del run

### WS5 — Document Grounding (greenfield confirmado por auditoría)
- `[I]` T5.1 Spec de arquitectura documental (no existe en docs/ — cero menciones de RAG/embeddings/chunking) → insumo para decisión G5
- `[I]` T5.2 Capa de extracción pura `Buffer+mime → {text,pages,warnings}` testeada con `audit-fixtures/agua-segura/*` (pdf, csv, xlsx, txt reales)
- `[T5.2]` T5.3 Chunking + anclas de cita deterministas `{evidenceId,page,charStart,charEnd}`
- `[T5.3]` T5.4 `EmbeddingProvider` interface + stub determinista local (patrón fallbacks.ts)
- `[T5.4]` T5.5 Retrieval + ensamblaje en `StellaProjectContext.evidenceExcerpts` tras flag nuevo
- `[S:T3.1]` T5.6 Prompt injection documental (texto extraído = descontfiado)
- `[DB]` T5.7 Paquete pgvector: migración `evidence_chunks` + RLS espejo (local only; remoto = G2+G5)
- `[I]` T5.8 Quick wins independientes: signed URL de descarga (hoy el usuario no puede reabrir su archivo), hash inmutable de `content_hash` (va con T3.4)

### WS6 — Roles & Evaluation
- `[I]` T6.1 Inventario y contrato formal por rol + schemas versionados
- `[C:T1.2]` T6.2 Reformulation: prompt propio, trigger, schema diferenciado, flag, tests (hoy 15% declarativo)
- `[T1.13]` T6.3 Suites goldens/adversariales/canaries unificadas con scoring real
- `[T6.3]` T6.4 Gate ejecutable offline (`pnpm eval:offline` o script)
- `[T6.4]` T6.5 `[P]` Paquete G1 completo + `[D]` plan rollout por rol (G4)

### WS7 — Operations & Commercial Readiness
- `[I]` T7.1 Runbook de incidentes + rollback (base: caso rotación key Gemini 07-10)
- `[T3.9]` T7.2 Costos por organización + topes + modelo de costos con supuestos
- `[I]` T7.3 Circuit breaker + fallback + timeouts revisados en adapter
- `[I]` T7.4 Dashboard operativo admin (usage por org ya existe parcialmente en lib/admin/stella-services)
- `[D:G7]` T7.5 Borradores términos/privacidad Stella (EN es stub; ES ya es Stella-aware)
- `[D:G4/G8]` T7.6 Plan cohortes + smoke test script
- `[I]` T7.7 `Sentry.captureException` + contexto estructurado (org/run id) en fallos Stella (RK-23)
- `[T3.9]` T7.8 Agregación de `tokens_used` + columna de costo + vista admin (hoy se escribe y jamás se lee) (RK-22)
- `[I]` T7.9 Corregir contradicción de billing: fallback `|| 10` vs cuota 0 fail-closed (RK-25)
- `[I]` T7.10 Script pnpm para el runner real (`eval:real`) + conectar `audit-fixtures/agua-segura` al harness (RK-27, con WS6)

## Frentes paralelos sin colisión de archivos (arranque)

| Lote paralelo | Workstreams | Archivos |
|---------------|-------------|----------|
| A | WS1 (contexto/schemas/advisor) | `lib/stella/context/**`, `lib/stella/advisor/**`, `tests/eval/**` |
| B | WS3 (suites adversariales, audit, migraciones preparadas) | `lib/audit/**`, `db/migrations/(nuevas)`, `tests/(nuevos security)` |
| C | WS4 (motor/composer numérico) | `lib/` cálculo, `lib/stella/schemas/composer-*` |
| D | WS5 (extracción pura + spec) | `lib/(nuevo módulo grounding)`, `docs/` spec |

Zonas calientes (un solo dueño por ciclo): `lib/stella/config.ts`, `lib/stella/index.ts`,
`db/schema.ts`, `lib/stella/prompts/**`. WS2 arranca cuando T1.2 esté integrado
(su UI consume el contexto real).

## Reglas

1. Un gate externo bloqueado congela sólo su entregable, nunca otro workstream.
2. Nada `[P]` se ejecuta: sólo se preparan paquetes.
3. Nada `[DB]` se aplica: sólo se genera, prueba en local/pglite y documenta.
4. `[D]` sin decisión → se implementa hasta el máximo seguro con la opción recomendada marcada como reversible.

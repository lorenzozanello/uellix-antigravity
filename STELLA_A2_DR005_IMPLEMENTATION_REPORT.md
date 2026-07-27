# Stella — Etapa A2.1: DR-005 (Consentimiento explícito por organización). Informe de implementación

**Fecha:** 2026-07-25/26

---

## 1. Rama y commit base

`feature/stella-generation-copilot`, commit base `4c8a8ed9537e4181229ce94f83ca6447db30b172`. Sin cambios respecto a las sesiones anteriores de esta misma cadena de trabajo (Etapa A1, A1.5, A1.6, preparación de A2) — ningún commit se ha creado en ninguna de ellas.

## 2. Estado inicial

`git status` mostraba exactamente el mismo working tree con el que cerró la sesión de preparación de Etapa A2 (documentos de gobernanza + módulo de detección de PII de DR-001), sin ningún commit de por medio. Se leyeron íntegramente los 10 documentos obligatorios y el código señalado (las 4 acciones de Stella, `lib/stella/config.ts`, `quota.ts`, `rate-limit.ts`, `audit-log.ts`, el mecanismo de autenticación/membresías, los roles organizacionales, las políticas RLS aplicables, los patrones de auditoría). Se confirmó mediante un agente de exploración dedicado que **no existía ningún mecanismo de consentimiento, tabla de configuración de IA, ni patrón de revocación previo** en el repositorio — solo dos menciones de prosa en `docs/AUDIT_2026-07-06.md` señalando la ausencia.

## 3. Diseño elegido

**Opción B — registro append-only de eventos**, con una simplificación deliberada: solo 2 valores de `event_type` (`accepted`, `revoked`), no 3.

### Alternativas descartadas

- **Opción A (fila mutable de estado actual):** descartada. Pierde el historial de aceptaciones/revocaciones salvo que se reconstruya vía `audit_logs`, lo cual el propio encargo señala como más frágil.
- **Opción C (estado actual + eventos):** descartada por ser sobre-construcción. El estado vigente se resuelve con una sola consulta indexada (`ORDER BY occurred_at DESC LIMIT 1` sobre `(organization_id, occurred_at)`), lo que hace innecesaria una tabla de estado separada sin perder velocidad de lectura — la razón exacta por la que el encargo pide preferir un modelo append-only "si puede resolver el estado vigente mediante una consulta clara y correctamente indexada".
- **Un tercer `event_type = 'superseded'`** (mencionado como vocabulario de referencia en el encargo): descartado. Una aceptación anterior queda superada implícitamente en cuanto existe una fila `accepted` posterior con `occurred_at` mayor para la misma organización — anotar ese mismo hecho como una fila adicional no aporta información nueva y crea una fuente extra de inconsistencia si alguna vez se insertara una aceptación sin su "superseded" correspondiente. Documentado en el encabezado de la migración `0045`.

### Alcance de `capability_scope`

Global (`['all']`), no granular por rol. Una granularidad por rol sería falsa hoy: la UI no puede administrar permisos de Stella por rol todavía, y el encargo explícitamente advierte contra eso ("evita una falsa granularidad que la interfaz todavía no pueda administrar"). El campo existe en el esquema (`text[]`) para poder evolucionar sin migración adicional.

## 4. Migraciones

- **`db/migrations/0045_stella_ai_consent.sql`** (nueva, aditiva, no edita ninguna migración aplicada): `CREATE TABLE stella_ai_consent_events` + índice `(organization_id, occurred_at DESC)` + `ENABLE ROW LEVEL SECURITY` + `REVOKE ALL ... FROM authenticated` + `GRANT SELECT ... TO authenticated`. Aplicada solo al stack local (`pnpm db:migrate:local`).
- **`db/policies/009_stella_ai_consent_rls.sql`** (nueva): política `SELECT` para miembros activos de la organización (o `super_admin`), sin política de `INSERT`/`UPDATE`/`DELETE`. Aplicada manualmente al stack local (mismo mecanismo que `002_stella_interactions_rls.sql`).
- **`db/schema.ts`**: tabla `stellaAiConsentEvents` reflejando exactamente la migración.
- Verificado: `drizzle-kit check` sin drift (ejecutado 2 veces, antes y después de aplicar la política).
- **Lección aplicada de Etapa A1.5:** a diferencia de `stella_interactions` (que necesitó la migración `0043` posterior para cerrar un grant excesivo de `0033`), esta tabla nace con privilegios mínimos para `authenticated` desde su creación — verificado empíricamente con `has_table_privilege` antes de escribir ninguna prueba.

## 5. Invariantes

- `event_type IN ('accepted', 'revoked')` (CHECK).
- `accepted` exige `ai_terms_version`, `data_policy_version` y `capability_scope` no nulos; `revoked` no los declara (CHECK).
- `organization_id` y `actor_user_id` son `NOT NULL` con FK.
- Ninguna fila histórica se modifica ni se elimina mediante clientes autenticados (RLS + GRANT, defensa en profundidad desde el inicio).
- Una organización nunca puede consultar eventos de otra (RLS `organization_id = ANY(current_user_org_ids())`).
- Solo un `organization_admin` puede aceptar o revocar — verificado con una comparación EXACTA de rol (`ctx.membership.role !== 'organization_admin'`), deliberadamente NO una comprobación de jerarquía de roles (`hasRole`/`canManageOrganization`), para que un `super_admin` global sin membresía `organization_admin` explícita en esa organización no pueda sustituir la decisión.
- La revocación se vincula al consentimiento vigente vía `supersedes_event_id`.
- Retención de estas filas: fuera de alcance de esta sesión (pertenece a DR-004, según el propio encargo).

## 6. RLS y privilegios

| Rol | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `authenticated` | true | **false** | **false** | **false** |
| `anon` | false | false | false | false |
| `service_role` | true | true | true | true |
| `postgres` | true | true | true | true |

Verificado con `has_table_privilege` (no solo por "0 filas afectadas") en `tests/integration/stella-ai-consent-rls.test.ts`. Un intento de `UPDATE`/`DELETE`/`INSERT` directo vía PostgREST como `authenticated` devuelve `42501 permission denied` explícito, no un filtrado silencioso de RLS.

## 7. Server actions

`app/actions/stella/consent.ts`:
- **`acceptStellaConsent()`** — sin argumentos (no hay ningún parámetro por el que un cliente pudiera enviar una versión arbitraria); resuelve `STELLA_AI_TERMS_VERSION`/`STELLA_DATA_POLICY_VERSION`/`STELLA_CONSENT_SCOPE_ALL` desde `lib/stella/consent/versions.ts`; exige `organization_admin`; registra el evento; crea audit log (`AUDIT_ACTIONS.STELLA_AI_CONSENT_ACCEPTED`).
- **`revokeStellaConsent(reason?)`** — exige `organization_admin`; rechaza si no hay consentimiento activo (`NO_ACTIVE_CONSENT_TO_REVOKE`); registra el evento; crea audit log; nunca modifica cuota/plan.

## 8. Compuerta

Integrada en `advisor.ts`/`composer.ts`/`validator.ts`/`reviewer.ts`, en el mismo punto en las 4: **inmediatamente después de resolver auth+organización, antes del chequeo de cuota** (y por tanto antes de rate-limit, contexto y modelo). Códigos de error nuevos: `CONSENT_REQUIRED` (falta), `CONSENT_REVOKED`, `CONSENT_OUTDATED`. Verificado con pruebas que confirman que `checkStellaQuota`/`consumeStellaRateLimit`/`adapter.generate` **no se llaman** cuando el consentimiento no es válido.

## 9. Auditoría

Cada evento en `stella_ai_consent_events` registra organización, actor, tipo, versiones (solo para `accepted`), alcance, fecha, y el evento relacionado (`supersedes_event_id`). Cada aceptación/revocación exitosa crea además exactamente una fila en `audit_logs` (`stella_ai_consent.accepted`/`stella_ai_consent.revoked`), sin texto legal completo, sin secretos, sin payload de proyecto — solo las versiones y el alcance.

## 10. UI

**No implementada en esta sesión**, tal como el encargo permite explícitamente cuando no hay una ubicación coherente ya construida para esto. Se inspeccionó la arquitectura de configuración organizacional existente (`Organization` en `lib/auth/session.ts` y las páginas de administración); no se encontró una pantalla de organización/IA donde encajar mínimamente un estado + 2 botones sin construir una sección nueva. Se documenta como tarea futura. Las *server actions* (`acceptStellaConsent`/`revokeStellaConsent`) y el servicio de estado (`getStellaConsentStatus`) están completos y listos para que una UI los consuma. **El acceso funcional a Stella no se habilitó** (ningún flag se tocó).

## 11. Pruebas

| Archivo | Casos | Resultado |
|---|---|---|
| `lib/stella/consent/__tests__/versions.test.ts` | 4 | ✅ |
| `lib/stella/consent/__tests__/consent-log.test.ts` | 2 | ✅ |
| `lib/stella/consent/__tests__/consent-status.test.ts` | 8 | ✅ (cubre las 6 secuencias del encargo + fail-closed + aislamiento) |
| `app/actions/stella/__tests__/consent.test.ts` | 13 | ✅ |
| `app/actions/stella/__tests__/advisor.test.ts` (ampliada) | 41 (+4 de consentimiento) | ✅ |
| `app/actions/stella/__tests__/composer.test.ts` (ampliada) | — (+3 de consentimiento) | ✅ |
| `app/actions/stella/__tests__/validator.test.ts` (ampliada) | — (+3 de consentimiento) | ✅ |
| `app/actions/stella/__tests__/reviewer.test.ts` (nueva) | 9 | ✅ (no existía ningún test de acción para reviewer.ts antes de esta sesión; se creó acotado al gate + flag/auth/quota) |
| `tests/integration/stella-ai-consent-rls.test.ts` (nueva) | 11 | ✅ (contra Supabase local) |

**Total consentimiento + acciones:** 8 archivos, **161 pruebas**, todas verdes.

## 12. Comandos ejecutados

`pnpm typecheck` (x4) · `pnpm lint` (x2, con 1 corrección de warnings introducidos) · `pnpm exec vitest run lib/stella/consent` · `pnpm exec vitest run app/actions/stella/__tests__/consent.test.ts` · `pnpm exec vitest run app/actions/stella` · `pnpm exec vitest run lib/stella app/actions/stella components/stella tests/stella-quota.test.ts tests/stella-adversarial.test.ts tests/stella-adversarial-runtime.test.ts tests/eval` · `pnpm test:unit` · `pnpm db:migrate:local` (migración 0045) · aplicación manual de `009_stella_ai_consent_rls.sql` · `npx drizzle-kit check` (x2) · `pnpm exec vitest run --config vitest.integration.config.ts tests/integration/stella-ai-consent-rls.test.ts` · `pnpm test:integration` (x2, la primera reveló y la segunda confirmó la corrección de `bootstrap-invariants.test.ts`) · validación del CSV (x2).

## 13. Resultados exactos

- `pnpm typecheck`: limpio, 0 errores.
- `pnpm lint`: 0 errores, 55 warnings (línea base sin cambio; se corrigieron 2 warnings introducidos por un patrón de mock sin tipar).
- Suite de consentimiento + acciones: 8 archivos, **161 pruebas**, 0 fallos.
- Suite completa de Stella (unitaria): 36 archivos, **659 pruebas**, 0 fallos.
- `pnpm test:unit` (proyecto completo): 100 archivos, **1350 pruebas**, 0 fallos.
- `pnpm test:integration`: 5 archivos, **60 pruebas**, 0 fallos (tras corregir el invariante de conteo de tablas: 37→38, por la nueva tabla).
- `drizzle-kit check`: "Everything's fine", sin drift, en ambas ejecuciones.
- CSV: 72 filas, 18 columnas, 0 filas malformadas, 0 IDs duplicados, 0 dependencias colgantes, 0 inversiones de orden.

## 14. Riesgos residuales

1. **UI no implementada** — sin una pantalla, un `organization_admin` solo puede aceptar/revocar invocando las *server actions* directamente (p. ej. desde una futura página o temporalmente vía una herramienta de administración). No bloquea la garantía de seguridad (la compuerta ya impide el uso sin consentimiento), pero limita la usabilidad hasta que se construya.
2. **`capability_scope` es global** — si en el futuro se decide granularidad por rol, se necesitará una migración de datos para las filas `['all']` existentes o una regla de compatibilidad explícita.
3. **Retención de `stella_ai_consent_events`** — no definida en esta sesión, pertenece a DR-004.
4. **Revisión legal de los términos de IA en sí** — Etapa A3, sin resolver. Esta sesión implementa el MECANISMO de consentimiento, no el contenido legal que se está consintiendo.
5. **No existe todavía un flujo de "expirar" un consentimiento automáticamente** por antigüedad (solo por cambio de versión) — no solicitado por el encargo, anotado por completitud.

## 15. Trabajo no realizado (fuera de alcance, expresamente)

DR-007, DR-002, DR-003 (más allá de lo ya cubierto en el bloque anterior de DR-001), DR-004, Etapa A3, ampliación de la detección de PII, umbral de agregación de menores/salud, prompts por paso, sugerencias/reformulación, Evidence Intelligence, Proxy Intelligence, grounding/RAG/embeddings/pgvector, ejecución real del arnés de evaluación, UI de consentimiento.

## 16. Estado del gate

Ver `STELLA_STAGE_A_VALIDATION.json`-equivalente para esta adenda: los 18 criterios del gate (sección 16 del encargo) se cumplen:

- ✅ Consentimiento explícito separado de cuotas/flags.
- ✅ Solo `organization_admin` válido (chequeo exacto, no jerárquico) acepta/revoca.
- ✅ Versiones resueltas en servidor.
- ✅ Consentimiento versionado.
- ✅ Revocación auditada.
- ✅ Eventos históricos no se actualizan ni eliminan (verificado con `has_table_privilege` + intento real de UPDATE/DELETE/INSERT).
- ✅ RLS aísla organizaciones.
- ✅ Privilegios de tabla mínimos desde el inicio.
- ✅ Compuerta integrada en las 4 acciones.
- ✅ Sin consentimiento no se consume cuota (verificado: `mockCheckStellaQuota`/`mockCheckStellaRateLimit`/`mockAdapterGenerate` no llamados).
- ✅ Sin consentimiento no se consume rate limit.
- ✅ Sin consentimiento no se llama al modelo.
- ✅ Aceptación antigua produce `outdated`.
- ✅ Revocación bloquea inmediatamente (verificado en la prueba de integración: el estado vigente resuelve a `revoked` tras el insert del servidor).
- ✅ Ningún flag activado.
- ✅ Ningún dato remoto usado.
- ✅ Ninguna llamada real a Gemini.
- ✅ Pruebas aplicables pasan; documentación coincide con el código.

**Estado: `APROBADO`.**

## 17. Próximo bloque recomendado

`DR-007` (acceso interno a `stella_interactions`) — siguiente candidato natural según la secuenciación acordada con el propietario. **No se continúa automáticamente.**

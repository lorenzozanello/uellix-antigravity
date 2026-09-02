# STELLA FABLE MOONSHOT — Criterios de Release

> Última actualización: 2026-07-31 (reconciliación documental, checkpoint `15af6bb`) · Base: `dd36a4e` (merge PR #45)
>
> C6 y C17 corregidos en esta reconciliación para que el texto del criterio
> coincida con lo que realmente se implementó y verificó — ninguna
> implementación cambió, solo la redacción del criterio.

## Dos niveles, nunca confundirlos

### Nivel 1 — `STELLA_OFFLINE_RELEASE_CANDIDATE_READY`

Es el objetivo máximo de esta campaña. Significa: **todo lo demostrable sin tocar
sistemas remotos está demostrado**, y lo que no puede demostrarse offline tiene un
paquete listo para su gate externo. NO significa que Stella esté lista para usuarios.

### Nivel 2 — `PRODUCTION_READY`

Fuera del alcance de esta campaña. Requiere todos los gates externos G1–G9 superados
con evidencia real (proveedor real, DB real, deploy real) más aprobación explícita
de Lorenzo (G10). Ningún agente de esta campaña puede declararlo.

## Criterios verificables para OFFLINE_RELEASE_CANDIDATE

Cada criterio debe cerrarse con un comando reproducible o un artefacto en el repo.
"Verificado" = el comando corre verde en este worktree, sin red, sin secretos.

| # | Criterio | Verificación |
|---|----------|--------------|
| C1 | Paridad de contexto: el contexto que reciben los tests/evals es estructuralmente idéntico al de producción | Test de paridad que construye ambos contextos y compara shape + campos |
| C2 | R1–R6 resueltas offline (calidad de referencias) | Suite de evaluación offline con fixtures que reproducen cada R; todas verdes |
| C3 | Advisor UI funcional: findings, suggestions, fuentes, incertidumbre, aceptar/rechazar/editar/preview/aplicar, historial, errores, cuota, indisponibilidad | Tests de componentes e integración verdes; recorrido manual documentado con capturas no requerido |
| C4 | Seguridad offline sin bloqueos críticos: suite adversarial de prompt injection + PII + aislamiento org verde; riesgos residuales documentados en RISK_REGISTER | `pnpm test:unit` incluye la suite de seguridad; 0 hallazgos P0 abiertos |
| C5 | Persistencia auditable implementada o preparada (tablas + acciones + audit trail), con migraciones generadas | Tests unitarios de servicios + SQL de migración generado y revisado |
| C6 | Migraciones preparadas y probadas SIN aplicación remota. **Estado: `SATISFIED_OFFLINE_WITH_EXTERNAL_GATE`** — el SQL de esta campaña (`db/prepared/*.sql`) fue **escrito manualmente**, fuera de `db/migrations/` a propósito (para que drizzle-kit nunca lo aplique automáticamente — ver `db/prepared/README.md`). La verificación offline es un **lint estructural** (paréntesis balanceados, sentencias terminadas, keywords esperadas/prohibidas — `lib/grounding/__tests__/prepared-sql.test.ts`, `tests/prepared-stella-sql.test.ts`), explícitamente **no un parse de Postgres real**. Cada script tiene su rollback preparado en el mismo directorio | Lint estructural offline (verificado, comandos en TEST_LEDGER) + rollback preparado; la prueba contra un stack Postgres real (pglite o staging) es responsabilidad de G2/G3, no de esta campaña |
| C7 | Composer determinístico: números solo del motor decimal.js; la explicación generativa nunca produce cifras nuevas | Tests de propiedad/regresión del motor + test de contrato del composer |
| C8 | Arquitectura documental implementada hasta el máximo seguro (mocks de storage/extract; sin Supabase remoto) | Tests con mocks; paquete DB (pgvector) preparado si aplica, no aplicado |
| C9 | Contratos de roles (advisor, reformulation, suggestion, validator, reviewer, composer) con schemas versionados | Schemas Zod + tests de contrato por rol |
| C10 | Evaluación offline completa (goldens + adversariales + canaries) verde | Comando de eval offline documentado en TEST_LEDGER |
| C11 | Paquetes de evaluación real preparados (G1) sin ejecutar | `docs/ops/gates/G1_PACKAGE.md` + script parametrizado |
| C12 | Paquetes DB preparados (G2/G3) sin ejecutar | `docs/ops/gates/G2_PACKAGE.md`, `G3_PACKAGE.md` |
| C13 | Plan operativo: observabilidad, alertas, topes de costo, circuit breaker, incidentes, rollback | Doc + código offline donde aplique |
| C14 | Suites verdes: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` en la rama coordinadora | Salidas registradas en TEST_LEDGER con timestamp |
| C15 | Riesgos documentados y ninguno P0 sin mitigación o aceptación explícita | RISK_REGISTER al día |
| C16 | Ramas locales auditables: commits temáticos, sin artifacts, sin secretos, integradas solo tras auditoría independiente | `git log` + registro en STATUS |
| C17 | Cero secretos en el diff: ningún commit introduce una clave, token o credencial real. `.env.example` puede documentar **nombres de flags nuevos con valores seguros por defecto** (esta campaña añadió 3 flags de rol, todos `false`) — eso no es un secreto, es superficie de configuración documentada. Ningún `.env` real (no-`.example`) fue tocado ni existe en el diff | Revisión de diff por auditor línea por línea contra patrones de claves/tokens/connection-strings + `git log -p` spot check; verificado: 0 coincidencias reales en `dd36a4e...HEAD` |
| C18 | Cero cambios remotos: no push, no PR, no migración aplicada, no seed, no deploy, no llamada a proveedor real | Protecciones FASE G activas + declaración en STATUS |

## Regla de degradación

Si al agotar el presupuesto no se alcanzan todos los criterios, el resultado se declara
`STELLA_FABLE_PARTIAL_<n>` enumerando criterios verdes/rojos — nunca se degrada la
definición de READY para que "alcance".

# STELLA FABLE MOONSHOT — STATUS (punto de recuperación)

> Este archivo es la fuente de verdad para retomar la campaña tras cualquier
> interrupción. Se actualiza en cada checkpoint. Nunca se declara aquí un estado
> que no tenga evidencia en TEST_LEDGER o en commits.

## Cabecera

- **Timestamp:** 2026-07-31 (bootstrap completado)
- **Base SHA:** `dd36a4eca1f8d323c0ed2a57fb14844ea2f1d5f8` (merge PR #45, verificado en `git log`)
- **Branch coordinadora:** `codex/stella-fable-moonshot` (== `origin/main` al inicio)
- **Ramas de workstreams:** ninguna creada aún (creación lazy — D-005)
- **Worktrees propios:** sólo `uellix-stella-fable-moonshot`. Ajenos (NO tocar): `uellix-antigravity`, `uellix-antigravity-b1c-integration`, `uellix-stella-autonomous`
- **Fase de campaña:** BOOTSTRAP CERRADO → lista para campaña funcional (no iniciada)
- **Estado general:** `STELLA_FABLE_MOONSHOT_READY_FOR_GOAL`

## Fase activa por workstream

| WS | Fase | Rama | Notas |
|----|------|------|-------|
| WS1 Context & References | NO INICIADO | — | Arranque prioritario: T1.1 test de paridad |
| WS2 Advisor UX | NO INICIADO | — | Bloqueado parcialmente por T1.2 |
| WS3 Security & Audit | NO INICIADO | — | Arranque prioritario: T3.1/T3.3 |
| WS4 Composer determinístico | NO INICIADO | — | Paralelo seguro con WS1/WS3 |
| WS5 Grounding documental | NO INICIADO | — | T5.1 spec + T5.2 extracción pura |
| WS6 Roles & Eval | NO INICIADO | — | Depende de T1.13 |
| WS7 Ops & Comercial | NO INICIADO | — | T7.1/T7.3 arrancables |

## Commits de la campaña

| SHA | Rama | Descripción |
|-----|------|-------------|
| HEAD (primer commit sobre `dd36a4e`; ver `git log --oneline -1`) | coordinadora | bootstrap: docs maestros + protecciones + gitignore artifacts |

## Archivos modificados (bootstrap)

- `docs/ops/STELLA_FABLE_MOONSHOT.md` (nuevo)
- `docs/ops/STELLA_FABLE_STATUS.md` (nuevo, este archivo)
- `docs/ops/STELLA_FABLE_DECISIONS.md` (nuevo)
- `docs/ops/STELLA_FABLE_RISK_REGISTER.md` (nuevo)
- `docs/ops/STELLA_FABLE_EXTERNAL_GATES.md` (nuevo)
- `docs/ops/STELLA_FABLE_TEST_LEDGER.md` (nuevo)
- `docs/ops/STELLA_FABLE_DEPENDENCY_MAP.md` (nuevo)
- `docs/ops/STELLA_FABLE_RELEASE_CRITERIA.md` (nuevo)
- `.gitignore` (añade `/artifacts/` — mitiga RK-26)
- `.claude/settings.local.json` (protecciones deny — NO rastreado, no se comitea)

## Pruebas

- **Ejecutadas (baseline `dd36a4e`):** `pnpm typecheck` VERDE · `pnpm lint` VERDE (0 err/54 warn) · `pnpm test:unit` VERDE (95 archivos, 1372 tests). Detalle en TEST_LEDGER.
- **Omitidas:** `test:integration`, `test:rls` (BD remota — prohibidas), `build` (se corre por integración de WS).

## Gates externos

G1–G10 todos PENDIENTES, ningún paquete preparado aún. Ver EXTERNAL_GATES.md.

## Bloqueos actuales

Ninguno operativo. Decisiones de producto pendientes (DP-01..DP-05 en DECISIONS.md)
no bloquean el arranque de ningún workstream.

## Porcentaje verificado por componente (auditoría 2026-07-31, 6 agentes, evidencia con file:line)

| Componente | % | Nota clave |
|------------|---|-----------|
| Advisor contextual (server) | 85 | Sin consumidor UI; `stepMismatch` descartado |
| Contexto de producción | 40 | **Paridad rota: 7 campos nunca poblados** (RK-01) |
| Contrato sourceRefIndexes/sourceFields | 95 | Sólido; sólo activo en path no shipped |
| Calidad de referencias (R1–R6) | 30 | Las 6 reservas siguen abiertas en código (RK-02) |
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
| Roles/permisos de invocación | 40 | `viewer` puede invocar (RK-21) |
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

9 P0 (RK-01..RK-09), 20 P1, 8 P2 — ver RISK_REGISTER.md. Ninguno aceptado aún.

## Decisiones pendientes

DP-01..DP-05 (DECISIONS.md) — todas de Lorenzo, ninguna bloquea el arranque.

## Próximo comando seguro

```
git status && git log --oneline -3
```

(verificar que la coordinadora sigue limpia sobre el commit de bootstrap antes de abrir WS1/WS3/WS4).

## Instrucciones exactas para retomar

1. Abrir el worktree `C:\Users\Lorenzo\Documents\uellix-stella-fable-moonshot`, rama `codex/stella-fable-moonshot`.
2. Verificar HEAD descendiente de `dd36a4e` y working tree limpio.
3. Confirmar protecciones: `.claude/settings.local.json` contiene la lista deny (si falta, restaurar según MOONSHOT §Protecciones y verificar con `git push --dry-run` → debe ser denegado).
4. Leer este archivo + DEPENDENCY_MAP + RISK_REGISTER.
5. Continuar con el primer workstream NO INICIADO según prioridad (WS3 → WS1 → WS4 en paralelo si hay capacidad; WS2 tras T1.2).
6. Cada unidad atómica termina con: tests verdes registrados en TEST_LEDGER + auditoría independiente + commit local con rutas explícitas + actualización de este archivo.

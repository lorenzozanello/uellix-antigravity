# STELLA FABLE MOONSHOT — Charter de Campaña

> Última actualización: 2026-07-31 · Base: `dd36a4e` (merge PR #45)
> Rama coordinadora: `codex/stella-fable-moonshot`
> Worktree exclusivo: `C:\Users\Lorenzo\Documents\uellix-stella-fable-moonshot`

## Objetivo

Producir `STELLA_OFFLINE_RELEASE_CANDIDATE_READY`: completar todo lo posible mediante
código, mocks, pruebas, documentación, migraciones preparadas y auditoría local, **sin
ningún cambio remoto** y **sin afirmar** que Stella está lista para producción.

Definiciones y criterios: ver [STELLA_FABLE_RELEASE_CRITERIA.md](STELLA_FABLE_RELEASE_CRITERIA.md).
Gates externos: ver [STELLA_FABLE_EXTERNAL_GATES.md](STELLA_FABLE_EXTERNAL_GATES.md).
Estado vivo y punto de recuperación: [STELLA_FABLE_STATUS.md](STELLA_FABLE_STATUS.md).

## Reglas absolutas (resumen operativo)

Sin push, sin PR, sin merge/rebase contra main, sin force-push, sin `git add .`,
sin leer/imprimir `.env*` ni secretos, sin BD remota, sin seeds, sin migraciones
aplicadas, sin Supabase remoto, sin Vercel, sin Gemini real, sin artifacts en staging,
sin tocar otros worktrees, sin merges masivos desde ramas históricas, sin declarar
`STELLA_COMPLETE`/`PRODUCTION_READY`. Protecciones activas: ver §Protecciones.

## Workstreams

### WS1 — Production Context & Reference Quality
**Misión:** el contexto que Stella recibe en producción y el que reciben las evaluaciones
deben ser el mismo objeto, y las referencias (sourceRefIndexes/sourceFields) deben ser
correctas, deduplicadas y verificables.
**Alcance:** paridad de contexto producción/eval; resolución offline de R1–R6; gate
automatizable de calidad de referencias; fixtures representativos; evaluación offline;
paquete G1 para evaluación con proveedor real.
**Archivos base:** `lib/stella/context/`, `lib/stella/schemas/`, `lib/stella/advisor/`,
`tests/eval/`, `audit-fixtures/`.
**Salida:** suite de paridad + suite R1–R6 verdes; `gates/G1_PACKAGE.md`.

### WS2 — Advisor Product Experience
**Misión:** la experiencia completa del advisor por step: pedir consejo, entender
hallazgos, decidir y aplicar con confianza.
**Alcance:** UI por step; findings; suggestions; fuentes visibles; incertidumbre;
aceptar; rechazar; editar; vista previa; aplicar; historial; deshacer; estados de
error, cuota agotada e indisponibilidad; accesibilidad (teclado, aria, foco);
pruebas de componentes e integración.
**Archivos base:** `components/stella/` (o equivalente), páginas del wizard en `app/`,
tests `*.test.tsx`.
**Salida:** flujo completo con tests verdes; criterio C3.

### WS3 — Security, Privacy & Audit
**Misión:** que ninguna vía de Stella permita fuga entre organizaciones, inyección de
instrucciones, exposición de PII o acciones sin rastro.
**Alcance:** autenticación y autorización por rol; aislamiento organizacional; RLS
(tests offline preparados + paquete G3); suite adversarial de prompt injection; PII y
minimización del contexto; poblaciones sensibles; payload limits; rate limits; cuotas;
timeouts; logs con redacción; audit trail append-only; versionado de prompts; contadores
de tokens y costo; latencia; política de retención y eliminación; migraciones preparadas
con rollback (paquete G2).
**Salida:** criterios C4, C5, C6, C12; 0 hallazgos P0 abiertos.

### WS4 — Deterministic Composer & Numeric Integrity
**Misión:** todos los números salen del motor determinístico; la capa generativa solo
explica, jamás calcula.
**Alcance:** motor decimal.js (inputs, moneda, fechas, unidades, attribution,
deadweight, displacement, drop-off, duración, sensibilidad, ratio, redondeo);
trazabilidad de cada cifra; bloqueo explícito por datos incompletos; contrato del
composer: la explicación generativa se genera aparte y se valida contra los números
del motor (ninguna cifra nueva).
**Salida:** criterio C7; tests de propiedad/regresión.

### WS5 — Document Grounding
**Misión:** arquitectura documental completa implementada hasta el máximo seguro
offline: validación, almacenamiento (mock/local), extracción, páginas, tablas,
segmentación, metadatos, embeddings (mock/determinista), búsqueda, aislamiento org,
citas, eliminación, reindexación, contradicciones, documentos irrelevantes, prompt
injection documental.
**Restricción:** si requiere pgvector u otra extensión → paquete DB preparado (G2),
nunca aplicado. La decisión de alcance de producto es G5.
**Salida:** criterio C8; interfaces con implementación mock inyectable.

### WS6 — Roles & Evaluation
**Misión:** contratos formales por rol y un sistema de evaluación ejecutable.
**Alcance:** advisor, reformulation, suggestion, validator, reviewer, composer;
schemas versionados; prompts versionados; feature flags por rol; suites de evaluación
(goldens, adversariales, canaries); plan de rollout por rol; gate ejecutable offline +
paquete G1/G4.
**Salida:** criterios C9, C10, C11.

### WS7 — Operations & Commercial Readiness
**Misión:** que operar Stella sea observable, limitado en costo y soportable.
**Alcance:** observabilidad (Sentry + logs estructurados); alertas; costos por
organización; topes; dashboard operativo (admin); timeouts; circuit breaker; fallback;
runbook de incidentes; soporte; rollback; privacidad y términos (borrador → G7);
onboarding; despliegue por cohortes (plan → G4/G8); métricas de adopción.
**Salida:** criterio C13; runbooks y paquetes de gates.

## Prioridad (ante conflicto de recursos)

1. Seguridad (WS3) · 2. Paridad de producción (WS1) · 3. Integridad de referencias (WS1)
· 4. Experiencia del advisor (WS2) · 5. Persistencia y auditoría (WS3/WS2) · 6. Composer
(WS4) · 7. Grounding documental (WS5) · 8. Roles (WS6) · 9. Preparación comercial (WS7).

## Grafo de dependencias (FASE E)

Ver [STELLA_FABLE_DEPENDENCY_MAP.md](STELLA_FABLE_DEPENDENCY_MAP.md) para el grafo
detallado por tarea. Resumen de arranque:

- **Inmediatas (sin dependencias):** WS1 (paridad+R1–R6), WS3 (suite adversarial,
  rate/quota, audit), WS4 (motor+composer). Archivos disjuntos → paralelizables.
- **Dependen de contexto (WS1):** evaluaciones de WS6, paquete G1.
- **Dependen de seguridad (WS3):** integración final de WS5 (aislamiento documental),
  promoción de WS2 (estados de cuota).
- **Dependen de DB (paquete, no aplicación):** persistencia WS2/WS3, pgvector WS5.
- **Dependen de proveedor real:** solo gates G1/G9 — nada del trabajo offline.
- **Dependen de decisión de producto:** alcance final WS5 (G5), variantes de reporte (G6).

**Regla anti-colisión:** dos workstreams nunca editan el mismo archivo en paralelo.
Zonas calientes compartidas (`lib/stella/index.ts`, `lib/stella/config.ts`, schemas
compartidos): se modifican solo en la rama coordinadora entre integraciones, o en un
workstream designado dueño del archivo en ese ciclo.

## Subagentes (FASE F)

| Rol | Responsabilidad | Restricción |
|-----|-----------------|-------------|
| Arquitecto | Diseño por workstream, contratos entre módulos | No implementa |
| Backend | lib/, server actions, servicios | No toca UI |
| Frontend | components/, app/ (UI) | No toca db/ |
| Seguridad | Suites adversariales, revisión de superficies | Veta integraciones |
| Datos | db/schema, migraciones preparadas, paquetes DB | Nunca aplica |
| SROI/Cálculo | Motor determinístico, sensibilidad | Propiedad de lib de cálculo |
| Documentos/RAG | WS5 pipeline con mocks | Sin Supabase remoto |
| Eval de modelos | Goldens, adversariales, canaries, harness | Sin proveedor real |
| QA | Ejecuta suites, reproduce fallos | No corrige código de producción |
| Auditor independiente | Revisa diff + criterios de cada fase | **Nunca audita lo que implementó** |
| DevOps | Protecciones, scripts, CI local | Sin remoto |
| Documentación | docs/ops actualizados | — |

**Ciclo obligatorio por fase de workstream:**
criterios de aceptación → implementación (TDD) → pruebas verdes → revisión del diff →
auditoría independiente (agente distinto al implementador) → commits locales temáticos →
actualización de `STELLA_FABLE_STATUS.md`.

## Estrategia Git (FASE H)

- Coordinadora: `codex/stella-fable-moonshot` (esta rama). No se crea otra.
- Por workstream, **cuando su ejecución empiece** (no antes): rama
  `moonshot/ws<N>-<slug>` partiendo del commit coordinador vigente, con worktree local
  focalizado bajo `C:\Users\Lorenzo\Documents\uellix-moonshot-ws<N>` si se ejecuta en
  paralelo con otro workstream; si es secuencial, puede trabajarse en la coordinadora
  directamente con commits temáticos.
- Cada rama: alcance delimitado, commits temáticos, sin artifacts, sin secretos, sin push.
- Staging siempre con rutas explícitas (`git add <ruta>...`), jamás `git add .`/`-A`.
- Integración a coordinadora solo tras: suites verdes + auditoría independiente +
  sin conflictos de alcance + STATUS actualizado. Merge local fast-forward o merge
  commit descriptivo; nunca rebase contra main, nunca merge masivo desde ramas históricas
  (inspección read-only de históricas permitida para identificar código reutilizable).

## Protecciones (FASE G) — implementadas y verificadas

- `.claude/settings.local.json` (local, no rastreado, gitignored) contiene reglas `deny`
  del harness que bloquean ANTES de ejecutar: `git push`, `gh pr create/merge`,
  `git merge main|origin/main`, `git rebase`, `git add .|-A|--all|-f|artifacts*`, `git reset --hard`,
  lectura/cat de `.env*`, `pnpm db:migrate`, seeds (`db:seed:*`), `test:integration`,
  `test:rls`, `drizzle-kit migrate`, `supabase`, `vercel`, llamadas a
  `generativelanguage.googleapis.com`.
- Verificación realizada 2026-07-31 con simulaciones inocuas: `git push --dry-run` y
  `pnpm db:seed:proxies --help` fueron denegados por el harness sin ejecutarse.
- No se modifica configuración compartida (`.claude/settings.json` intacto). La entrada
  `/artifacts/` que el bootstrap añadió a `.gitignore` fue revertida (D-006): los
  artifacts permanecen sin seguimiento pero VISIBLES en `git status` para auditoría
  local; el bloqueo de su staging vive en el deny del harness, no en el ignore.

## Presupuesto (FASE J)

- Tope: 8 horas / 60 turnos autónomos.
- Checkpoint obligatorio al cerrar cada workstream o unidad atómica: commit local +
  STATUS + TEST_LEDGER actualizados.
- Al consumir ~80 % del presupuesto: no iniciar operaciones nuevas; cerrar, documentar,
  dejar todas las ramas coherentes (ninguna a medio merge, ningún rojo sin documentar).
- No se asume que todos los frentes se completan: la prioridad §Prioridad decide qué
  se sacrifica; el resultado parcial se declara `STELLA_FABLE_PARTIAL_<n>`.

## Estimación de potencial offline (post-auditoría)

Ver baseline y porcentajes por componente en STELLA_FABLE_STATUS.md.

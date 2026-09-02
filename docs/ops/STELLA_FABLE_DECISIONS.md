# STELLA FABLE MOONSHOT — Registro de Decisiones

> Formato: append-only. Cada decisión: ID, fecha, contexto, decisión, alternativas
> descartadas, quién decide (agente autónomo vs Lorenzo), reversibilidad.

## Decisiones tomadas (bootstrap, 2026-07-31)

### D-001 · Rama coordinadora única
La rama actual `codex/stella-fable-moonshot` es la coordinadora e integración local.
No se crea otra rama de integración. **Decide:** mandato de la misión. Irreversible en campaña.

### D-002 · Protecciones vía `.claude/settings.local.json`
Las operaciones prohibidas se bloquean con reglas `deny` del harness en configuración
local no rastreada, en lugar de git hooks compartidos. **Motivo:** el `.git` común es
compartido entre 4 worktrees (`core.hooksPath` afectaría a todos); settings.local.json
es per-worktree, gitignored y verificable con simulaciones inocuas. **Verificado:**
`git push --dry-run` y `pnpm db:seed:proxies` denegados sin ejecutarse. **Reversible.**

### D-003 · `pnpm test:integration` y `pnpm test:rls` prohibidos en campaña
Ambos apuntan a la BD remota por defecto (hallazgo de auditoría 2026-07-24, sólo
`seed-local.ts` tiene guarda de host). Los equivalentes offline se construyen en WS3.
**Reversible** solo si se demuestra con evidencia que apuntan a stack local.

### D-004 · Baseline verificada antes de cualquier cambio
typecheck + lint + test:unit (1372 verdes) sobre `dd36a4e` registrados en TEST_LEDGER
antes de la primera edición de código. **Decide:** director técnico. Hecho.

### D-005 · Worktrees de workstream sólo lazy
No se crean los worktrees/ramas de los 7 workstreams al inicio; cada uno se crea cuando
su ejecución empieza, partiendo del commit coordinador vigente. **Motivo:** evitar ramas
huérfanas incoherentes si el presupuesto se agota. **Reversible.**

### D-006 · Artifacts sin seguimiento pero visibles (corrección de bootstrap)
El bootstrap (`f986842`) añadió `/artifacts/` al `.gitignore` rastreado. Revertido:
modificaba una política compartida del repo y ocultaba la evidencia local de
`git status`. Regla vigente: los artifacts nunca se agregan al staging (deny del
harness en `.claude/settings.local.json`: `git add artifacts*`, `git add .`, `-A`,
`--all`, `-f`) pero permanecen visibles como untracked para auditorías locales.
Tampoco se usa `.git/info/exclude` (es compartido entre worktrees y ocultaría igual).
**Decide:** mandato de corrección de Lorenzo, 2026-07-31. **Verificado** con
simulaciones no destructivas. Reversible sólo por decisión explícita.

### D-007 · Contratos de decisión UI↔persistencia se reconcilian con adapter explícito
WS2 (`SuggestionDecisionRecord`: suggestionId/action incl. 'copied'/appliedText/decidedAt)
y WS3b (`StellaDecisionInput`: suggestionKey/decision/editedText) definieron contratos
no idénticos en paralelo. Se reconciliarán con un adapter fino y deliberado en la unidad
final (no silenciosamente); 'copied' no se persiste (decisión local sin efecto).
**Decide:** coordinador, 2026-07-31. Reversible.

### D-008 · Incidente de archivos extraviados entre worktrees (resuelto sin daño)
Durante la Ola 2 aparecieron 3 archivos huérfanos de WS3b sin rastrear en el worktree de
WS2 (escritura temprana en ruta equivocada del agente WS3b). El agente WS2 actuó
correctamente: no los comiteó, no siguió instrucciones embebidas en ellos, los preservó
en scratchpad y reportó. Verificado: eran duplicados redundantes de archivos ya
integrados por la rama canónica de WS3b. Sin impacto en el árbol. **Lección registrada:**
los prompts de agentes paralelos ya exigen verificación de rama con `git branch --show-current`.

### DP-06 (nueva, para Lorenzo) · ¿`risk_level=high` del Validator debe bloquear la publicación de reportes?
Hoy es advisory puro (RK-18). Vincularlo al gate de revisión de runs es un cambio de
producto (fricción vs. seguridad metodológica). Insumo: WS4/WS6 dejaron el dato
persistido y auditado; el enforcement sería un check en el flujo de publicación.

## Decisiones pendientes que corresponden a Lorenzo (gates de producto)

| ID | Decisión | Gate | Bloquea |
|----|----------|------|---------|
| DP-01 | Alcance del grounding documental: ¿pgvector en remoto?, ¿qué formatos?, ¿extracción en ingesta o diferida? | G5 | Tramo final WS5 (offline avanza con mocks) |
| DP-02 | report_variant + layout de deck ejecutivo | G6 | Nada de esta campaña |
| DP-03 | ¿La UI contextual del advisor reemplaza al panel legacy (`getStellaAdvisor`) o conviven? | — (recomendación se preparará en WS2) | Integración final WS2 |
| DP-04 | Política de retención/eliminación de `stella_interactions` (plazos) | G7 | Redacción final de privacidad WS7 |
| DP-05 | Cohortes y orden de rollout comercial | G4/G8 | Nada offline |

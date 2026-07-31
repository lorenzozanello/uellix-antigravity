# STELLA FABLE MOONSHOT — Gates Externos

> Última actualización: 2026-07-31 · Base: `dd36a4e` (merge PR #45)

Un **gate externo** es una condición que NO puede satisfacerse desde esta campaña offline:
requiere acción humana, acceso remoto autorizado, o una decisión de producto.
La campaña puede **preparar el paquete** para cada gate, pero nunca declararlo superado.

Regla operativa: un gate externo bloqueado **no detiene** los workstreams independientes;
solo congela la promoción del entregable que depende de él.

## Registro de gates

| ID | Gate | Tipo | Workstream | Qué prepara la campaña offline | Qué requiere el gate |
|----|------|------|------------|-------------------------------|----------------------|
| G1 | Evaluación con Gemini real | Proveedor | WS1, WS6 | Harness de evaluación ejecutable, dataset dorado, criterios de aprobación, script parametrizado por env var | Lorenzo ejecuta con API key real y revisa resultados |
| G2 | Aplicación de migraciones preparadas | DB remota | WS3, WS5 | SQL generado por drizzle-kit, probado contra Supabase local/pglite, checklist de aplicación y rollback | Aplicación manual vía checklist `SUPABASE_STAGING_MIGRATION_CHECKLIST.md` |
| G3 | Verificación RLS contra base real | DB remota | WS3 | Tests RLS ampliados (`tests/integration/rls.test.ts`) listos para correr contra staging | Ejecución autorizada contra staging (NO producción) |
| G4 | Activación de feature flags en Vercel | Deploy | WS6 | Inventario de flags, valores recomendados por cohorte, plan de rollout por rol | Cambio de env vars en Vercel por Lorenzo |
| G5 | Decisión de producto: alcance de grounding documental (¿pgvector?, ¿qué formatos?) | Producto | WS5 | Arquitectura documentada con opciones y recomendación; implementación hasta el máximo seguro con mocks | Decisión de Lorenzo registrada en DECISIONS.md |
| G6 | Decisión de producto: report_variant y layout ejecutivo | Producto | WS7 | N/A en esta campaña (heredado de reference_pdf_generation) | Decisión de Lorenzo |
| G7 | Revisión legal de términos/privacidad para Stella | Legal | WS7 | Borradores y checklist de puntos que el asesor legal debe validar | Revisión legal externa |
| G8 | Prueba de humo end-to-end en Preview | Deploy | WS2, WS7 | Guion de smoke test paso a paso reproducible | Deploy a Preview + ejecución manual |
| G9 | Costos reales por organización (calibración) | Proveedor | WS7 | Modelo de costos con supuestos explícitos y contadores de tokens instrumentados | Datos reales tras G1/G8 |
| G10 | Declaración PRODUCTION_READY | Todos | — | `STELLA_OFFLINE_RELEASE_CANDIDATE_READY` con evidencia | G1–G9 superados + aprobación explícita de Lorenzo |

## Protocolo por gate

Cada gate tiene que terminar con un **paquete de entrega** en el repo:

- `docs/ops/gates/G<N>_PACKAGE.md` (se crea cuando el workstream llega al gate)
- contenido mínimo: precondiciones, comando(s) exactos, resultado esperado,
  criterio de aprobación binario, plan de rollback, dueño humano.

## Estado

| Gate | Estado | Paquete preparado |
|------|--------|-------------------|
| G1–G10 | PENDIENTE | Ninguno aún (bootstrap) |

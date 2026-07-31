# STELLA FABLE MOONSHOT — Gates Externos

> Última actualización: 2026-07-31 (reconciliación documental, checkpoint `15af6bb`) · Base: `dd36a4e` (merge PR #45)
>
> Esta actualización corrige el estado de "Estado" (abajo), que había
> quedado congelado en `PENDIENTE / Ninguno aún (bootstrap)` pese a que 7
> paquetes fueron creados durante la campaña. Ningún gate fue ejecutado —
> solo se corrige el registro de qué paquetes existen.

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
| G6 | Decisión de producto: report_variant y layout ejecutivo | Producto | WS7 | **N/A / heredado de esta campaña** — pertenece a `reference_pdf_generation` (sprint anterior), no a Fable Moonshot. Sin paquete propio por decisión de alcance | Decisión de Lorenzo, fuera del ciclo de esta campaña |
| G7 | Revisión legal de términos/privacidad para Stella | Legal | WS7 | Borradores (Términos, Privacidad, `STELLA_RETENTION_POLICY.md`) + checklist de puntos que el asesor legal debe validar (`gates/G7_PACKAGE.md`, creado en la reconciliación 2026-07-31) | Revisión legal externa + firma de aptitud |
| G8 | Prueba de humo end-to-end en Preview | Deploy | WS2, WS7 | Guion de smoke test paso a paso reproducible | Deploy a Preview + ejecución manual |
| G9 | Costos reales por organización (calibración) | Proveedor | WS7 | Modelo de costos con supuestos explícitos y contadores de tokens instrumentados | Datos reales tras G1/G8 |
| G10 | Piloto controlado + declaración PRODUCTION_READY | Todos | — | Meta-gate que agrega G1–G9 (`gates/G10_PACKAGE.md`, creado en la reconciliación 2026-07-31): dependencias, cohortes de piloto, monitoreo, rollback, criterios de éxito/aborto | G1–G9 superados con evidencia real + aprobación explícita de Lorenzo en dos puntos (piloto y production) |

## Protocolo por gate

Cada gate tiene que terminar con un **paquete de entrega** en el repo:

- `docs/ops/gates/G<N>_PACKAGE.md` (se crea cuando el workstream llega al gate)
- contenido mínimo: precondiciones, comando(s) exactos, resultado esperado,
  criterio de aprobación binario, plan de rollback, dueño humano.

## Estado

Ningún gate fue ejecutado por esta campaña — todos requieren acción humana,
acceso remoto autorizado o una decisión de producto que está fuera del
alcance offline. Lo que cambió entre el bootstrap y el cierre es **cuántos
tienen paquete preparado**:

| Gate | Estado | Paquete preparado |
|------|--------|-------------------|
| G1 | PENDIENTE (ejecución = Lorenzo) | ✅ `gates/G1_PACKAGE.md` |
| G2 | PENDIENTE (ejecución = Lorenzo) | ✅ `gates/G2_PACKAGE.md` + `gates/G2_PACKAGE_GROUNDING_ADDENDUM.md` |
| G3 | PENDIENTE (ejecución = Lorenzo) | ✅ `gates/G3_PACKAGE.md` |
| G4 | PENDIENTE (ejecución = Lorenzo) | ✅ `gates/G4_PACKAGE.md` |
| G5 | PENDIENTE (decisión = Lorenzo) | ✅ `gates/G5_PACKAGE.md` |
| G6 | N/A / heredado para esta campaña | Sin paquete propio (por decisión de alcance, no por omisión) |
| G7 | PENDIENTE (ejecución = asesor legal externo + Lorenzo) | ✅ `gates/G7_PACKAGE.md` (creado en la reconciliación 2026-07-31) |
| G8 | PENDIENTE (ejecución = Lorenzo) | ✅ `gates/G8_PACKAGE.md` |
| G9 | PENDIENTE (ejecución = Lorenzo, requiere tráfico real post-G1/G8) | ✅ `gates/G9_PACKAGE.md` |
| G10 | PENDIENTE (meta-gate, ejecución = Lorenzo) | ✅ `gates/G10_PACKAGE.md` (creado en la reconciliación 2026-07-31) |

**Resumen:** G1–G5, G8 y G9 tienen paquete desde el cierre de campaña
(`15af6bb`). G6 es N/A/heredado por decisión de alcance explícita, sin
paquete propio. G7 y G10 no tenían paquete al cierre de campaña — ambos
fueron creados en esta reconciliación documental (2026-07-31), sin ejecutar
ningún gate ni tocar código.

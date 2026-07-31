# 12 — Backlog por sprints

## Stella — seguimiento de calidad B1.1C

**Estado:** `APPROVED_WITH_RESERVATIONS` (2026-07-31)
**Branch:** `codex/integrate-stella-b1c-model-quality-remediation`
**Corrida canónica:** `02396159-4f9b-4ecb-97de-4cacef8b8caa`
**Gate:** `4d285a79-b50a-4c93-9dd6-c98838c53c35`
**Cierre:** [B1.1C Model Quality Remediation — Closure Report](ops/B1_1C_MODEL_QUALITY_REMEDIATION_CLOSURE.md)

Seis reservas abiertas (R1–R6), ninguna bloquea el cierre de B1.1C. R1, R2, R4 y R5 (prioridad P1) deben resolverse antes de declarar la experiencia audit-ready lista para producción comercial. R3 y R6 (prioridad P2) quedan como mejoras de calidad. `B1C-GATE-AUTOMATION` registra la ausencia de un gate ejecutable como deuda técnica no bloqueante.

| ID | Prioridad | Problema | Evidencia | Impacto | Criterio de aceptación | Bloquea B1.1C | Bloquea producción | Dependencia | Fase recomendada |
|---|---|---|---|---|---|---|---|---|---|
| **R1** | P1 | Empty-collection citation gap: los arrays vacíos visibles al modelo (`proxySummary`, `indicatorsSnapshot`, `outcomesSnapshot` en la variante incomplete, `stakeholderGroups`) no producen ninguna ruta canónica citable, porque `collectCanonicalSourceFieldPaths` sólo recorre hojas concretas. | 10 de 14 fallos de calidad de referencia en la revisión humana de la corrida `02396159-...`; ver `gate-reservations.json` → R1. | Fuerza al modelo a usar `sourceFields: []` en una afirmación fáctica (contradice el contrato del prompt) o a citar una ruta sustituta no pertinente. | Un array vacío produce al menos una hoja citable en el catálogo (p. ej. un sentinel), simétrico al tratamiento actual de `calculationSnapshot: null`. | No | Sí | Cambio en `lib/stella/context/canonical-source-field-paths.ts` | Próxima iteración de B1.1C |
| **R2** | P1 | Reference relevance gap: la validación automática (`canonicalValidation`) sólo comprueba que un índice exista en el catálogo, nunca que la referencia sea pertinente a la afirmación que acompaña. | `canonicalValidation: passed` en 28/28 casos automáticos frente a 14 fallos de calidad de referencia detectados sólo por revisión humana; patrón recurrente de citar `calculationReadiness.ready` (booleano) para respaldar el contenido citable de `calculationReadiness.blockingReasons[0]` (string). | La cadena de trazabilidad mostrada a un auditor puede apuntar al campo equivocado sin que ningún control automático lo detecte. | Un validador adicional exige que si el texto de una afirmación cita el contenido de un campo, ese campo (no sólo un campo relacionado) esté en `sourceFields`. | No | Sí | Depende de R1 (catálogo debe ser citable primero) | Próxima iteración de B1.1C |
| **R3** | P2 | Over-broad source catalog: `buildAdvisorStepContext` no filtra el contexto por step, así que los 7 steps reciben el mismo catálogo de 17 rutas (14 en la variante incomplete), incluyendo `calculationReadiness.*` bajo `stakeholders` o `narrative`. | Caso `b1c-narrative-complete` reporta hallazgos de disponibilidad de cálculo bajo el step narrative. | Amplía la superficie de referencias técnicamente válidas pero fuera de step. | El catálogo por request se filtra a los campos pertinentes al step solicitado. | No | No | Ninguna | Backlog de calidad, sin fecha fija |
| **R4** | P1 | Internal reference index leakage: los índices internos del protocolo `sourceRefIndexes` aparecen en texto orientado al usuario (`summary`, `explanation`, `clarifyingQuestions`) y pueden confundirse con cifras. | Caso `b1c-calculation-groundedness`: `"...no hay datos de cálculo registrados para el proyecto (0)"` y `'Falta evidencia' (13)`, éste último además desalineado con el índice real (14). También en `b1c-indicators-groundedness` y `b1c-proxies-groundedness`. | Un lector no puede distinguir un token de índice de una cifra calculada; riesgo de auditoría de cara al usuario final. | Una capa de post-procesado o un ajuste de prompt elimina tokens de índice del texto libre antes de persistir/mostrar la respuesta. | No | Sí | Ninguna | Próxima iteración de B1.1C |
| **R5** | P1 | Incomplete complete-fixtures: la variante `complete` de indicators, evidence, proxies y calculation no contiene datos poblados — el catálogo oficial de casos fija colecciones vacías y `calculationSnapshot: null` para todas las categorías. | `tests/eval/stella-contextual/cases.ts`, función `context()`; 4 de 28 casos (`b1c-indicators-complete`, `b1c-evidence-complete`, `b1c-proxies-complete`, `b1c-calculation-complete`) duplican la cobertura de sus gemelos `incomplete`. | La corrida no puede distinguir hoy "Stella revisa bien indicadores/proxies registrados" de "Stella reporta bien su ausencia". | Las fixtures `complete` de esos 4 steps incluyen datos poblados representativos, distintos de la variante `incomplete`. | No | Sí | Ninguna | Próxima iteración de B1.1C, antes de la siguiente corrida full |
| **R6** | P2 | Conditional certification refusal: al menos una respuesta adversarial condiciona la negativa a certificar en vez de declararla categóricamente fuera del rol de Stella. | Caso `b1c-outcomes-adversarial`: la limitación vincula la capacidad de certificar a la disponibilidad y validez de la descripción del resultado y la evidencia registrada. Los otros 6 casos adversariales son categóricos. | Framing condicional, no ejecución: la instrucción inyectada (`attribution 20%`) nunca se adoptó en ningún campo. Riesgo de que un usuario interprete la negativa como temporal. | El prompt del sistema refuerza que la certificación está fuera del rol de Stella independientemente de la completitud de los datos. | No | No | Ninguna | Backlog de calidad, sin fecha fija |
| **B1C-GATE-AUTOMATION** | P2 | No existe un gate ejecutable y reproducible para B1.1C: la decisión `APPROVED_WITH_RESERVATIONS` se emitió como gate humano fuera de banda, respaldado por hashes y validaciones mecánicas, no por un script. | `tests/eval/stella-contextual-real/types.ts` fija `eligibleForGate` y `humanReviewStatus` como tipos literales (`false` / `'NOT_STARTED'`), impidiendo que el runner se autoapruebe. Ver §4 de la [Closure Report](ops/B1_1C_MODEL_QUALITY_REMEDIATION_CLOSURE.md). | Cada cierre de B1.x requiere reconstrucción manual de la evidencia de gate; no hay verificación reproducible por CI. | Un gate ejecutable consume run + review, valida hashes e identidad de casos, y emite una decisión estructurada — sin que el runner pueda autoaprobarse. | No | No | Ninguna | Fase de hardening de infraestructura de evaluación, post-B1.1C |

---

## Sprint 0 — Foundation

Objetivo:
Crear la base técnica, documental y operativa.

Tareas:
- Crear repo limpio.
- Agregar documentación.
- Inicializar Next.js + TypeScript.
- Configurar Tailwind.
- Configurar shadcn/ui.
- Configurar pnpm.
- Configurar lint, typecheck, test y build.
- Configurar estructura de carpetas.
- Crear `.env.example`.
- Configurar Supabase client.
- Configurar Drizzle.
- Configurar Vercel preview.
- Crear layout base.
- Crear rutas públicas y privadas vacías.
- Configurar middleware de auth inicial.

Criterios:
- Build exitoso.
- Preview en Vercel.
- Documentación en repo.
- No lógica de negocio compleja aún.

## Sprint 1 — Auth, organizaciones y roles

Objetivo:
Crear base multi-tenant.

Tareas:
- Supabase Auth.
- Modelo users/organizations/memberships.
- RLS inicial.
- Invitaciones.
- Roles.
- Dashboard base.
- Protección de rutas.
- Organization switch/context.

Criterios:
- Usuario solo ve su organización.
- Roles básicos aplicados.
- RLS probado.

## Sprint 2 — Portafolios y proyectos

Objetivo:
Permitir crear portafolios y proyectos.

Tareas:
- CRUD de portafolios.
- CRUD de proyectos.
- Estados de proyecto.
- Vista de proyecto.
- Project navigation.
- Audit log inicial.

Criterios:
- Proyectos asociados a organización.
- Portafolios funcionales.
- Cambios relevantes auditados.

## Sprint 3 — SROI Pipeline core

Objetivo:
Construir flujo metodológico.

Tareas:
- Stepper SROI.
- Narrativa.
- Stakeholders.
- Outcomes.
- Indicadores.
- Formularios.
- Validaciones.
- Stella Advisor placeholder/conexión inicial.

Criterios:
- Proyecto puede avanzar por etapas.
- Stella explica cada paso.
- Datos quedan persistidos.

## Sprint 4 — Trust Layer y evidencias

Objetivo:
Cargar evidencias con trazabilidad.

Tareas:
- Supabase Storage.
- Uploads.
- SHA-256.
- Metadatos.
- Asociación a outcomes/indicators.
- Estados de revisión.
- Anonimización opcional.
- Archivo/eliminación con trazabilidad.
- Audit timeline.

Criterios:
- Toda evidencia tiene hash.
- Storage protegido.
- Audit log funcional.

## Sprint 5 — Proxy Intelligence

Objetivo:
Crear banco de proxies.

Tareas:
- Modelo de fuentes.
- Modelo de proxies.
- CRUD proxy.
- Estados de aprobación.
- Búsqueda y filtros.
- Sugerencias Stella.
- Validación de fuente obligatoria.
- Asociación proxy-outcome.

Criterios:
- No se aprueba proxy sin fuente.
- Proxy puede usarse en cálculo.
- Aprobación humana obligatoria.

## Sprint 6 — SROI Calculation Engine

Objetivo:
Calcular valor social neto y ratio SROI.

Tareas:
- Filtros deadweight, attribution, displacement, drop-off.
- Duración.
- Tasa de descuento.
- Inversión.
- Fórmulas transparentes.
- Snapshot de cálculo.
- Versionamiento.
- Audit log metodológico.

Criterios:
- Cálculo reproducible.
- Fórmulas visibles.
- Cambios auditados.
- Soporta múltiples outcomes.

## Sprint 7 — Stella Validator y Composer

Objetivo:
Convertir Stella en capa central.

Tareas:
- Gemini integration.
- Prompt architecture.
- Advisor contextual.
- Validator estructurado.
- Composer de reporte.
- Risk flags.
- Context snapshots.
- Guardrails.

Criterios:
- Stella no inventa fuentes.
- Stella no certifica impacto.
- Stella genera recomendaciones útiles.
- Interacciones relevantes quedan registradas.

## Sprint 8 — Impact Deck y PDF

Objetivo:
Generar reporte audit-ready.

Tareas:
- Vista web ejecutiva.
- Secciones del reporte.
- PDF export.
- Report versioning.
- SROI Readiness Score.
- Anexos.
- Audit trail visible.
- Compartir con Reviewer/Viewer.

Criterios:
- Reporte web funcional.
- PDF descargable.
- Versionamiento.
- Acceso externo controlado.

## Sprint 9 — Admin Panel y hardening

Objetivo:
Consolidar administración y seguridad.

Tareas:
- SuperAdmin panel.
- Gestión organizaciones.
- Gestión proxy global.
- Logs.
- Revisión RLS.
- Pruebas de permisos.
- QA seguridad.
- Correcciones.

Criterios:
- Admin funcional.
- Accesos seguros.
- Build estable.

## Sprint 10 — MVP Release Candidate

Objetivo:
Preparar primera versión demostrable.

Tareas:
- QA integral.
- Datos demo.
- Seed de proxies oficiales.
- Casos de uso.
- Corrección UX.
- Documentación técnica.
- Checklist release.
- Vercel production readiness.

Criterios:
- Flujo completo funciona.
- Preview estable.
- Demo audit-ready lista.

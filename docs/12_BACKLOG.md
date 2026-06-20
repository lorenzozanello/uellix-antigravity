# 12 — Backlog por sprints

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

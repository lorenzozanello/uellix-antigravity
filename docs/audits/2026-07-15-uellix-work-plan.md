# Plan de Trabajo Uellix
Fecha: 15 de julio de 2026
Autor: Antigravity

## 1. Prioridades
- **P0:** Completar integraciones UI/UX del SROI Pipeline y flujos de carga de evidencia (Trust Layer). Corregir cualquier error en `build` o `typecheck`.
- **P1:** Flujo de Invitaciones, Gestión de Usuarios y Permisos Visuales (Client-side role gating).
- **P2:** Funcionalidad completa del Impact Deck y exportación a PDF. Integración visual final de Stella.
- **P3:** Dashboard de Administración avanzado, reportes estadísticos y telemetría.

## 2. Dependencias entre Tareas
El SROI Pipeline no puede completarse sin un flujo de carga de evidencias funcional (Trust Center). El Impact Deck no puede generarse hasta que el cálculo del SROI Pipeline y las interacciones con Stella estén consolidados en frontend.

## 3. Orden Recomendado de Ejecución
1. Correr CI estático local (`pnpm lint`, `typecheck`, `test`) para limpiar errores latentes.
2. Construcción de UI para "Trust Center" (carga y hash de archivos).
3. Construcción de UI para Pipeline SROI y Proxy Intelligence.
4. Finalización del flujo de invitaciones y onboarding.
5. Integración visual de Stella (Advisor/Composer).
6. Construcción del Impact Deck y PDF Audit-Ready.

## 4. Resultado Esperado de Cada Tarea
Entregables funcionales con componentes en Next.js conectados a Drizzle ORM y protegidos por sesión Supabase, respaldados por pruebas de Vitest.

## 5. Criterios Verificables de Aceptación
- La base de datos no debe arrojar errores RLS.
- Las evidencias cargadas deben generar un hash SHA-256 inmutable.
- Todos los cambios deben pasar `pnpm test` y `pnpm build`.

## 6. Archivos o Componentes Afectados
`app/app/projects/`, `app/app/trust-center/`, `components/sroi/`, y múltiples hooks/servicios clientes de Next.

## 7. Riesgos
Demora en el cierre del frontend; discrepancias entre tipos Zod en formularios y la base de datos (requiere atención a inferencia de tipos).

## 8. Pruebas Requeridas
Pruebas de integración de servidor/acciones (`vitest`), además de pruebas E2E (requieren Cypress o Playwright, actualmente ausentes).

## 9. Estimación Relativa
- Flujo de Evidencias (Trust Center): **M**
- SROI Pipeline UI (Cálculos): **L**
- Impact Deck & PDF: **L**
- Flujo de Invitaciones UI: **S**
- Stella UI: **M**

## 10. Propuesta de Sprints
- **Sprint 3:** Trust Center + Flujos de Evidencia (2 semanas).
- **Sprint 4:** SROI Pipeline y Proxy Engine (2 semanas).
- **Sprint 5:** Stella Integrations y Onboarding final (2 semanas).
- **Sprint 6:** Impact Deck, Reportes y E2E Testing (2 semanas).

## 11. Quick Wins
- Eliminar la directiva `'use server'` errónea de los componentes React de servidor (ej. `OutcomeAllocationWrapper.tsx`).
- Corregir el log de auditoría en `lib/pipeline/outcomes.ts` que registra erróneamente `ORGANIZATION_CREATED`.
- Unificar directorios de componentes migrando los de `app/components/` a la carpeta global `components/`.
- Resolver los bugs actuales de typecheck (identificados en commits recientes).
- Aplicar políticas RLS (script manual ya listo).

## 12. Deuda que puede aplazarse
Multiidioma, reportes complejos de administrador, y validación por anclaje blockchain externo.

## 13. Condiciones Mínimas para Despliegue Comercial
- SROI Score dinámico validado.
- Evidencias subidas y cacheadas con seguridad.
- Auth y Roles 100% blindados sin filtración entre orgs.
- `pnpm build` sin warnings ni errores críticos.

## 14. Hoja de Ruta (30, 60 y 90 días)
- **30 días:** Trust Center funcional y SROI Pipeline conectado; Pilotos internos habilitados.
- **60 días:** Stella en funcionamiento visual y emisión de PDF Audit-Ready.
- **90 días:** Despliegue Comercial (Beta), monitoreo y optimización de rendimiento.

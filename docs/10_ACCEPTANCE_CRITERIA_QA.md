# 10 — Criterios de aceptación y QA

## Definition of Done

Una tarea está terminada cuando:

1. Compila correctamente.
2. No rompe TypeScript.
3. Pasa lint.
4. Pasa build.
5. Tiene manejo de errores.
6. Tiene estados de carga.
7. Tiene estados vacíos.
8. Respeta permisos.
9. Respeta RLS.
10. Registra audit log si aplica.
11. No expone datos de otra organización.
12. No introduce claims incorrectos.
13. Tiene validación server-side.
14. Actualiza documentación si cambia arquitectura.
15. Tiene preview de Vercel si aplica.

## Comandos mínimos

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Si no existen:
- crearlos;
- documentarlos;
- no avanzar sin proponer validación equivalente.

## QA funcional MVP

### Auth

- Usuario puede iniciar sesión.
- Usuario puede cerrar sesión.
- Usuario no autenticado no accede a rutas privadas.
- Usuario solo ve su organización.

### Organizaciones

- Crear organización.
- Invitar usuario.
- Asignar rol.
- Restringir acceso por rol.

### Proyectos

- Crear proyecto.
- Editar información básica.
- Cambiar estado.
- Ver proyecto dentro de organización.

### SROI Pipeline

- Crear narrativa.
- Crear outcomes.
- Crear indicadores.
- Asociar evidencias.
- Seleccionar proxies.
- Aplicar filtros.
- Calcular SROI.
- Ver fórmulas y supuestos.

### Evidencias

- Cargar archivo.
- Generar SHA-256.
- Guardar metadatos.
- Asociar a indicador/outcome.
- Archivar.
- Eliminar con trazabilidad.

### Proxies

- Crear proxy.
- Registrar fuente.
- Aprobar proxy.
- Rechazar proxy.
- Usar proxy aprobado en cálculo.
- Bloquear proxy sin fuente.

### Stella

- Advisor responde por paso.
- Validator detecta riesgos.
- Composer redacta secciones.
- No inventa fuentes.
- No certifica impacto.
- Registra interacciones relevantes.

### Reportes

- Generar vista web.
- Generar PDF.
- Crear versión.
- Ver SROI Readiness Score.
- Ver audit trail.
- Compartir con Reviewer/Viewer.

## QA de seguridad

Probar:

1. Usuario A no ve organización B.
2. Analyst no gestiona usuarios.
3. Viewer no edita.
4. Reviewer no borra.
5. Evidencias privadas no son públicas.
6. Storage no permite acceso sin permiso.
7. Variables secretas no aparecen en frontend.
8. RLS bloquea consultas cruzadas.
9. Report share solo muestra lo autorizado.
10. SuperAdmin genera audit log al intervenir.

## QA de metodología

Probar:

1. No se puede usar proxy aprobado sin fuente.
2. No se puede calcular sin outcome.
3. No se puede calcular sin inversión.
4. Cambios de filtros generan audit log.
5. Stella advierte evidencias faltantes.
6. Stella advierte atribución débil.
7. Fórmulas son visibles.
8. Reporte diferencia datos, supuestos y análisis.

## QA de reportes

Probar:
- versión 1;
- edición;
- versión 2;
- PDF generado;
- enlaces de evidencia;
- audit trail;
- acceso externo;
- revocación de acceso.

## Criterios de bloqueo

No se puede avanzar a producción si:

- falla build;
- RLS no está configurado;
- hay exposición cruzada de datos;
- evidencias no tienen hash;
- proxies no tienen fuente;
- Stella genera claims de certificación;
- reportes no tienen versión;
- acciones sensibles no generan audit log.

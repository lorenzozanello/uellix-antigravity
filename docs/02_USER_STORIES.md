# 02 — Historias de usuario

## SuperAdmin

### US-001 — Gestionar organizaciones

Como SuperAdmin, quiero crear y administrar organizaciones para controlar qué clientes usan Uellix.

Criterios de aceptación:
- Puedo crear una organización.
- Puedo editar datos básicos.
- Puedo activar o desactivar una organización.
- Puedo ver usuarios asociados.
- Los datos de una organización no se mezclan con otra.

### US-002 — Gestionar banco global de proxies

Como SuperAdmin, quiero administrar proxies oficiales para que las organizaciones usen fuentes trazables y confiables.

Criterios de aceptación:
- Puedo crear proxies globales.
- Puedo registrar fuente, URL, año, país, moneda y valor.
- Puedo marcar proxies como aprobados, rechazados o archivados.
- Ningún proxy queda aprobado sin fuente.
- Todo cambio queda en audit log.

## OrganizationAdmin

### US-003 — Invitar usuarios

Como OrganizationAdmin, quiero invitar usuarios a mi organización para distribuir el trabajo de análisis de impacto.

Criterios de aceptación:
- Puedo invitar usuarios por email.
- Puedo asignar roles.
- Puedo cambiar roles.
- Puedo desactivar usuarios.
- No puedo invitar usuarios a otra organización.

### US-004 — Crear portafolio

Como OrganizationAdmin, quiero crear portafolios para agrupar proyectos de impacto.

Criterios de aceptación:
- Puedo crear un portafolio.
- Puedo asociar varios proyectos.
- Puedo ver avance y SROI Readiness Score agregado.
- Solo usuarios autorizados pueden ver el portafolio.

## ImpactManager

### US-005 — Crear proyecto de impacto

Como ImpactManager, quiero crear un proyecto de impacto para estructurar su análisis SROI.

Criterios de aceptación:
- Puedo crear proyecto.
- Puedo definir nombre, descripción, tema, territorio, periodo y población objetivo.
- Puedo asociar proyecto a portafolio.
- El proyecto tiene estado inicial.
- El proyecto queda asociado a mi organización.

### US-006 — Construir narrativa de impacto

Como ImpactManager, quiero construir una narrativa de impacto para explicar qué transformación busca generar el proyecto.

Criterios de aceptación:
- Puedo escribir narrativa.
- Stella Advisor explica qué debe contener.
- Stella puede sugerir mejoras.
- Los cambios se versionan.
- La narrativa puede conectarse con outcomes.

### US-007 — Definir resultados esperados

Como ImpactManager, quiero definir outcomes para conectar la narrativa con resultados verificables.

Criterios de aceptación:
- Puedo crear outcomes.
- Puedo asociar outcomes a narrativa.
- Puedo clasificar outcomes por grupo de interés.
- Stella puede advertir si un outcome es ambiguo.
- Cada outcome puede tener indicadores y evidencias.

## Analyst

### US-008 — Crear indicadores

Como Analyst, quiero crear indicadores para medir resultados del proyecto.

Criterios de aceptación:
- Puedo crear indicador.
- Puedo definir unidad, línea base, meta, fuente y periodo.
- Puedo asociarlo a un outcome.
- Puedo indicar si es cuantitativo o cualitativo.
- Stella puede advertir vacíos de medición.

### US-009 — Cargar evidencias

Como Analyst, quiero cargar evidencias para respaldar indicadores y resultados.

Criterios de aceptación:
- Puedo cargar PDF, Excel, CSV, imágenes, Word y otros formatos permitidos.
- El sistema genera hash SHA-256.
- Puedo asociar evidencia a outcome o indicador.
- Puedo registrar fuente, descripción y nivel de confianza.
- Puedo marcar si requiere anonimización.
- Todo queda en audit trail.

### US-010 — Seleccionar proxies

Como Analyst, quiero seleccionar proxies financieros oficiales para monetizar outcomes.

Criterios de aceptación:
- Puedo buscar en el banco de proxies.
- Puedo filtrar por tema, país, fuente, moneda y año.
- Puedo ver justificación y fuente.
- Puedo proponer nuevo proxy.
- Stella puede sugerir proxies, pero no aprobarlos.
- Un humano debe aprobar el proxy antes de usarlo definitivamente.

### US-011 — Aplicar filtros SROI

Como Analyst, quiero aplicar filtros SROI para ajustar el valor atribuible del impacto.

Criterios de aceptación:
- Puedo registrar deadweight, attribution, displacement y drop-off.
- Puedo justificar cada ajuste.
- El sistema muestra fórmula y efecto de cada filtro.
- Los cambios quedan registrados.
- Stella Validator advierte ajustes débiles o no justificados.

## Reviewer

### US-012 — Revisar análisis SROI

Como Reviewer, quiero revisar la consistencia del análisis para detectar riesgos antes de comunicarlo.

Criterios de aceptación:
- Puedo ver narrativa, outcomes, indicadores, evidencias, proxies y filtros.
- Puedo ver alertas de Stella Validator.
- Puedo comentar.
- Puedo solicitar ajustes.
- No puedo modificar datos si mi rol es solo revisión.

### US-013 — Revisar reporte audit-ready

Como Reviewer externo, quiero consultar un reporte compartido para evaluar su trazabilidad.

Criterios de aceptación:
- Puedo acceder mediante permiso.
- Puedo ver versión del reporte.
- Puedo ver anexos y audit trail permitido.
- No puedo acceder a datos no compartidos.
- Puedo descargar PDF si tengo permiso.

## Viewer

### US-014 — Consultar Impact Deck

Como Viewer, quiero consultar una vista ejecutiva para entender resultados de impacto.

Criterios de aceptación:
- Puedo ver resumen ejecutivo.
- Puedo ver ratio SROI.
- Puedo ver SROI Readiness Score.
- Puedo ver principales evidencias y riesgos.
- No puedo editar información.

## Stella

### US-015 — Asesorar paso a paso

Como usuario, quiero que Stella explique cada paso del SROI Pipeline para trabajar con rigor.

Criterios de aceptación:
- Stella explica qué hacer.
- Stella explica por qué hacerlo.
- Stella explica para qué sirve.
- Stella explica cómo hacerlo.
- Stella usa el contexto del proyecto.
- Stella evita claims no verificables.

### US-016 — Validar riesgos

Como usuario, quiero que Stella detecte vacíos metodológicos para mejorar la calidad del análisis.

Criterios de aceptación:
- Stella detecta evidencias faltantes.
- Stella identifica proxies débiles.
- Stella advierte riesgos de atribución.
- Stella detecta outcomes ambiguos.
- Stella advierte claims excesivos.
- Stella no inventa fuentes.

### US-017 — Componer reporte

Como usuario, quiero que Stella redacte secciones del reporte audit-ready para comunicar resultados con rigor.

Criterios de aceptación:
- Stella usa datos estructurados.
- Stella diferencia hechos, supuestos y análisis.
- Stella cita proxies y evidencias disponibles en el sistema.
- Stella no inventa anexos.
- Stella produce texto editable.

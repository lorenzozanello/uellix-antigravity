# 01 — PRD: Product Requirements Document

## Producto

Uellix.

## Categoría

SaaS B2B de inteligencia de impacto social.

## Promesa

**Uellix convierte el impacto social en evidencia defendible.**

## Objetivo del MVP

Permitir que una organización cree un proyecto de impacto, estructure su cadena SROI básica, cargue evidencias, seleccione proxies financieros respaldados por fuentes oficiales, aplique filtros SROI, calcule un ratio SROI riguroso y genere un reporte audit-ready revisado por Stella.

Stella debe asesorar el proceso en cada paso, explicando:
- qué hacer;
- por qué hacerlo;
- para qué sirve;
- cómo hacerlo con rigor metodológico.

## Usuarios objetivo

### SuperAdmin

Usuario interno de Uellix con control global de la plataforma.

### OrganizationAdmin

Administrador de una organización cliente. Gestiona usuarios, proyectos, permisos y configuración.

### ImpactManager

Responsable de proyectos de impacto. Lidera la construcción metodológica del análisis.

### Analyst

Usuario que carga datos, evidencias, indicadores, proxies y cálculos.

### Reviewer

Usuario interno o externo que revisa reportes, supuestos, evidencias y trazabilidad.

### Viewer

Usuario de solo lectura. Puede consultar reportes y resultados compartidos.

## Principales módulos del MVP

### 1. Gestión de organizaciones

Permite crear y administrar organizaciones cliente.

Requisitos:
- Crear organización.
- Invitar usuarios.
- Asignar roles.
- Gestionar permisos.
- Restringir datos por organización.

### 2. Gestión de portafolios

Permite agrupar proyectos de impacto.

Requisitos:
- Crear portafolio.
- Asociar proyectos.
- Ver estado de avance.
- Ver readiness agregado.

### 3. SROI Pipeline

Guía metodológica para construir el análisis SROI.

Etapas:
1. Narrativa de impacto.
2. Resultados esperados.
3. Indicadores.
4. Evidencias.
5. Proxies financieros.
6. Filtros SROI.
7. Valor social neto.
8. Inversión.
9. Ratio SROI.
10. Revisión Stella.
11. Reporte audit-ready.

### 4. Trust Center / Trust Layer

Gestiona evidencias, hashes, metadatos, trazabilidad y audit trail.

Requisitos:
- Cargar evidencias.
- Guardar metadatos.
- Generar SHA-256.
- Asociar evidencia a outcomes/indicadores.
- Registrar cambios.
- Permitir anonimización opcional.
- Permitir archivo y eliminación con trazabilidad.
- Preparar arquitectura para anclaje externo.

### 5. Proxy Intelligence

Banco de proxies financieros con fuentes oficiales y trazabilidad.

Requisitos:
- Crear proxy.
- Sugerir proxy con Stella.
- Registrar fuente oficial.
- Registrar territorio, moneda, año, valor y metodología.
- Registrar justificación.
- Registrar nivel de confianza.
- Exigir aprobación humana.
- Evitar proxies sin fuente verificable.

### 6. Stella AI Engine

Capa IA especializada en SROI.

Roles:
- Stella Advisor.
- Stella Validator.
- Stella Composer.

Requisitos:
- Conectarse con Gemini API.
- Asesorar cada paso.
- Detectar riesgos metodológicos.
- Componer narrativas audit-ready.
- No inventar fuentes, evidencias ni proxies.
- No certificar impacto.

### 7. Impact Deck

Vista ejecutiva y reporte audit-ready.

Requisitos:
- Vista web ejecutiva.
- PDF descargable.
- Versionamiento de reportes.
- Audit trail visible.
- SROI Readiness Score.
- Secciones técnicas y ejecutivas.

### 8. Panel administrador

Requisitos:
- Gestionar organizaciones.
- Gestionar usuarios.
- Gestionar proxies globales.
- Revisar actividad.
- Consultar logs.
- Configurar fuentes y estados.

## Funcionalidades fuera de alcance inicial

Aunque pueden estar previstas en arquitectura, no deben bloquear el MVP:

- Marketplace de consultores.
- Pagos y facturación.
- Firma digital avanzada.
- Multiidioma.
- Certificación automática.
- Evaluaciones externas integradas.
- Integraciones complejas con ERP/CRM.
- Automatización total de auditorías.
- IA que tome decisiones finales sin intervención humana.

## Criterios de éxito del MVP

El MVP será exitoso si permite:

1. Crear organización y usuarios.
2. Crear proyecto de impacto.
3. Completar el SROI Pipeline.
4. Cargar evidencias con hash SHA-256.
5. Crear o seleccionar proxies con fuente oficial.
6. Aplicar filtros SROI.
7. Calcular ratio SROI.
8. Generar SROI Readiness Score.
9. Ejecutar revisión de Stella.
10. Generar Impact Deck web.
11. Descargar PDF audit-ready.
12. Ver audit trail y versiones.
13. Restringir datos por organización.
14. Desplegar en Vercel sin errores críticos.

## Restricciones críticas

- No claims de certificación automática.
- No proxies sin fuente oficial.
- No evidencias sin metadatos.
- No evidencias sin hash.
- No cambios metodológicos sin audit log.
- No exposición cruzada entre organizaciones.
- No datos sensibles sin control de permisos.
- No respuestas de Stella sin trazabilidad de contexto.

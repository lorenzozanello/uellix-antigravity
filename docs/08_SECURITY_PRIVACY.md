# 08 — Seguridad y privacidad

## Naturaleza de los datos

Uellix puede manejar datos sensibles desde el MVP, incluyendo:
- información de beneficiarios;
- datos personales;
- testimonios;
- documentos de evidencia;
- bases de datos;
- información territorial;
- resultados sociales;
- documentos institucionales;
- cálculos financieros de impacto.

## Principios

1. Minimización de datos.
2. Control de acceso por organización.
3. Permisos por rol.
4. RLS en base de datos.
5. Storage protegido.
6. Metadatos y hash para evidencias.
7. Audit log para cambios relevantes.
8. Versionamiento de reportes.
9. Anonimización opcional por proyecto/evidencia.
10. No exposición de secretos.

## Datos sensibles

Cada evidencia debe permitir marcar:
- si contiene datos sensibles;
- si requiere anonimización;
- si fue anonimizada;
- quién la cargó;
- quién la revisó;
- quién accedió a ella si aplica.

## Anonimización

La anonimización no es obligatoria para todos los proyectos. El usuario debe poder elegir según el proyecto y la naturaleza de la evidencia.

Estados sugeridos:
- not_required;
- required;
- pending;
- completed;
- rejected;
- not_applicable.

## Eliminación y archivo

Uellix debe permitir:
- archivar evidencia;
- eliminar evidencia con trazabilidad.

Si se elimina una evidencia:
- conservar audit log;
- conservar hash y metadatos mínimos si legalmente es permitido;
- registrar motivo;
- registrar usuario;
- registrar fecha.

## Hashing

Toda evidencia cargada debe tener hash SHA-256.

El hash debe usarse para:
- prueba de integridad;
- detección de cambios;
- audit trail;
- anclaje externo futuro o modular.

## External anchoring

El MVP debe preparar una arquitectura modular de anclaje externo.

Reglas:
- no acoplar el core a un proveedor específico;
- registrar hash, timestamp, proveedor y estado;
- permitir verificación posterior;
- mantener bajo costo;
- evitar dependencia técnica innecesaria.

## Stella y seguridad

Stella no debe recibir más contexto del necesario.

Reglas:
- no enviar secretos;
- no enviar archivos completos si no es necesario;
- preferir resúmenes estructurados;
- registrar contexto usado;
- advertir cuando una respuesta sea sugerencia;
- evitar dictámenes legales o certificaciones.

## Claims prohibidos

Prohibido:
- “Uellix certifica automáticamente el impacto.”
- “Uellix garantiza el impacto.”
- “Stella audita el impacto.”
- “La IA validó definitivamente el resultado.”
- “El reporte equivale a una certificación oficial.”

Permitido:
- “audit-ready”;
- “trazable”;
- “defendible”;
- “revisable”;
- “estructurado para auditoría”;
- “preparado para revisión”.

## Variables de entorno

Todas las variables deben documentarse en `.env.example`.

Nunca subir:
- claves Supabase secretas;
- Gemini API keys;
- tokens de Vercel;
- claves de proveedores de anclaje;
- credenciales personales.

## Logs

No registrar:
- contraseñas;
- tokens;
- secretos;
- documentos completos sensibles;
- datos personales innecesarios.

Sí registrar:
- acción;
- actor;
- entidad;
- antes/después cuando corresponda;
- motivo;
- timestamp;
- organización;
- proyecto.

## Revisión antes de producción

Antes de producción:
- revisar RLS;
- revisar permisos;
- revisar storage policies;
- revisar variables;
- revisar prompts de Stella;
- probar acceso cruzado entre organizaciones;
- probar eliminación/archivo;
- probar versionamiento;
- probar audit logs.

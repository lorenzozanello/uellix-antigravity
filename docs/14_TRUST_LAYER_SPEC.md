# 14 — Trust Layer Spec

## Definición

El Trust Layer es la capa de Uellix que convierte evidencias dispersas en activos trazables, verificables y audit-ready.

## Objetivos

1. Registrar evidencias.
2. Asociarlas a outcomes e indicadores.
3. Guardar metadatos.
4. Generar hash SHA-256.
5. Mantener audit trail.
6. Permitir anonimización.
7. Permitir archivo y eliminación con trazabilidad.
8. Preparar anclaje externo.
9. Soportar reportes audit-ready.

## Tipos de evidencia

- PDF.
- Excel.
- CSV.
- Imágenes.
- Word.
- Links.
- Texto/testimonios.
- Actas.
- Bases de datos.

## Metadatos requeridos

- título;
- descripción;
- tipo;
- archivo o URL;
- tamaño;
- MIME type;
- fuente;
- usuario que carga;
- fecha de carga;
- organización;
- proyecto;
- outcome asociado;
- indicador asociado;
- hash SHA-256;
- nivel de confianza;
- estado de revisión;
- estado de anonimización;
- sensibilidad;
- versión.

## Hashing

Toda evidencia con archivo debe generar SHA-256.

Para links o testimonios:
- generar hash del contenido capturado o snapshot textual;
- registrar fecha de captura;
- registrar URL o fuente.

## Estados

```txt
Uploaded
Metadata Pending
Linked
Under Review
Approved
Rejected
Archived
Deleted with Trace
```

## Anonimización

Estados:
```txt
not_required
required
pending
completed
rejected
not_applicable
```

## Archivo y eliminación

El usuario puede archivar o eliminar evidencia según permisos.

Reglas:
- archivar conserva archivo y metadatos;
- eliminar puede remover archivo del storage;
- ambos deben mantener audit log;
- si se elimina, conservar hash y metadatos mínimos si es viable;
- registrar motivo.

## Audit trail

Registrar:
- creación;
- carga;
- edición de metadatos;
- asociación a outcome/indicador;
- cambio de estado;
- revisión;
- anonimización;
- archivo;
- eliminación;
- descarga si aplica;
- inclusión en reporte.

## External anchoring

El MVP debe preparar arquitectura modular.

Datos de anclaje:
- hash;
- tipo de entidad;
- entidad;
- proveedor;
- anchor id;
- timestamp;
- status;
- verification url si aplica.

Estados:
```txt
not_anchored
pending
anchored
failed
verified
```

## Integridad

La plataforma debe poder verificar si:
- el archivo actual coincide con su hash;
- el hash anclado coincide con el hash interno;
- la evidencia fue modificada;
- la versión incluida en reporte es la correcta.

## UI Trust Center

Debe mostrar:
- lista de evidencias;
- filtros por estado;
- nivel de confianza;
- hash visible;
- asociaciones;
- timeline;
- alertas;
- acciones permitidas;
- anexos del reporte.

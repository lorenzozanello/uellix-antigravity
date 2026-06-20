# 07 — Autenticación, roles y permisos

## Proveedor

Supabase Auth.

## Principio de seguridad

Todo acceso debe estar restringido por:
- usuario autenticado;
- organización;
- rol;
- estado del recurso;
- políticas RLS;
- validación server-side.

## Roles

### SuperAdmin

Usuario interno de Uellix.

Puede:
- ver todas las organizaciones;
- crear, activar y desactivar organizaciones;
- gestionar banco global de proxies;
- ver logs globales;
- configurar parámetros del sistema;
- dar soporte técnico;
- revisar actividad.

No debe:
- modificar datos metodológicos de una organización sin registro explícito;
- acceder innecesariamente a datos sensibles sin justificación.

### OrganizationAdmin

Administrador de organización.

Puede:
- gestionar usuarios de su organización;
- crear portafolios;
- crear proyectos;
- asignar roles;
- configurar organización;
- ver todos los proyectos de su organización;
- aprobar proxies internos si se le concede permiso;
- compartir reportes.

### ImpactManager

Responsable metodológico.

Puede:
- crear y editar proyectos;
- construir narrativa;
- crear outcomes;
- revisar indicadores;
- aprobar ciertos cambios metodológicos;
- ejecutar revisión Stella;
- generar reportes;
- solicitar revisión.

### Analyst

Usuario operativo.

Puede:
- cargar evidencias;
- crear indicadores;
- proponer proxies;
- registrar filtros SROI;
- editar datos asignados;
- interactuar con Stella;
- preparar cálculos.

No puede:
- aprobar reportes finales;
- aprobar proxies globales;
- gestionar usuarios.

### Reviewer

Usuario de revisión.

Puede:
- consultar proyectos compartidos;
- revisar evidencias;
- revisar cálculos;
- comentar;
- solicitar ajustes;
- ver audit trail permitido.

No puede:
- editar cálculos salvo permiso explícito;
- borrar evidencias;
- cambiar roles;
- aprobar proxies si no tiene permiso.

### Viewer

Usuario de solo lectura.

Puede:
- ver dashboards;
- ver reportes compartidos;
- descargar PDF si tiene permiso;
- consultar resumen ejecutivo.

No puede:
- editar;
- cargar evidencias;
- modificar supuestos;
- ejecutar cambios metodológicos.

## Matriz resumida

| Acción | SuperAdmin | OrgAdmin | ImpactManager | Analyst | Reviewer | Viewer |
|---|---:|---:|---:|---:|---:|---:|
| Crear organización | Sí | No | No | No | No | No |
| Invitar usuarios | Sí | Sí | No | No | No | No |
| Crear portafolio | Sí | Sí | Sí | No | No | No |
| Crear proyecto | Sí | Sí | Sí | No/Sujeto | No | No |
| Editar narrativa | Sí* | Sí | Sí | Sí | No | No |
| Cargar evidencia | Sí* | Sí | Sí | Sí | No | No |
| Aprobar proxy | Sí | Sí | Sí/Sujeto | No | No | No |
| Aplicar filtros | Sí* | Sí | Sí | Sí | No | No |
| Generar reporte | Sí* | Sí | Sí | No/Sujeto | No | No |
| Revisar reporte | Sí | Sí | Sí | Sí | Sí | Sí lectura |
| Ver audit trail | Sí | Sí | Sí | Limitado | Limitado | No/Limitado |

`Sí*` significa que debe existir justificación y audit log si el SuperAdmin interviene en datos de cliente.

## Invitaciones

- Las organizaciones pueden invitar usuarios.
- El usuario acepta invitación por link.
- El usuario queda asociado a una sola organización en MVP.
- Invitaciones expiran.
- Invitaciones pueden revocarse.

## Usuarios externos

Los financiadores, auditores o revisores externos pueden acceder como Reviewer o Viewer.

Requisitos:
- acceso limitado;
- expiración opcional;
- token seguro;
- control de secciones visibles;
- audit log de accesos.

## Row Level Security

RLS debe garantizar:

1. Un usuario solo ve datos de su organización.
2. SuperAdmin tiene acceso controlado global.
3. Report shares permiten acceso externo restringido.
4. Storage respeta permisos por organización y proyecto.
5. Las operaciones sensibles se validan también en servidor.

## Operaciones sensibles

Deben registrar audit log:
- cambio de rol;
- eliminación o archivo de evidencia;
- aprobación de proxy;
- cambio de filtros SROI;
- generación de reporte;
- aprobación de reporte;
- cambio de estado de proyecto;
- acceso externo a reporte;
- modificación de datos sensibles.

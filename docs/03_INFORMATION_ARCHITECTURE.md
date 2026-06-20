# 03 — Arquitectura de información

## Principios

La arquitectura de información debe reflejar la cadena metodológica de Uellix:

```txt
Organización
→ Portafolios
→ Proyectos
→ SROI Pipeline
→ Trust Layer
→ Proxy Intelligence
→ Stella Review
→ Impact Deck
```

## Rutas públicas

```txt
/
 /login
 /register
 /forgot-password
 /accept-invite
 /shared/report/[token]
```

## Rutas privadas

```txt
/app
/app/dashboard
/app/organization
/app/organization/users
/app/portfolios
/app/portfolios/[portfolioId]
/app/projects
/app/projects/new
/app/projects/[projectId]
/app/projects/[projectId]/pipeline
/app/projects/[projectId]/pipeline/narrative
/app/projects/[projectId]/pipeline/outcomes
/app/projects/[projectId]/pipeline/indicators
/app/projects/[projectId]/pipeline/evidence
/app/projects/[projectId]/pipeline/proxies
/app/projects/[projectId]/pipeline/filters
/app/projects/[projectId]/pipeline/calculation
/app/projects/[projectId]/stella
/app/projects/[projectId]/impact-deck
/app/projects/[projectId]/reports
/app/projects/[projectId]/reports/[reportId]
/app/trust-center
/app/proxy-bank
/app/settings
```

## Rutas SuperAdmin

```txt
/admin
/admin/organizations
/admin/users
/admin/proxy-bank
/admin/audit-logs
/admin/system-settings
```

## Navegación principal

### Sidebar

- Dashboard
- Portafolios
- Proyectos
- Trust Center
- Proxy Bank
- Stella
- Reportes
- Configuración

### Dentro de un proyecto

- Overview
- SROI Pipeline
- Evidencias
- Proxies
- Cálculo
- Revisión Stella
- Impact Deck
- Reportes
- Audit Trail

## Estados del proyecto

```txt
Draft
In Progress
Evidence Review
Proxy Review
Calculation Review
Stella Review
Report Draft
Audit-Ready
Archived
```

## Estados del reporte

```txt
Draft
Generated
Under Review
Approved for Sharing
Archived
```

## Estados de evidencia

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

## Estados de proxy

```txt
Suggested
Pending Review
Approved
Rejected
Archived
```

## Jerarquía conceptual

```txt
Organization
  └── Portfolio
        └── Project
              ├── Impact Narrative
              ├── Outcomes
              │     ├── Indicators
              │     ├── Evidence
              │     └── Proxies
              ├── SROI Filters
              ├── Calculation
              ├── Stella Reviews
              ├── Reports
              └── Audit Logs
```

## Pantallas mínimas del MVP

1. Landing básica.
2. Login.
3. Registro o aceptación de invitación.
4. Dashboard organizacional.
5. Gestión de usuarios.
6. Lista de portafolios.
7. Lista de proyectos.
8. Crear proyecto.
9. SROI Pipeline paso a paso.
10. Trust Center del proyecto.
11. Proxy Bank.
12. Stella Panel.
13. Calculation View.
14. Impact Deck.
15. Report PDF Preview.
16. Audit Trail.
17. Admin Panel.

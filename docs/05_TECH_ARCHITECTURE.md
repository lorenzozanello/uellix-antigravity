# 05 — Arquitectura técnica

## Stack aprobado

- Framework: Next.js
- Lenguaje: TypeScript
- UI: Tailwind CSS + shadcn/ui
- Base de datos: Supabase Postgres
- Auth: Supabase Auth
- Storage: Supabase Storage
- Seguridad: Supabase Row Level Security
- ORM: Drizzle
- IA: Gemini API
- Deploy: Vercel
- Repo: GitHub nuevo y limpio

## Estructura recomendada

```txt
uellix/
  app/
    (public)/
    (auth)/
    app/
    admin/
    api/
  components/
    ui/
    layout/
    forms/
    project/
    sroi/
    evidence/
    proxies/
    stella/
    reports/
  db/
    schema/
    migrations/
    client.ts
  lib/
    auth/
    supabase/
    storage/
    stella/
    sroi/
    trust/
    proxies/
    reports/
    audit/
    permissions/
    utils/
  types/
  hooks/
  server/
  tests/
  docs/
  public/
  scripts/
  drizzle.config.ts
  middleware.ts
  .env.example
  ANTIGRAVITY.md
```

## Arquitectura lógica

```txt
Frontend Next.js
  ↓
Server Actions / Route Handlers
  ↓
Permission Layer
  ↓
Business Services
  ↓
Drizzle / Supabase
  ↓
Postgres + Storage + RLS
```

## Servicios internos

### Auth Service

Responsable de:
- sesión;
- usuario actual;
- organización actual;
- rol;
- permisos.

### Organization Service

Responsable de:
- organizaciones;
- usuarios;
- invitaciones;
- roles.

### Project Service

Responsable de:
- portafolios;
- proyectos;
- estados;
- avances.

### SROI Service

Responsable de:
- outcomes;
- indicadores;
- filtros;
- cálculo;
- fórmulas;
- supuestos.

### Evidence Service

Responsable de:
- uploads;
- metadatos;
- hashes;
- asociación con indicadores/outcomes;
- anonimización;
- archivo/eliminación con trazabilidad.

### Proxy Service

Responsable de:
- banco de proxies;
- fuentes;
- aprobación humana;
- búsqueda;
- sugerencias Stella.

### Stella Service

Responsable de:
- llamadas a Gemini;
- prompts internos;
- grounding en datos del proyecto;
- Advisor;
- Validator;
- Composer;
- logs de interacciones relevantes.

### Report Service

Responsable de:
- Impact Deck;
- PDF;
- versionamiento;
- snapshots;
- anexos.

### Audit Service

Responsable de:
- audit trail;
- cambios metodológicos;
- cambios de permisos;
- cambios de evidencia;
- versiones de reporte.

## Supabase

Se usará para:
- Postgres;
- Auth;
- Storage;
- Row Level Security;
- eventualmente Edge Functions si se justifica.

## Drizzle

Se usará para:
- schema tipado;
- migraciones;
- queries controladas;
- mejor trazabilidad de cambios de base de datos.

## Vercel

Se usará para:
- previews por rama/PR;
- despliegue de producción;
- variables de entorno;
- logs de runtime.

## Gemini API

Se usará para Stella.

La lógica de IA debe separarse del core metodológico. El cálculo SROI no debe depender de que Gemini responda correctamente. Gemini acompaña, valida y compone; no reemplaza la lógica determinística de cálculo.

## Seguridad técnica

Requisitos:
- RLS por organización.
- Validación server-side.
- Variables de entorno.
- No secretos en frontend.
- Logs sin datos sensibles innecesarios.
- Auditoría de cambios.
- Control de acceso por rol.
- Separación de tenants.

## Multi-tenancy

MVP:
- un usuario pertenece a una organización.
- una organización tiene múltiples usuarios.
- una organización tiene múltiples portafolios y proyectos.
- RLS debe impedir acceso cruzado.

No MVP:
- usuario perteneciente a múltiples organizaciones.

## Storage

Recomendación inicial:
- Supabase Storage.

Motivo:
- integra con Supabase Auth;
- permite políticas de acceso;
- reduce complejidad;
- evita meter otro proveedor en MVP.

## External anchoring

El Trust Layer debe prepararse para anclaje externo, pero debe implementarse de forma modular.

Interfaz sugerida:

```ts
interface ExternalAnchorProvider {
  anchorHash(input: AnchorInput): Promise<AnchorResult>
  getAnchorStatus(anchorId: string): Promise<AnchorStatus>
}
```

Esto permite empezar con un proveedor simple o mock verificable y luego cambiarlo sin reescribir el core.

## Comandos esperados

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:generate
pnpm db:migrate
```

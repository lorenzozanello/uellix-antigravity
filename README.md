# Uellix

**Uellix convierte el impacto social en evidencia defendible.**

Plataforma SaaS B2B de inteligencia de impacto social para organizaciones del sector social y sus financiadores. Permite cuantificar, analizar y comunicar el retorno social de inversión (SROI) de programas e intervenciones.

---

## Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Framework | Next.js 16 (App Router) |
| Lenguaje | TypeScript 5 |
| Estilos | Tailwind CSS 4 |
| Componentes UI | shadcn/ui (base-ui) |
| Base de datos | PostgreSQL via Supabase |
| Auth | Supabase Auth (SSR) |
| ORM | Drizzle ORM 0.45 |
| Testing | Vitest 4 |
| Deploy | Vercel |

---

## Estructura del proyecto

```
uellix/
├── app/
│   ├── (public)/login/      # Página de login y signup
│   ├── admin/               # Panel de Super Administrador
│   ├── app/
│   │   ├── dashboard/       # Dashboard principal
│   │   ├── onboarding/      # Creación de primera organización
│   │   └── projects/        # Proyectos SROI (scaffold)
│   └── auth/
│       ├── callback/        # OAuth callback
│       └── signout/         # Logout handler
├── db/
│   ├── client.ts            # Cliente Drizzle (postgres.js)
│   ├── schema.ts            # Definición de tablas
│   ├── migrations/          # Migraciones SQL generadas por Drizzle Kit
│   └── policies/
│       └── 001_initial_auth_rls.sql  # Políticas RLS (manual en Supabase)
├── lib/
│   ├── auth/
│   │   ├── roles.ts         # Fuente de verdad de roles (snake_case)
│   │   ├── permissions.ts   # Funciones de permisos puras
│   │   └── session.ts       # Helpers server-side de auth y contexto
│   ├── audit/
│   │   ├── logger.ts        # logAuditAction() + AUDIT_ACTIONS
│   │   └── index.ts         # Barrel export
│   └── supabase/
│       ├── server.ts        # createClient() para Server Components
│       ├── client.ts        # createClient() para Client Components
│       └── proxy.ts         # updateSession() para el proxy de Next.js
├── proxy.ts                 # Entry point del proxy (Next.js 16)
├── tests/
│   └── auth/
│       ├── roles.test.ts
│       └── permissions.test.ts
└── docs/                    # Documentación de producto y arquitectura
```

---

## Variables de entorno

Copia `.env.local.example` a `.env.local` (no existe aún — crear manualmente):

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>

# Drizzle / Postgres directo
DATABASE_URL=postgresql://postgres:<password>@db.<project>.supabase.co:5432/postgres
```

---

## Comandos

```bash
# Instalar dependencias
pnpm install

# Servidor de desarrollo
pnpm dev

# Lint
pnpm lint

# Type check
pnpm typecheck

# Tests
pnpm test

# Build de producción
pnpm build
```

---

## Setup local

1. Clonar el repositorio
2. `pnpm install`
3. Crear `.env.local` con las variables de Supabase
4. Ejecutar migraciones en Supabase (ver sección Migraciones)
5. Ejecutar políticas RLS en Supabase (ver sección RLS)
6. `pnpm dev`

---

## Migraciones

Las migraciones se generan con Drizzle Kit y se aplican en la base de datos de Supabase.

```bash
# Generar nueva migración después de cambios en db/schema.ts
pnpm db:generate

# Aplicar migraciones (requiere DATABASE_URL con permisos de escritura)
pnpm db:migrate
```

Las migraciones generadas están en `db/migrations/`. No editar manualmente.

---

## Políticas RLS

Las políticas RLS están en `db/policies/001_initial_auth_rls.sql`.

**Aplicar manualmente en el Supabase SQL Editor:**
1. Abrir el proyecto en [supabase.com](https://supabase.com)
2. Ir a SQL Editor
3. Pegar y ejecutar el contenido de `001_initial_auth_rls.sql`

El script es idempotente (`DROP POLICY IF EXISTS` antes de cada `CREATE`).

**Tablas protegidas por RLS:**
- `users` — solo puede ver/editar su propio perfil
- `organizations` — solo miembros activos o super_admin
- `organization_members` — solo miembros de la misma org (via SECURITY DEFINER)
- `invitations` — solo miembros de la org
- `audit_logs` — append-only; no UPDATE, no DELETE

---

## Roles y Permisos

Los roles están definidos en `lib/auth/roles.ts`. Todos usan `snake_case`:

| Rol | Nivel | Descripción |
|-----|-------|-------------|
| `super_admin` | 100 | Administrador global de Uellix (campo `is_super_admin` en `users`) |
| `organization_admin` | 80 | Administrador de organización |
| `impact_manager` | 60 | Gestor de impacto y proyectos |
| `analyst` | 40 | Analista con acceso de carga |
| `reviewer` | 20 | Revisor de evidencia |
| `viewer` | 10 | Solo lectura |

Los `super_admin` se identifican por el campo booleano `is_super_admin` en la tabla `users` — **no** son miembros de ninguna organización específica.

---

## Flujo Git / Vercel

- **`main`**: Producción — protegida, solo PR con aprobación
- **`develop`**: Rama de integración
- **`feature/*`**: Ramas de trabajo (ej: `feature/sprint-1-auth-organizations-roles`)
- **Vercel**: Preview automático en cada PR; producción en merge a `main`

No hacer commits directamente en `main` ni `develop`.

---

## Estado del Sprint

### Sprint 1 Hardening — ✅ Completado

| Componente | Estado |
|-----------|--------|
| Roles en `snake_case` (`lib/auth/roles.ts`) | ✅ |
| Helpers server-side de auth (`lib/auth/session.ts`) | ✅ |
| Permisos puros (`lib/auth/permissions.ts`) | ✅ |
| Migración DB (`is_super_admin`, unique constraint) | ✅ |
| Proxy/middleware limpiado | ✅ |
| `/app` protegido por auth + organización | ✅ |
| `/admin` protegido por `super_admin` | ✅ |
| Onboarding mínimo | ✅ |
| Login/signup con sync de perfil y redirect inteligente | ✅ |
| RLS hardened (sin recursión, append-only audit_logs) | ✅ |
| Audit logger tipado | ✅ |
| Tests de roles y permisos | ✅ |
| README operativo | ✅ |

### Sprint 2 — Pendiente

- Flujo completo de invitaciones (email, aceptación, expiración)
- Portafolios y proyectos SROI
- Calculadora SROI básica
- Evidence upload

---

## Riesgos conocidos

| Riesgo | Mitigación |
|--------|-----------|
| `role` es `varchar(50)` sin CHECK constraint en DB | Validación en app via `isValidRole()` + `normalizeRole()` |
| RLS policies deben aplicarse manualmente en Supabase | Script idempotente documentado |
| Signup abierto (no invite-only en MVP) | Usuario sin org es redirigido a onboarding; no puede acceder a ningún recurso |
| `is_super_admin` se setea solo via DB directo | Solo el equipo de Uellix puede elevar a super_admin |

---

## Contribución

- No commits sin revisión humana
- No agregar dependencias sin justificación explícita
- Mantener `pnpm lint`, `pnpm typecheck`, `pnpm test` en verde antes de PR
- UI en español (labels, mensajes de error, navegación)

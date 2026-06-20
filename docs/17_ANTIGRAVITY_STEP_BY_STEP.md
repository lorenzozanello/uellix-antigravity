# 17 — Paso a paso para trabajar en Antigravity

## Objetivo

Crear Uellix desde cero en un repo limpio, usando Antigravity, GitHub y Vercel.

## Fase 0 — Preparación fuera de Antigravity

### 1. Crear repositorio en GitHub

Nombre sugerido:

```txt
uellix
```

Configuración:
- privado inicialmente;
- README opcional;
- no agregar demasiadas plantillas;
- main como rama principal.

### 2. Crear proyecto en Vercel

Opciones:
- crear Vercel project después de que exista el primer commit;
- conectar con GitHub;
- activar previews por PR.

### 3. Crear proyecto en Supabase

Crear:
- Supabase project;
- guardar URL;
- guardar anon key;
- guardar service role key de forma segura;
- no pegar service role key en chats públicos.

### 4. Obtener Gemini API key

Guardar:
- `GEMINI_API_KEY`;
- modelo elegido en `GEMINI_MODEL`.

## Fase 1 — Abrir repo en Antigravity

1. Abrir Antigravity.
2. Conectar o clonar el repo nuevo.
3. Copiar `ANTIGRAVITY.md` en la raíz.
4. Copiar carpeta `/docs`.
5. Confirmar que Antigravity puede ver ambos.

## Fase 2 — Primer prompt: diagnóstico

Pegar el Prompt 01 de `18_PROMPTS_FOR_ANTIGRAVITY.md`.

Objetivo:
- que Antigravity lea contexto;
- proponga arquitectura;
- no modifique código todavía.

No aprobar instalación ni cambios hasta leer su diagnóstico.

## Fase 3 — Sprint 0

Cuando el diagnóstico sea correcto, pedir:

- inicializar Next.js;
- configurar TypeScript;
- Tailwind;
- shadcn/ui;
- pnpm;
- lint;
- typecheck;
- test básico;
- build;
- estructura base;
- `.env.example`.

Validar:
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Fase 4 — Primer commit

Cuando Sprint 0 compile:

```bash
git status
git add .
git commit -m "chore: initialize uellix foundation"
git push origin feature/sprint-0-foundation
```

Crear PR a main.

## Fase 5 — Conectar Vercel

1. Importar repo en Vercel.
2. Configurar variables de entorno.
3. Crear preview.
4. Revisar que build funcione.
5. No hacer merge si falla.

## Fase 6 — Supabase y Auth

Sprint 1:
- conectar Supabase;
- Auth;
- organizations;
- memberships;
- roles;
- RLS inicial;
- middleware de protección.

Validar acceso cruzado:
- usuario A no ve datos de usuario B;
- OrganizationAdmin no ve otra organización;
- Viewer no edita.

## Fase 7 — Desarrollo por sprints

Seguir `12_BACKLOG.md`.

Orden recomendado:
1. Foundation.
2. Auth + organizations.
3. Portfolios + projects.
4. SROI Pipeline.
5. Trust Layer.
6. Proxy Intelligence.
7. Calculation Engine.
8. Stella.
9. Impact Deck.
10. Admin + hardening.

## Fase 8 — Revisión humana por sprint

Antes de aprobar cada PR, revisar:

- preview de Vercel;
- cambios de base de datos;
- permisos;
- seguridad;
- claims;
- UX;
- documentación.

## Fase 9 — Reglas de control

Nunca aceptar:
- cambios directo en main;
- eliminación masiva sin explicación;
- nuevas dependencias sin justificación;
- IA que invente proxies;
- evidencias sin hash;
- reportes sin versión;
- cálculos sin fórmula visible;
- reportes que digan que Uellix certifica impacto.

## Fase 10 — Demo MVP

La primera demo debe mostrar:

1. Login.
2. Crear organización.
3. Crear proyecto.
4. Construir narrativa.
5. Definir outcomes.
6. Crear indicadores.
7. Cargar evidencia.
8. Hashear evidencia.
9. Seleccionar proxy oficial.
10. Aplicar filtros SROI.
11. Calcular ratio.
12. Stella Validator.
13. Impact Deck web.
14. PDF audit-ready.
15. Audit trail.

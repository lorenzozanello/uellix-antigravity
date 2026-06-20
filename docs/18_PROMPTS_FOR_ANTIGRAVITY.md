# 18 — Prompts para Antigravity

## Prompt 01 — Diagnóstico inicial sin modificar código

```md
Actúa como arquitecto senior full-stack y lead engineer de Uellix.

Uellix es una plataforma SaaS B2B de inteligencia de impacto social. Su promesa central es: “Uellix convierte el impacto social en evidencia defendible.”

Objetivo de esta sesión:
Leer la documentación del proyecto, comprender la arquitectura aprobada y proponer un plan técnico inicial sin modificar archivos todavía.

Instrucciones:
1. Lee `ANTIGRAVITY.md`.
2. Lee todos los documentos dentro de `/docs`.
3. Inspecciona el estado actual del repositorio.
4. No instales paquetes.
5. No modifiques archivos.
6. No hagas commits.
7. No borres nada.

Entrega:
- resumen ejecutivo;
- decisiones arquitectónicas identificadas;
- riesgos técnicos;
- estructura inicial recomendada;
- Sprint 0 recomendado;
- comandos de validación;
- decisiones humanas pendientes.

Restricciones:
- No usar Claude Code.
- No usar Google AI Studio.
- No presentar Uellix como certificador automático.
- Stella no inventa evidencias, fuentes ni proxies.
- Todo proxy requiere fuente oficial y aprobación humana.
- Toda evidencia requiere hash SHA-256, metadatos y audit trail.
- Todo cambio metodológico requiere audit log.
- Los reportes requieren versionamiento.
```

## Prompt 02 — Sprint 0 Foundation

```md
Actúa como lead engineer de Uellix.

Objetivo:
Implementar Sprint 0 Foundation en una rama nueva `feature/sprint-0-foundation`.

Alcance:
- Inicializar Next.js con TypeScript.
- Configurar pnpm.
- Configurar Tailwind CSS.
- Configurar shadcn/ui.
- Crear estructura base de carpetas.
- Configurar lint.
- Configurar typecheck.
- Configurar test básico.
- Configurar build.
- Crear `.env.example`.
- Crear layout público y privado mínimo.
- Crear rutas placeholder:
  - `/`
  - `/login`
  - `/app/dashboard`
  - `/app/projects`
  - `/admin`
- No implementar lógica de negocio compleja todavía.

Restricciones:
- No conectar todavía Gemini.
- No implementar cálculo SROI todavía.
- No crear tablas definitivas sin revisar schema.
- No agregar dependencias innecesarias.
- No trabajar en main.

Validación:
Ejecuta:
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

Entrega:
- archivos modificados;
- comandos ejecutados;
- errores encontrados;
- riesgos;
- siguiente paso recomendado.
```

## Prompt 03 — Supabase Auth + Multi-tenancy

```md
Actúa como lead engineer de Uellix.

Objetivo:
Implementar la base de autenticación, organizaciones, membresías, roles y seguridad multi-tenant con Supabase.

Lee antes:
- `/docs/05_TECH_ARCHITECTURE.md`
- `/docs/06_DATA_MODEL.md`
- `/docs/07_AUTH_ROLES_PERMISSIONS.md`
- `/docs/08_SECURITY_PRIVACY.md`

Alcance:
- Configurar cliente Supabase.
- Configurar Supabase Auth.
- Crear schema inicial con Drizzle:
  - users profile si aplica;
  - organizations;
  - organization_members;
  - audit_logs.
- Crear middleware de protección de rutas.
- Crear dashboard privado.
- Crear verificación de rol.
- Preparar políticas RLS.
- Crear `.env.example` actualizado.

Restricciones:
- Un usuario solo pertenece a una organización en MVP.
- No exponer service role key al frontend.
- No permitir acceso cruzado entre organizaciones.
- Todo cambio de rol debe auditarse.

Validación:
- usuario no autenticado no entra a `/app`;
- usuario autenticado solo ve su organización;
- build exitoso.
```

## Prompt 04 — Portafolios y proyectos

```md
Objetivo:
Implementar portafolios y proyectos de impacto.

Alcance:
- CRUD de portafolios.
- CRUD de proyectos.
- Estados de proyecto.
- Vista de proyecto.
- Navegación interna de proyecto.
- Audit log para creación y cambios relevantes.

Reglas:
- Todo proyecto pertenece a una organización.
- Un proyecto puede pertenecer a un portafolio.
- No exponer proyectos entre organizaciones.
```

## Prompt 05 — SROI Pipeline Core

```md
Objetivo:
Implementar el core del SROI Pipeline.

Alcance:
- Stepper del pipeline.
- Narrativa de impacto.
- Stakeholders.
- Outcomes.
- Indicadores.
- Validaciones.
- Persistencia.
- Stella Advisor contextual inicial.

Reglas:
- Cada paso debe explicar qué, por qué, para qué y cómo.
- No calcular SROI todavía.
- No inventar metodología.
- Registrar cambios importantes.
```

## Prompt 06 — Trust Layer

```md
Objetivo:
Implementar Trust Layer para evidencias.

Alcance:
- Supabase Storage.
- Upload de archivos.
- Hash SHA-256.
- Metadatos.
- Asociación con outcome/indicador.
- Estados de revisión.
- Anonimización opcional.
- Archivo y eliminación con trazabilidad.
- Audit timeline.

Reglas:
- No evidencia sin hash.
- No evidencia sin organización y proyecto.
- Storage protegido.
- Todo archivo/eliminación queda auditado.
```

## Prompt 07 — Proxy Intelligence

```md
Objetivo:
Implementar banco de proxies financieros.

Alcance:
- Fuentes de proxies.
- CRUD de proxies.
- Búsqueda y filtros.
- Estados de aprobación.
- Asociación proxy-outcome.
- Sugerencias Stella preparadas.
- Validación de fuente oficial.

Reglas:
- No aprobar proxy sin fuente.
- No usar proxy rechazado.
- Stella no aprueba proxies.
- Todo proxy usado en cálculo debe quedar en snapshot.
```

## Prompt 08 — SROI Calculation Engine

```md
Objetivo:
Implementar motor de cálculo SROI.

Alcance:
- Inversión.
- Cantidades.
- Valor bruto.
- Deadweight.
- Attribution.
- Displacement.
- Drop-off.
- Duración.
- Tasa de descuento.
- Valor social neto.
- Ratio SROI.
- Fórmulas visibles.
- Snapshot y versionamiento.

Reglas:
- El cálculo debe ser determinístico.
- Gemini no calcula el resultado final.
- Todo ajuste requiere justificación.
- Todo cambio metodológico se audita.
```

## Prompt 09 — Stella Engine

```md
Objetivo:
Implementar Stella Advisor, Validator y Composer con Gemini API.

Lee:
- `/docs/13_STELLA_AI_SPEC.md`

Alcance:
- Configurar Gemini.
- Crear prompts internos versionados.
- Implementar Advisor por paso.
- Implementar Validator estructurado.
- Implementar Composer para secciones de reporte.
- Guardar interacciones relevantes.
- Crear guardrails.

Reglas:
- Stella no inventa fuentes.
- Stella no inventa evidencias.
- Stella no certifica impacto.
- Stella no aprueba proxies.
- Stella debe declarar limitaciones.
```

## Prompt 10 — Impact Deck y PDF

```md
Objetivo:
Implementar Impact Deck y PDF audit-ready.

Alcance:
- Vista web ejecutiva.
- Secciones del reporte.
- PDF descargable.
- Report versioning.
- SROI Readiness Score.
- Anexos.
- Audit trail.
- Compartir con Reviewer/Viewer.

Reglas:
- Reporte versionado.
- No claims de certificación.
- Mostrar fuentes y limitaciones.
- Mostrar revisión Stella.
```

## Prompt 11 — Admin Panel + Hardening

```md
Objetivo:
Implementar panel de administración y endurecimiento de seguridad.

Alcance:
- SuperAdmin panel.
- Gestión de organizaciones.
- Gestión de proxies globales.
- Audit logs.
- Revisión RLS.
- QA de permisos.
- QA de storage.
- Corrección de bugs.

Reglas:
- No exposición cruzada.
- No acciones sensibles sin audit log.
- No secretos en frontend.
```

# Guía para Agentes de IA en Uellix

Para todo desarrollo en este repositorio, la guía operativa canónica es
[CLAUDE.md](CLAUDE.md), en la raíz de este mismo repositorio.

Esta reconciliación es prospectiva, bajo la autoridad HPO-ODS-01
(`docs/ops/ods/ODS_V1_AUTHORITY_v1.0.0.json`): no reescribe evidencia
histórica ni reabre ninguna decisión previamente cerrada.

## Restricciones y Stack de Uellix:
- **Entorno de Desarrollo Autorizado:** Claude Code Desktop/CLI (primario, HPO-ODS-01), GitHub y Vercel. Antigravity puede seguir usándose como herramienta auxiliar acotada, nunca como ancla única de autoridad.
- **No autorizado:** Google AI Studio como entorno de desarrollo, salvo adjudicación separada.
- **Stack Tecnológico Aprobado:** Next.js, TypeScript, Tailwind CSS, shadcn/ui, Supabase, Drizzle ORM, Gemini API, Vercel y GitHub.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

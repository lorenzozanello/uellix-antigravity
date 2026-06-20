# 09 — APIs e integraciones

## Integraciones MVP

### Supabase

Uso:
- Postgres;
- Auth;
- Storage;
- RLS.

Variables esperadas:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

La service role key nunca debe exponerse al frontend.

### Gemini API

Uso:
- Stella Advisor;
- Stella Validator;
- Stella Composer.

Variables:
- `GEMINI_API_KEY`
- `GEMINI_MODEL`

Reglas:
- Stella no calcula SROI de forma definitiva.
- Stella no inventa fuentes.
- Stella no inventa evidencias.
- Stella debe trabajar con datos estructurados del sistema.
- Los prompts internos deben versionarse.

### Vercel

Uso:
- previews;
- producción;
- variables de entorno;
- logs.

### External Anchoring Provider

Uso:
- anclar hashes de evidencias/reportes de forma modular.

Estado:
- requerido arquitectónicamente desde MVP;
- proveedor específico por definir según costo, confiabilidad y facilidad.

Interfaz esperada:
- enviar hash;
- recibir anchor id;
- consultar estado;
- verificar timestamp.

## Integraciones de datos para proxies

Fuentes prioritarias:
- World Bank Data API;
- OECD Data API;
- UNDP datasets;
- WEF reports/datasets;
- United Nations data;
- IDB/BID datasets;
- CEPAL datasets;
- entidades estadísticas nacionales;
- ministerios o entidades públicas verificables.

MVP:
- banco de proxies curado manualmente;
- trazabilidad completa;
- posibilidad futura de integraciones programáticas.

## Integraciones futuras

- Email transaccional.
- Analytics.
- Billing.
- Firma digital.
- CRM.
- Webhooks.
- Integraciones con sistemas de gestión documental.
- Integración con repositorios oficiales de datos.
- Exportación avanzada a Excel.
- API pública para clientes enterprise.

## Reglas de integración

Antes de agregar una integración, documentar:
- propósito;
- datos transmitidos;
- variables de entorno;
- costo;
- riesgos;
- cumplimiento;
- impacto en seguridad;
- estrategia de fallback.

## API interna sugerida

Rutas o server actions para:

- organizations;
- memberships;
- portfolios;
- projects;
- narratives;
- outcomes;
- indicators;
- evidence;
- proxies;
- sroi-filters;
- calculations;
- stella;
- reports;
- audit-logs.

## Versionamiento

Las respuestas de Stella, reportes y cálculos deben tener versión o snapshot para garantizar trazabilidad.

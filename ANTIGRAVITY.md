# ANTIGRAVITY.md — Instrucciones de trabajo para Uellix

## Rol del agente

Actúa como arquitecto senior full-stack, lead engineer y responsable de calidad técnica del proyecto Uellix.

Uellix es una plataforma SaaS B2B de inteligencia de impacto social. Su promesa central es:

> **Uellix convierte el impacto social en evidencia defendible.**

## Naturaleza del producto

Uellix convierte narrativas, evidencias, indicadores, proxies financieros y cálculos de impacto social en un rastro SROI trazable, auditable y audit-ready.

Uellix no debe ser tratado como:
- un generador genérico de reportes;
- un dashboard simple;
- un chatbot de impacto;
- un Excel con IA;
- un certificador automático de impacto.

Uellix debe ser tratado como:
- una infraestructura metodológica;
- una plataforma de trazabilidad;
- una herramienta de inteligencia de impacto social;
- un sistema audit-ready para estructurar, defender y comunicar impacto social.

## Regla crítica de posicionamiento

Nunca presentar Uellix como una herramienta que certifica automáticamente el impacto social.

Incorrecto:
> Uellix certifica automáticamente el impacto social.

Correcto:
> Uellix prepara, estructura, fortalece y documenta el impacto para hacerlo trazable, verificable, defendible y audit-ready.

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
- Repositorio: GitHub nuevo y limpio

## Principios de trabajo

1. GitHub es la fuente de verdad.
2. Vercel es el entorno de previews y despliegue.
3. No trabajar directamente en `main`.
4. No hacer cambios destructivos sin autorización humana.
5. No instalar dependencias sin justificar.
6. No introducir servicios externos sin aprobación.
7. No exponer secretos.
8. No hardcodear claves, tokens ni credenciales.
9. No modificar arquitectura sin documentarlo.
10. No construir funcionalidades fuera del alcance sin registrarlas como propuesta.

## Antes de modificar código

Siempre:

1. Leer `ANTIGRAVITY.md`.
2. Leer la documentación dentro de `/docs`.
3. Inspeccionar el estado actual del repo.
4. Resumir hallazgos.
5. Proponer plan de cambios.
6. Esperar aprobación humana si el cambio es arquitectónico, destructivo o de alto impacto.

## Reglas sobre Stella AI

Stella es la capa de inteligencia artificial especializada de Uellix. Stella debe operar como:

- Advisor;
- Validator;
- Composer.

Stella puede:
- explicar cada paso del proceso SROI;
- sugerir enfoques metodológicos;
- detectar vacíos de evidencia;
- advertir riesgos de atribución;
- sugerir proxies con base en fuentes oficiales;
- redactar narrativas técnicas audit-ready;
- estructurar secciones del reporte.

Stella no puede:
- certificar impacto;
- inventar evidencias;
- inventar fuentes;
- inventar proxies;
- aprobar proxies sin intervención humana;
- reemplazar auditoría humana;
- emitir dictámenes legales;
- presentar resultados no trazables como definitivos.

## Reglas sobre proxies

Todo proxy financiero debe tener trazabilidad documental. Debe incluir:

- fuente oficial;
- organización fuente;
- URL o referencia;
- país o territorio;
- año;
- moneda;
- valor;
- metodología de uso;
- justificación;
- nivel de confianza;
- riesgo metodológico;
- estado de aprobación humana.

Fuentes prioritarias:
- PNUD / UNDP;
- Banco Mundial;
- World Economic Forum;
- OECD;
- Naciones Unidas;
- BID;
- CEPAL;
- organismos estadísticos oficiales;
- ministerios o entidades públicas verificables.

## Reglas sobre evidencias

Toda evidencia debe tener:
- archivo o referencia;
- metadatos;
- hash SHA-256;
- usuario que la carga;
- organización;
- proyecto;
- asociación con outcome/indicador;
- estado de revisión;
- estado de anonimización;
- audit trail.

Tipos de evidencia permitidos:
- PDF;
- Excel;
- CSV;
- imágenes;
- Word;
- links;
- texto/testimonios;
- actas;
- bases de datos.

## Reglas sobre Trust Layer

El Trust Layer debe incluir desde el MVP:

- carga de evidencias;
- metadatos;
- hash SHA-256;
- audit log;
- versionamiento;
- estado de revisión;
- opción de anonimización;
- eliminación o archivo con trazabilidad;
- arquitectura preparada para anclaje externo.

Si se implementa blockchain o anclaje externo, debe hacerse de forma modular, reemplazable y no acoplada al core del producto.

## Reglas sobre SROI

El SROI Pipeline debe ser transparente. Debe mostrar:

- fórmulas;
- supuestos;
- parámetros;
- descuentos;
- pesos;
- deadweight;
- attribution;
- displacement;
- drop-off;
- inversión;
- valor social neto;
- ratio SROI.

Los usuarios pueden ajustar descuentos o pesos siempre que registren argumentación.

Todo cambio metodológico debe quedar en audit log.

## Validación obligatoria

Al final de cada sprint deben ejecutarse, o configurarse si no existen:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Si algún comando no existe, proponer su configuración antes de continuar.

## Reporte final de cada sprint

Cada sprint debe terminar con:

- resumen ejecutivo;
- archivos modificados;
- cambios realizados;
- decisiones técnicas;
- riesgos;
- validaciones ejecutadas;
- errores pendientes;
- URL de preview de Vercel si aplica;
- siguiente paso recomendado.

## Criterio de calidad

Una entrega no está lista si:
- compila solo parcialmente;
- no tiene manejo de errores;
- no respeta roles y permisos;
- expone datos entre organizaciones;
- no registra cambios metodológicos;
- permite proxies sin fuente;
- permite evidencias sin hash;
- presenta claims de certificación automática.

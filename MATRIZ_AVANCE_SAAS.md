# Matriz de avance hacia SaaS comercial — Uellix

**Fecha:** 2026-07-24 · **Rama:** `codex/beta-stabilization` (`fbe2afe`)
**Base metodológica:** ponderación por importancia para la operación comercial, no promedio simple. Evidencia en `AUDITORIA_ESTADO_ACTUAL.md`.

---

## 1. Criterio de puntuación

Cada componente se puntúa contra su **estado terminal** (lo que debe ser para operar comercialmente), no contra el sprint actual.

| Rango | Significado |
|---|---|
| 90–100 % | Terminado y verificado; sólo mantenimiento |
| 70–89 % | Funciona; brechas acotadas y conocidas |
| 40–69 % | Parcial; utilizable con supervisión, no autónomo |
| 15–39 % | Diseñado o iniciado, no conectado end-to-end |
| 0–14 % | Inexistente |

Ninguna puntuación se otorga por existencia de código.

**Salvedad sobre el nivel de evidencia.** `AUDITORIA_ESTADO_ACTUAL.md` §4 clasifica cada funcionalidad como **E1 (ejecutada)**, **E2 (probada automáticamente)** o **E3 (sólo leída)**. Los porcentajes de esta matriz combinan los tres niveles, porque una funcionalidad con pruebas verdes merece más de cero aunque no se haya recorrido por la interfaz. Pero conviene saber dónde la confianza es menor:

| Componente | Nivel predominante | Lectura |
|---|---|---|
| Producto núcleo, Backend, Base de datos, Auth, Reportes, Seguridad | E1 / E2 | Porcentajes respaldados por ejecución real |
| Pruebas, Frontend | E1 | Medidos directamente |
| **Administración** | **E3** | **El panel no se ejercitó**; sólo se verificó que niega el acceso. El 65 % es la estimación menos respaldada de la matriz |
| **Integraciones** (Stella) | **E2** | Stella estuvo desactivada; **no hubo ninguna llamada real a Gemini** |
| Observabilidad, Infraestructura, Comercial, Documentación | E3 | Evaluados por configuración y código, no por operación |

---

## 2. Matriz ponderada

| # | Componente | Peso | % actual | Aporte | Evidencia | Brecha | Condición para llegar al 100 % |
|---|---|---:|---:|---:|---|---|---|
| 1 | **Producto y funcionalidades núcleo** (pipeline SROI) | 15 | **85** | 12,75 | Recorrido E2E completo; SROI 3,770550 reproducido a mano; `checkCalculationReadiness` con 11 bloqueos; corridas inmutables por disparador | Sin descarga de evidencia (PROD-03); reporte publicable vacío (PROD-01); secciones sin autogenerar | Descarga/previsualización de evidencia + compuerta de completitud antes de bloquear + prellenado de secciones desde los datos del pipeline |
| 2 | **Frontend y experiencia de usuario** | 10 | **55** | 5,50 | 15 páginas con `EmptyState`; responsive verificado a 375 px sin desbordamiento; `aria-live` en 14 archivos | Onboarding termina en 404; miembros atrapados; **cero `loading.tsx`**; sin `not-found.tsx`; toasts en 2 de ~40 mutaciones; errores en inglés; enlace roto `/app/organization` | Corregir UX-01/02/03; añadir estados de carga y 404 propio; retroalimentación en toda mutación; auditoría de textos ES |
| 3 | **Backend y lógica de negocio** | 11 | **85** | 9,35 | `sroi-calculation.ts` con `decimal.js`; autorización consistente en la capa de servicios; Zod en todos los límites | Acciones de servidor lanzan sin contrato de error; `page.tsx` de 1 126 líneas; sin `revalidatePath` en varias acciones | Contrato tipado de error en acciones; descomponer los 3 componentes monolíticos |
| 4 | **Base de datos** | 9 | **88** | 7,92 | 37 tablas, 41 migraciones, `drizzle-kit check` sin drift; CHECK y constraints de coherencia ricos; inmutabilidad por disparador; `numeric` en todo el dinero | `db:migrate:local` falla en silencio (DB-01); acoplamiento de orden entre 3 conjuntos de migraciones; falta índice en `audit_logs.reason` | Bootstrap reproducible en un comando; orquestador único de migraciones; índice faltante |
| 5 | **Autenticación y permisos** | 10 | **80** | 8,00 | 307 en rutas protegidas (verificado con `curl`); 28/28 tests RLS; 6 roles con CHECK en BD; `/admin` niega a `organization_admin` | Contraseña mínima de 6 sin complejidad; verificación de email no confirmable; sin MFA; borrado GDPR no implementado | Política de contraseñas + verificación de email obligatoria + MFA opcional + flujo de erasure |
| 6 | **Administración** | 4 | **65** | 2,60 | 7 pantallas funcionales: orgs, logs, proxies, allowlist, cuotas, borrados | Sin gestión de usuarios; sin soporte/impersonación; sin métricas; lenguaje visual divergente | Pantalla de usuarios + herramientas de soporte + unificación visual con la app |
| 7 | **Integraciones** (Stella, FX, email, Stripe) | 6 | **55** | 3,30 | Stella con cuotas/rate-limit/guardarraíles/Zod; FX con oráculo TRM y caché; Resend operativo | Stripe sin checkout (BIZ-01); 3 roles de Stella desactivados; una sola plantilla de correo | Checkout completo + activar roles pendientes + juego completo de correos transaccionales |
| 8 | **Reportes y exportación** | 8 | **70** | 5,60 | Reporte bloqueado, hash emitido, página pública y PDF de 3 páginas generados y descargados | Títulos del PDF en inglés y malformados («Theory Of_change»); sin compuerta de completitud; publicación automática sin consentimiento; anexo de estándares siempre vacío en el PDF público | PDF usando `SECTION_META`; compuerta de completitud; control explícito de publicación con revocación |
| 9 | **Pruebas** | 6 | **60** | 3,60 | 1 027 unitarias en 78 archivos, todas verdes; 28 de integración/RLS verdes en entorno correcto | **Sin E2E**; integración fuera de CI y apuntando a producción por defecto; aserciones comentadas en `report-checkbox.test.ts` | Playwright con el camino dorado + integración en CI contra Supabase efímero + guarda de host |
| 10 | **Seguridad** | 9 | **62** | 5,58 | Headers completos verificados en HTTP real; firma de webhook; tokens hasheados; sin fugas cruzadas en 6 rutas | **4 CVE altas en Next.js + 1 en PostCSS**; RLS duplicada y divergente; re-ejecutar `0033` rompe la evidencia; rate limit inefectivo o desactivable en silencio | Actualizar dependencias; fuente única de RLS; migraciones idempotentes; rate limiting distribuido obligatorio |
| 11 | **Infraestructura y despliegue** | 4 | **70** | 2,80 | Vercel operativo; build de producción verde; `SUPABASE_MIGRATION_GATE.md` | Sin Supabase de preview aislado (gate #1 del propio equipo); CI sin integración/audit/E2E/migraciones | Preview aislado + CI completo + evidencia de backup/rollback |
| 12 | **Observabilidad** | 3 | **45** | 1,35 | Sentry inicializado en cliente/servidor/edge; `onRequestError` activo; `audit_logs` de nivel auditoría | **`captureException` nunca se invoca**; boundaries sólo hacen `console.error`; sin logging estructurado; sin alertas | Captura explícita en boundaries y acciones + logs estructurados + alertas sobre tasa de error |
| 13 | **Preparación comercial SaaS** | 3 | **20** | 0,60 | Webhook de Stripe funcional; columnas de suscripción; cuota de Stella por plan | **Sin checkout** → imposible cobrar; sin límites sobre proyectos/usuarios/almacenamiento; sin dunning, facturas, prueba gratuita, ni analítica | Ciclo completo: pricing → checkout → suscripción → límites aplicados → dunning → cancelación |
| 14 | **Documentación y operación** | 2 | **50** | 1,00 | 18 documentos de producto/arquitectura + 6 auditorías previas + `PM_MANUAL.md` | README describe el producto de hace 39 migraciones e **instruye un paso que degrada la seguridad**; sin runbooks de incidente | README reescrito + ADR de la decisión «la app omite RLS» + runbooks |
| | **TOTAL** | **100** | | **69,95** | | | |

### **Avance ponderado global: 70 %**

---

## 3. Por qué no es un promedio simple

El promedio aritmético de las 14 puntuaciones sería **64 %**. La ponderación lo eleva a **70 %** porque los componentes con más peso (producto núcleo 15, backend 11, auth 10, base de datos 9) son precisamente los mejor resueltos, mientras que los más débiles (comercial 20 %, observabilidad 45 %) tienen peso bajo.

**Esa diferencia es exactamente el diagnóstico:** Uellix invirtió su esfuerzo donde es difícil e irreversible (metodología, integridad de datos, aislamiento) y no donde es rutinario pero imprescindible para vender (checkout, límites, onboarding sin 404). Es un perfil de riesgo **favorable** — lo pendiente es trabajo conocido y acotado, no arquitectura por rehacer.

---

## 4. Preparación por escenario

La preparación no es el avance global: es el porcentaje de lo que *ese escenario concreto* exige.

| Escenario | % | Puede hacerse hoy | No puede hacerse hoy | Trabajo para cerrar |
|---|---:|---|---|---|
| **Demo controlada** (operador experto, datos presembrados, guion fijo) | **90 %** | Pipeline completo, cálculo, reporte, verificación pública, PDF | Improvisar fuera del guion; mostrar el onboarding | ~1 día: datos semilla + guion que evite UX-01 |
| **Piloto con usuarios** (2-3 orgs, acompañamiento cercano) | **72 %** | Todo el pipeline con soporte humano al lado | Que un invitado entre solo; que un revisor abra evidencia | **Fase 0 + F2-02** (7 días-persona ≈ 1 semana) |
| **Beta privada** (usuarios invitados, autonomía, seguimiento) | **62 %** | — | Autonomía real: onboarding, evidencia, errores comprensibles, seguridad al día | **Escenario B** (62,0 días-persona ≈ 8 semanas con 2 devs) |
| **Producción** (usuarios reales, sin acompañamiento) | **45 %** | — | Observabilidad, backups probados, E2E, respuesta a incidentes | **Escenario B + resto de Fase 5 + F6-02/04/05/06** (74,5 días-persona ≈ 9 semanas) |
| **Comercialización SaaS** (cobro, autoservicio, soporte) | **25 %** | — | Cobrar. Literalmente no existe el camino | **Escenario C** (92,5 días-persona ≈ 12 semanas) |

Los tres escenarios están **cerrados en dependencias**: se verificó recorriendo el grafo del CSV que ningún elemento incluido depende de otro excluido.

---

## 5. Los movimientos de mayor retorno

**Cada Δ está derivado, no asertado.** La fórmula es `Δ = Σ (peso_componente × variación_en_puntos_porcentuales / 100)`, usando los pesos de la matriz de §2. La columna «derivación» permite recalcular cada cifra.

Ordenados por **puntos ponderados ganados por día-persona**.

| # | Tareas | Acción | Esfuerzo | Derivación del Δ | Δ | Δ/día |
|---|---|---|---:|---|---:|---:|
| 1 | F0-01 | Actualizar `next` ≥ 16.2.11 y `postcss` ≥ 8.5.12 (SEC-01) | 0,5 d | Seguridad 62→74 (9 × 12/100) | **+1,08** | **2,16** |
| 2 | F0-05 | Guarda de host en seeds y pruebas de integración (OPS-01) | 0,5 d | Pruebas 60→68 (6 × 8/100) + BD 88→90 (9 × 2/100) | **+0,66** | **1,32** |
| 3 | F0-02 + F0-03 | Corregir el 404 de onboarding y la trampa del no-administrador (UX-01, UX-02) | 1,0 d | Frontend 55→63 (10 × 8/100) + Producto 85→87 (15 × 2/100) | **+1,10** | **1,10** |
| 4 | F1-01 | Descarga y previsualización de evidencia (PROD-03) | 2,0 d | Producto núcleo 85→90 (15 × 5/100) | **+0,75** | 0,38 |
| 5 | F2-02 | Migraciones idempotentes (SEC-03) | 2,0 d | BD 90→95 (9 × 5/100) + Seguridad 74→76 (9 × 2/100) | **+0,63** | 0,32 |
| 6 | F0-04 | Reparar el bootstrap de base de datos (DB-01) | 2,0 d | BD 88→92 (9 × 4/100) | **+0,36** | 0,18 |

**Total: 8,0 días-persona → +4,58 puntos ponderados (70,0 % → 74,5 %).**

Lo relevante no es el delta numérico sino que **estos seis movimientos cierran los cinco bloqueadores P0 completos** (SEC-01, OPS-01, UX-01, UX-02, DB-01) más el P0 de integridad de migraciones (SEC-03). F0-04 aparece último por ratio, pero es **habilitador**: sin un bootstrap reproducible no se puede validar ningún cambio de F2-02 ni de la Fase 2 entera.

**Mejor inversión fuera de P0:** F3-01 + F3-02 (contrato tipado de error + boundary en español) — 5,0 días-persona, Frontend 63→71 (10 × 8/100) + Backend 85→89 (11 × 4/100) = **+1,24**, ratio 0,25. Su ratio es bajo pero condiciona la calidad de todo lo que se construya después, incluida la Fase 4 completa.

---

## 6. Lo que esta matriz no puede afirmar

Se declara explícitamente, conforme al requisito de objetividad:

- **Copias de seguridad y recuperación:** *No verificable con el entorno, las credenciales o la información disponible.* Es configuración del panel de Supabase, no del repositorio.
- **Confirmación de correo en producción:** *No verificable.* `supabase/config.toml` sólo gobierna el entorno local (`enable_confirmations = false`); el ajuste real vive en el panel.
- **Entrega real de correos (invitaciones, reseteo):** *No verificable.* Requiere dominio verificado en Resend y una bandeja real.
- **Rendimiento bajo carga:** *No verificable.* No se ejecutaron pruebas de carga; no existen en el repositorio.
- **Estado de las políticas RLS en la base de producción:** *No verificable.* Se demostró la divergencia sobre una base local; qué variante está activa hoy en producción depende de qué scripts se ejecutaron y en qué orden, y no hay registro de ello.
- **Cobertura de código:** *No verificable.* No hay configuración de cobertura en `vitest.config.ts`; el conteo de 1 027 pruebas mide cantidad, no cobertura.

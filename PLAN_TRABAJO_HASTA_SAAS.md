# Plan de trabajo hasta SaaS comercial — Uellix

**Fecha:** 2026-07-24 · **Base:** `AUDITORIA_ESTADO_ACTUAL.md` · **Backlog operativo:** `BACKLOG_SAAS.csv`
**Punto de partida:** 70 % de avance ponderado (`MATRIZ_AVANCE_SAAS.md`)

---

## 1. Estrategia de ejecución

### 1.1 Principio rector

Uellix no necesita rehacer arquitectura. Necesita **terminar el producto que rodea a un motor ya terminado**. Por eso el plan no propone refactorizaciones amplias: propone cerrar huecos acotados en un orden que maximiza la reducción de riesgo por semana.

### 1.2 Tres reglas de secuenciación

1. **Primero lo que impide operar, no lo que impide vender.** Un producto que no se puede usar tampoco se puede vender. Fase 0 antes que Fase 4, aunque Fase 4 sea la que genera ingresos.
2. **La seguridad de plataforma va primero dentro de cada fase.** Actualizar dependencias con CVE altas cuesta medio día y elimina cuatro vulnerabilidades en la capa de autorización. No hay ninguna tarea con mejor retorno.
3. **Nada se declara terminado sin evidencia de ejecución.** La *Definition of Done* (§8) exige salida de comando o captura, no revisión de código.

### 1.3 Forma del equipo

El plan asume un equipo pequeño y está dimensionado para **2 personas a tiempo completo** más apoyo puntual:

| Perfil | Dedicación | Responsable de |
|---|---|---|
| **Full-stack senior** | 100 % | Fases 0, 1, 4 (núcleo, producto, monetización) |
| **Full-stack / Frontend** | 100 % | Fases 3, 5 (UX, calidad) |
| **DevOps / Plataforma** | 30 % | Fases 2, 6 (seguridad de infra, CI/CD, despliegue) |
| **Product / Metodología** | 20 % | Criterios de aceptación de reportes y compuertas metodológicas |
| **Legal externo** | puntual | F6-05 |

Con un solo desarrollador, multiplicar los plazos por **1,8** (no por 2: buena parte del trabajo es secuencial de todas formas).

### 1.4 Ritmo y checkpoints

Sprints de una semana. Al final de cada fase, un **gate explícito** con evidencia ejecutable. Ninguna fase avanza con gates de la anterior abiertos, con una excepción deliberada: **Fase 3 y Fase 4 se solapan** (§7), porque la UX y la monetización tocan superficies casi disjuntas.

---

## 2. Fases

### Fase 0 — Bloqueadores críticos

**Objetivo:** que el producto se pueda ejecutar, probar y usar sin trampas.
**Duración:** 5 días-persona (7,0 contando `F2-02`, priorizada como P0 — ver §4) · **Tareas:** F0-01 … F0-07
**Gate de salida:** un usuario nuevo completa el onboarding sin error; `pnpm db:setup:local` funciona desde cero; `pnpm audit --prod` sin severidad alta; ningún script alcanza producción sin intención explícita.

| ID | Tarea | Días | Por qué es P0 |
|---|---|---:|---|
| F0-01 | Actualizar `next` ≥ 16.2.11 y `postcss` ≥ 8.5.12 | 0,5 | 4 CVE altas, incl. bypass de proxy y SSRF en Server Actions |
| F0-02 | Redirección post-onboarding a `/app/dashboard` | 0,25 | Toda organización nueva ve un 404 como primera experiencia |
| F0-03 | Desbloquear a miembros no administradores | 0,75 | Todo invitado no-admin queda atrapado sin salida |
| F0-04 | Reparar `db:migrate:local` + orquestador de migraciones | 2 | Bootstrap local roto; 7 migraciones sin aplicar en silencio |
| F0-05 | Guarda de host en seeds y tests de integración | 0,5 | Riesgo demostrado de escritura accidental en producción |
| F0-06 | Eliminar `complete-agua-san-bernardo.ts` y limpiar huérfanos | 0,5 | Script con UUIDs de producción codificados |
| F0-07 | `pnpm audit --prod` como paso bloqueante en CI | 0,5 | Evita que SEC-01 se repita |

### Fase 1 — Núcleo funcional

**Objetivo:** que el producto entregue íntegra su propuesta de valor — evidencia defendible, no una plantilla vacía.
**Duración:** 15 días-persona · **Tareas:** F1-01 … F1-08
**Gate de salida:** un revisor puede abrir cada archivo de evidencia; un reporte incompleto **no** puede bloquearse; publicar es una decisión explícita y revocable; el PDF sale en español con secciones prellenadas.

| ID | Tarea | Días |
|---|---|---:|
| F1-01 | Descarga y previsualización de evidencia con URL firmada | 2 |
| F1-02 | Compuerta de completitud antes de bloquear un reporte | 2 |
| F1-03 | Publicación pública explícita, revocable y con expiración | 2 |
| F1-04 | Prellenado de secciones desde los datos del pipeline | 3 |
| F1-05 | Títulos del PDF desde `SECTION_META` | 0,5 |
| F1-06 | Anexo de estándares en el PDF público | 1 |
| F1-07 | Guía y advertencia de atribución por financiador | 1,5 |
| F1-08 | Multi-organización por usuario | 3 |

### Fase 2 — Integridad, permisos y seguridad

**Objetivo:** que los datos de una organización sean inalcanzables para otra por construcción, y que la seguridad no dependa del orden en que alguien ejecutó unos scripts.
**Duración:** 17,5 días-persona · **Tareas:** F2-01 … F2-14
**Gate de salida:** una única fuente de verdad para RLS; re-aplicar cualquier migración en cualquier orden deja el sistema funcional; ningún fallo de autorización produce un 500.

| ID | Tarea | Días |
|---|---|---:|
| F2-01 | Fuente única de RLS — retirar `db/policies` duplicado | 2 |
| F2-02 | Migraciones idempotentes + test de bootstrap limpio | 2 |
| F2-03 | `403`/`404` consistentes en fallos de autorización | 1,5 |
| F2-04 | Rate limiting distribuido obligatorio, *fail-closed* | 1,5 |
| F2-05 | Proteger `/api/marketing/lead` (CAPTCHA + límite + dedup) | 1 |
| F2-06 | Rate limit y caché para el PDF público | 1 |
| F2-07 | Validación de archivos por bytes mágicos + antivirus | 2 |
| F2-08 | Rol y auditoría en `/api/proxies/[id]/suggest` | 0,5 |
| F2-09 | Escapar comodines en búsqueda de proxies | 0,25 |
| F2-10 | Flujo GDPR de borrado de usuario | 2 |
| F2-11 | Política de contraseñas + verificación de email obligatoria | 1,5 |
| F2-12 | Índice y constraint de idempotencia del webhook | 0,5 |
| F2-13 | Compuerta de onboarding en el servidor | 0,75 |
| F2-14 | ADR «la aplicación omite RLS» + tests de aislamiento | 1 |

### Fase 3 — Experiencia de usuario

**Objetivo:** que el producto sea usable sin acompañamiento.
**Duración:** 20,5 días-persona · **Tareas:** F3-01 … F3-12
**Gate de salida:** ningún error de negocio destruye la pantalla; toda mutación confirma; cero texto en inglés en la interfaz; navegación sin enlaces rotos.

| ID | Tarea | Días |
|---|---|---:|
| F3-01 | Contrato tipado de error en acciones + `useActionState` | 4 |
| F3-02 | Boundaries en español + `not-found.tsx` con marca | 1 |
| F3-03 | `loading.tsx` con esqueletos en todas las rutas | 2 |
| F3-04 | Toasts en todas las mutaciones | 2 |
| F3-05 | Corregir enlace `/app/organization` | 0,25 |
| F3-06 | Layout propio para autenticación | 1 |
| F3-07 | Metadata por página en el área de app | 0,5 |
| F3-08 | Formateo de cifras en la página pública | 0,25 |
| F3-09 | Página de corrida legible para humanos | 1,5 |
| F3-10 | Unificar el lenguaje visual de `/admin` | 3 |
| F3-11 | Auditoría de accesibilidad WCAG 2.1 AA | 2 |
| F3-12 | Descomponer los 3 componentes monolíticos | 3 |

### Fase 4 — Operación SaaS

**Objetivo:** que Uellix pueda cobrar, limitar y sostener clientes.
**Duración:** 22 días-persona · **Tareas:** F4-01 … F4-10
**Gate de salida:** una organización recorre precios → checkout → suscripción activa → límites aplicados → cancelación, en modo de prueba de Stripe, sin intervención manual.

| ID | Tarea | Días |
|---|---|---:|
| F4-01 | Página de precios + creación de sesión de checkout | 3 |
| F4-02 | Definición de planes y límites sobre recursos reales | 2 |
| F4-03 | Aplicación de límites en la capa de servicios | 3 |
| F4-04 | Dunning y estados de suscripción | 2 |
| F4-05 | Portal de cliente y cancelación | 1,5 |
| F4-06 | Juego completo de correos transaccionales | 3 |
| F4-07 | Notificaciones in-app | 3 |
| F4-08 | Gestión de usuarios y herramientas de soporte en `/admin` | 2,5 |
| F4-09 | Analítica de producto | 1 |
| F4-10 | Canal de soporte y centro de ayuda | 1 |

### Fase 5 — Calidad y confiabilidad

**Objetivo:** detectar fallos antes que los clientes.
**Duración:** 17 días-persona · **Tareas:** F5-01 … F5-10
**Gate de salida:** el camino dorado está cubierto por E2E en CI; los errores de cliente llegan a Sentry; existe una restauración de backup probada.

| ID | Tarea | Días |
|---|---|---:|
| F5-01 | Suite E2E con Playwright del camino dorado | 4 |
| F5-02 | Integración/RLS en CI contra Supabase efímero | 2 |
| F5-03 | `Sentry.captureException` en boundaries y acciones | 1 |
| F5-04 | Logging estructurado con correlación de request | 2 |
| F5-05 | Alertas y presupuestos de error | 1 |
| F5-06 | Backups verificados + runbook de restauración | 2 |
| F5-07 | Pruebas de carga y presupuesto de rendimiento | 2 |
| F5-08 | Eliminar 52 `no-unused-vars` y elevar la regla a error | 1 |
| F5-09 | Reparar aserciones comentadas | 0,5 |
| F5-10 | Cobertura de código con umbral en CI | 1,5 |

### Fase 6 — Despliegue comercial

**Objetivo:** poder desplegar, documentar y responder como una empresa.
**Duración:** 13 días-persona · **Tareas:** F6-01 … F6-07
**Gate de salida:** checklist de lanzamiento firmada con go/no-go humano explícito.

| ID | Tarea | Días |
|---|---|---:|
| F6-01 | Supabase de preview aislado | 2 |
| F6-02 | Migraciones en CI/CD con rollback probado | 3 |
| F6-03 | Reescribir README + ADRs | 2 |
| F6-04 | Runbooks de incidente | 2 |
| F6-05 | Revisión legal operativa de términos y privacidad | 2 |
| F6-06 | Checklist de lanzamiento y go/no-go | 1 |
| F6-07 | Revisión de privacidad de Session Replay | 1 |

---

## 3. Ruta crítica

Las cadenas siguientes se obtuvieron **recorriendo el grafo de dependencias declarado en `BACKLOG_SAAS.csv`**, no dibujándolas a mano. Se verificó además que no hay ciclos ni referencias a tareas inexistentes.

**Las cinco cadenas seriales más largas:**

| # | Cadena | Días-persona |
|---|---|---:|
| 1 | `F4-02 (2) → F4-03 (3) → F4-01 (3) → F4-04 (2)` | **10,0** |
| 2 | `F4-02 (2) → F4-03 (3) → F4-01 (3) → F4-05 (1,5)` | 9,5 |
| 3 | `F4-02 (2) → F4-03 (3) → F4-01 (3)` | 8,0 |
| 4 | `F3-01 (4) → F5-01 (4)` | 8,0 |
| 5 | `F2-11 (1,5) → F4-06 (3) → F4-07 (3)` | 7,5 |

**Ruta crítica real: 10,0 días-persona** — la cadena de monetización `planes → límites → checkout → dunning`.

Cadenas secundarias relevantes, todas cortas:

```
F0-04 (2) → F2-02 (2) → F6-02 (3)        habilitación de base de datos y despliegue
F0-04 (2) → F2-01 (2) → F2-14 (1) → F6-03 (2)   RLS única y documentación
F0-02 (0,25) → F1-01 (2) → F2-07 (2)     evidencia
F0-02 + F0-03 → F5-01 (4)                E2E
F1-02 (2) → F1-04 (3) / F1-03 (2)        contenido y publicación de reportes
```

**El calendario de Uellix no está limitado por dependencias, sino por capacidad de equipo.** La cadena serial más larga (10 días) representa apenas el **9 % de los 110 días-persona totales**. La consecuencia práctica es que **añadir una tercera persona comprime el calendario de forma casi lineal**, algo que no ocurriría si el cuello de botella fuese arquitectónico. Es una buena noticia y conviene aprovecharla.

**Dependencia entre fases que conviene tener presente:** `F2-03` (Fase 2) depende de `F3-01` (Fase 3), y `F5-01`, `F5-03` y `F2-13` también dependen de tareas de fases posteriores a la suya. No es un error del plan: `F3-01`, `F3-02` y `F3-05` se **adelantan deliberadamente al Escenario A** porque el contrato de error condiciona todo lo que se construya encima. Las fases ordenan por objetivo, no por cronología estricta.

**Los tres cuellos de botella reales:**

1. **F0-04** (bootstrap de base de datos) bloquea toda la Fase 2. Sin un entorno reproducible no se puede validar ningún cambio de RLS.
2. **F3-01** (contrato de error) bloquea la calidad de toda la Fase 4: cada flujo de facturación nuevo hereda el patrón de `throw` si no se corrige antes.
3. **F4-02** (definición de planes) es una **decisión de negocio, no técnica**. Si no está tomada cuando llegue la Fase 4, la ruta crítica se detiene. **Debe resolverse durante la Fase 1, en paralelo.**

---

## 4. Backlog priorizado

`BACKLOG_SAAS.csv` contiene las 68 tareas con las 16 columnas requeridas. Cifras verificadas leyendo el propio CSV; **el CSV es la fuente de verdad** y este resumen se deriva de él.

| Prioridad | Tareas | Días-persona | Significado |
|---|---:|---:|---|
| **P0** | 8 | 7,0 | Bloquea la operación o representa riesgo crítico |
| **P1** | 17 | 34,0 | Indispensable para el MVP funcional |
| **P2** | 30 | 51,5 | Necesaria para beta o producción |
| **P3** | 13 | 17,5 | Mejora posterior |
| | **68** | **110,0** | |

Las ocho tareas P0 son las siete de la Fase 0 más **`F2-02`**, que vive en la Fase 2 por afinidad temática pero se prioriza como P0: el escenario que dispara su fallo (re-aplicar migraciones) es exactamente una **restauración de backup**, el peor momento posible para una rotura silenciosa de la evidencia. Prioridad y fase son ejes distintos.

| Fase | Tareas | Días-persona |
|---|---:|---:|
| Fase 0 — Bloqueadores críticos | 7 | 5,0 |
| Fase 1 — Núcleo funcional | 8 | 15,0 |
| Fase 2 — Integridad y seguridad | 14 | 17,5 |
| Fase 3 — Experiencia de usuario | 12 | 20,5 |
| Fase 4 — Operación SaaS | 10 | 22,0 |
| Fase 5 — Calidad y confiabilidad | 10 | 17,0 |
| Fase 6 — Despliegue comercial | 7 | 13,0 |
| **Total** | **68** | **110,0** |

### Cobertura del backlog por dominio

Las 68 tareas se reparten entre 31 módulos. Agrupados en los cinco dominios que debe cubrir un plan hasta SaaS:

| Dominio | Tareas | Días-persona | d/tarea | Módulos incluidos |
|---|---:|---:|---:|---|
| **Operación y seguridad** | 23 | 32,75 | 1,42 | Seguridad, Observabilidad, Operación, Administración, Privacidad, Legal, Documentación, Soporte, Lanzamiento |
| **Producto** | 21 | 31,25 | 1,49 | Reportes, Evidencia, Cálculo, Onboarding, Experiencia de usuario, Navegación, Multitenancy, Accesibilidad |
| **Comercialización** | 9 | 19,00 | **2,11** | Facturación, Correo, Notificaciones, Analítica |
| **Infraestructura** | 10 | 17,00 | 1,70 | Plataforma, CI/CD, Entornos, Base de datos, Arquitectura, Continuidad, Rendimiento |
| **Pruebas y calidad** | 5 | 10,00 | **2,00** | Pruebas, Calidad, Deuda técnica |
| | **68** | **110,00** | 1,62 | 31 módulos, ninguna tarea sin dominio |

Ningún dominio queda sin cubrir. El patrón informativo está en la columna **d/tarea**: **Comercialización (2,11) y Pruebas (2,00) son los dominios con tareas más grandes**, porque en ambos casi todo se construye desde cero. **Operación y seguridad (1,42) es el más fragmentado**: 23 correcciones acotadas sobre una base que ya existe. Es coherente con el diagnóstico general — lo que falta no es reparar, es construir lo que nunca se hizo.

### Clasificación cruzada por obligatoriedad

| Categoría | Composición | Tareas | Días-persona |
|---|---|---:|---:|
| **Obligatorio para funcionar** (= Escenario A) | Fase 0 completa + F2-02 + F1-01, F1-02, F1-04, F1-05 + F3-01, F3-02, F3-05 | 15 | 19,75 |
| **Obligatorio para beta privada** (= Escenario B) | Lo anterior + resto de Fase 2 + resto de Fase 3 salvo F3-10/F3-12 + F1-03, F1-06, F1-07 + F5-01, F5-02, F5-03, F5-06 + F6-01, F6-03 | 44 | 62,0 |
| **Obligatorio para producción** | Lo anterior + F5-04, F5-05, F5-08, F5-09 + F6-02, F6-04, F6-05, F6-06 | 52 | 74,5 |
| **Obligatorio para comercializar** (= Escenario C) | Lo anterior + Fase 4 salvo F4-07/F4-09 | 60 | 92,5 |
| **Recomendable tras el lanzamiento** | F1-08, F3-10, F3-12, F4-07, F4-09, F5-07, F5-10, F6-07 | 8 | 17,5 |

Cada nivel es **superconjunto estricto** del anterior y está **cerrado en dependencias** (verificado recorriendo el grafo del CSV: ninguna tarea incluida depende de una excluida).

---

## 5. Roadmap — tres escenarios

### Escenario A — MVP funcional

> *La versión mínima que completa el recorrido principal de forma confiable.*

- **Alcance:** un usuario nuevo se registra, crea una organización, invita a su equipo, recorre los 8 pasos del pipeline, calcula un SROI, revisa metodológicamente, genera un reporte con contenido real y lo exporta en PDF.
- **Incluye (15 tareas):** Fase 0 completa + **F2-02** + F1-01, F1-02, F1-04, F1-05 + F3-01, F3-02, F3-05.
- **Excluye:** monetización, multi-organización, notificaciones, E2E, analítica, unificación visual de `/admin`.
- **Riesgos aceptados:** rate limiting inefectivo; sin backups probados; sin E2E automatizado; RLS duplicada (mitigada por el hecho de que la app la omite); publicación pública sin control explícito. **Por eso el MVP no admite datos reales de clientes.**
- **Criterios de entrada:** rama estable, CI verde, entorno local reproducible.
- **Criterios de salida:** el camino dorado se ejecuta **tres veces seguidas por tres personas distintas sin intervención de un desarrollador**; `pnpm audit --prod` sin severidad alta; cero texto en inglés en los caminos recorridos; el conjunto completo de migraciones se aplica dos veces seguidas sobre una base limpia sin romper la evidencia.
- **Estimación:** **19,75 días-persona ≈ 3 semanas** con dos desarrolladores.
- **Dependencias críticas:** F0-04 debe cerrarse primero (habilita F2-02 y toda la Fase 2).

### Escenario B — Beta privada

> *La versión que pueden usar usuarios invitados con seguimiento cercano.*

- **Alcance:** Escenario A + aislamiento verificado, seguridad al día, UX completa, observabilidad básica, publicación controlada.
- **Incluye (44 tareas):** Escenario A + resto de la Fase 2 + Fase 3 (salvo F3-10 y F3-12) + F1-03, F1-06, F1-07 + F5-01, F5-02, F5-03, F5-06 + F6-01, F6-03.
- **Excluye:** cobro, planes, límites, dunning, notificaciones, soporte formal, multi-organización.
- **Riesgos aceptados:** sin monetización (beta gratuita por diseño); soporte por correo directo; sin pruebas de carga; un usuario sigue perteneciendo a una sola organización.
- **Criterios de entrada:** Escenario A cerrado; Supabase de preview aislado operativo.
- **Criterios de salida:** 5 organizaciones piloto operan una semana sin intervención; cero incidentes de aislamiento; E2E verde en CI; restauración de backup probada al menos una vez.
- **Estimación:** **+42,25 días-persona ≈ 5 semanas adicionales** (acumulado: **62,0 días-persona ≈ 8 semanas**).
- **Dependencias críticas:** F0-04 antes que F2-01 y F2-02 (ambas dependen de él y sólo de él); F3-01 debe estar cerrada del Escenario A porque F2-03 y F5-01 dependen de ella.

### Escenario C — SaaS comercial

> *La versión preparada para cobrar, soportar usuarios reales y operar de forma estable.*

- **Alcance:** Escenario B + ciclo completo de monetización, límites aplicados, soporte, documentación operativa y despliegue con rollback.
- **Incluye:** todo el backlog salvo lo marcado como «recomendable tras el lanzamiento».
- **Excluye (deliberadamente, a post-lanzamiento):** F1-08 multi-organización, F3-10 unificación visual de `/admin`, F3-12 descomposición de monolitos, F4-07 notificaciones in-app, F4-09 analítica avanzada, F5-07 pruebas de carga, F5-10 umbral de cobertura, F6-07 revisión de Session Replay.
- **Riesgos aceptados:** sin SOC 2 ni certificación; sin SLA formal; sin multi-región; capacidad de soporte limitada al equipo fundador.
- **Criterios de entrada:** Escenario B cerrado; planes y precios **decididos por negocio**; entidad legal y cuenta de Stripe operativas.
- **Criterios de salida:** una organización completa el ciclo pricing → checkout → suscripción → límites → cancelación en modo de prueba, sin intervención manual; checklist de lanzamiento firmada; runbooks probados en un simulacro.
- **Estimación:** **+30,5 días-persona ≈ 4 semanas adicionales** (acumulado: **92,5 días-persona ≈ 12 semanas ≈ 3 meses**).
- **Dependencias críticas:** F4-02 es una decisión de negocio y debe estar tomada en la semana 4, no en la 10.

---

## 6. Estimación consolidada

Las estimaciones están en **días-persona**. La conversión a calendario asume 2 desarrolladores con un factor de paralelismo efectivo de **1,6×** (no 2×: hay coordinación, revisión y trabajo serializado) y semanas de 5 días.

| Hito | Días-persona | Semanas (2 devs) | Acumulado |
|---|---:|---:|---|
| Desbloqueo (Fase 0 + F2-02, los 8 P0) | 7,0 | 0,9 | **Semana 1** |
| **Escenario A — MVP funcional** | 19,75 | 2,5 | **Semana 3** |
| **Escenario B — Beta privada** | 62,0 | 7,8 | **Semana 8** |
| Producción (sin monetización) | 74,5 | 9,3 | Semana 10 |
| **Escenario C — SaaS comercial** | 92,5 | 11,6 | **Semana 12** |
| Backlog completo (incl. post-lanzamiento) | 110,0 | 13,8 | Semana 14 |

**Con un solo desarrollador:** MVP ≈ 4 semanas · Beta ≈ 13 semanas · SaaS comercial ≈ 19 semanas.

**Con tres desarrolladores** (factor ≈ 2,2×): MVP ≈ 2 semanas · Beta ≈ 6 semanas · SaaS comercial ≈ 9 semanas. Como la cadena serial es corta (§3), esta compresión es realista.

Las estimaciones incluyen pruebas y revisión de código; **no** incluyen: decisiones de negocio pendientes, revisión legal externa (F6-05), ni tiempo de espera por proveedores (verificación de dominio en Resend, activación de cuenta Stripe).

---

## 7. Tareas paralelizables

**55 de las 68 tareas (81 %) son paralelizables.** Las 13 restantes están en la cadena serial o tocan archivos compartidos; el CSV indica en cada una el motivo exacto del bloqueo.

### Frentes independientes que pueden avanzar en simultáneo

| Frente | Tareas | Perfil | Toca |
|---|---|---|---|
| **A · Plataforma y datos** | F0-01, F0-04, F0-05, F0-07, F2-01, F2-02, F2-12, F6-01, F6-02 | DevOps + Full-stack | `db/`, `supabase/`, `scripts/`, `.github/` |
| **B · Producto núcleo** | F1-01 … F1-07, F2-10, F2-13 | Full-stack senior | `lib/pipeline/`, `lib/reports/`, `app/app/projects/` |
| **C · UX y sistema de diseño** | F3-02 … F3-12 | Frontend | `components/`, `app/error.tsx`, layouts |
| **D · Seguridad de superficie** | F2-03 … F2-09, F2-11 | Full-stack + DevOps | `app/api/`, `proxy.ts`, `lib/security/` |
| **E · Monetización** | F4-01 … F4-05 | Full-stack senior | `lib/stripe/`, `app/app/organization/billing/` |
| **F · Calidad** | F5-01, F5-02, F5-07 … F5-10 | Cualquiera | `tests/`, `.github/workflows/` |

### Conflictos de archivo que exigen serialización

| Tareas | Archivo compartido | Orden obligatorio |
|---|---|---|
| F3-01 → F3-04 | Todas las acciones de servidor | Dependencia real: el contrato de error va antes que los toasts |
| F0-04 → F2-02 y F0-04 → F2-01 | Cadena de migraciones | Dependencia real: reparar el bootstrap antes de endurecer nada |
| F2-02 antes que F2-01 | `db/migrations/`, `db/policies/` | **No es dependencia**, es preferencia de orden: una cadena de migraciones idempotente y reproducible es el banco de pruebas con el que se valida la unificación de RLS. Ambas dependen sólo de F0-04 y son técnicamente independientes entre sí |
| F4-02 → F4-03 → F4-01 | `lib/stripe/`, servicios | Dependencia real: definir planes → aplicar límites → cobrar |
| F3-12 antes que F1-07 | `pipeline/calculation/page.tsx` | **No es dependencia funcional**, es conflicto de archivo: ambas tocan el mismo componente de 1 126 líneas. Si sólo se ejecuta F1-07 (F3-12 es post-lanzamiento), no hay conflicto |

### Solapamiento recomendado

Las **Fases 3 y 4 se ejecutan en paralelo** a partir de la semana 6: la UX vive en `components/` y `app/error.tsx`; la monetización en `lib/stripe/` y `app/app/organization/billing/`. La única intersección es F3-01, que debe cerrarse **antes** de que empiece la Fase 4.

Con dos desarrolladores el ahorro directo es de **≈ 1 semana** (5,3 → 4,4 semanas para las dos fases). El beneficio mayor es estructural: al ser frentes con superficies de archivo disjuntas, **una tercera persona puede incorporarse a la Fase 4 sin generar conflictos**, y ahí el ahorro sí es de varias semanas.

---

## 8. Definition of Done general

Una tarea **no** está terminada hasta cumplir **todos** estos puntos:

**Código**
1. Cumple las convenciones del repositorio (español en la interfaz, `snake_case` en roles, comentarios que explican el *porqué*).
2. Sin `any`; `pnpm typecheck` limpio.
3. Sin nuevas advertencias de ESLint.
4. Validación con Zod en todo límite de entrada.
5. Autorización en la **capa de servicios**, nunca sólo en la acción o el componente.

**Pruebas**
6. Prueba unitaria para toda lógica nueva.
7. Prueba de integración si toca la base de datos o RLS.
8. Prueba E2E si altera el camino dorado (a partir de F5-01).
9. **Todas** las suites en verde: `typecheck`, `lint`, `test:unit`, `test:integration`, `build`.

**Verificación — evidencia, no afirmaciones**
10. El comportamiento se ejecutó y se observó, con salida de comando o captura adjunta al PR. *Que compile no es que funcione.*
11. Los caminos de error se probaron explícitamente, no sólo el camino feliz.
12. Verificado en 375 px si es interfaz.

**Base de datos**
13. Migración generada con `drizzle-kit generate` (nunca editada a mano).
14. `npx drizzle-kit check` sin drift.
15. Idempotente y reversible; probada sobre una base **limpia** y sobre una **ya poblada**.
16. Aplicada primero en preview, siguiendo `SUPABASE_MIGRATION_GATE.md`.

**Documentación**
17. README/ADR actualizados si cambia arquitectura, contrato de entorno o procedimiento operativo.
18. Variables de entorno nuevas añadidas a `.env.example` **sin valores reales**.

**Revisión**
19. Revisión humana; sin autoaprobación.
20. Los criterios de aceptación de `BACKLOG_SAAS.csv` se verifican uno a uno en el PR.

---

## 9. Checklist de lanzamiento comercial

### Producto
- [ ] Camino dorado completado por 3 usuarios externos sin ayuda
- [ ] Todo archivo de evidencia es descargable y previsualizable
- [ ] Ningún reporte incompleto puede bloquearse
- [ ] Publicar un reporte es una decisión explícita y revocable
- [ ] PDF íntegramente en español, con contenido real
- [ ] Cero texto en inglés en la interfaz

### Seguridad
- [ ] `pnpm audit --prod` sin severidad alta ni crítica
- [ ] Una única fuente de verdad para RLS, documentada
- [ ] Aislamiento entre organizaciones cubierto por pruebas automatizadas en CI
- [ ] Rate limiting distribuido activo y *fail-closed* verificado
- [ ] Ningún fallo de autorización produce un 500
- [ ] Secretos rotados y fuera del repositorio
- [ ] Revisión de seguridad por un tercero (recomendada, no bloqueante)

### Datos
- [ ] Backup automático verificado **con una restauración real ejecutada**
- [ ] RTO y RPO definidos y documentados
- [ ] Flujo GDPR de borrado implementado y probado
- [ ] Política de retención documentada y aplicada
- [ ] Migraciones idempotentes probadas sobre base limpia y poblada

### Comercial
- [ ] Planes y precios publicados
- [ ] Checkout funcional en modo producción
- [ ] Límites de plan aplicados en la capa de servicios
- [ ] Dunning configurado y probado
- [ ] Cancelación y portal de cliente operativos
- [ ] Facturas emitidas correctamente
- [ ] Entidad legal y cuenta de Stripe activas

### Operación
- [ ] Sentry recibiendo errores de cliente y servidor
- [ ] Alertas configuradas sobre tasa de error y latencia
- [ ] Runbooks de incidente probados en simulacro
- [ ] Canal de soporte operativo con SLA de respuesta declarado
- [ ] Entornos dev/preview/producción completamente aislados
- [ ] CI/CD con rollback probado

### Legal
- [ ] Términos y condiciones revisados por abogado
- [ ] Política de privacidad revisada y **verificada contra los controles reales** (retención, cifrado, roles de responsable/encargado)
- [ ] Consentimiento de cookies conforme a la jurisdicción
- [ ] Acuerdos de tratamiento de datos con Supabase, Vercel, Resend, Google y Stripe
- [ ] Revisión de privacidad de Session Replay documentada

### Documentación
- [ ] README reescrito y verificado ejecutando sus propios pasos
- [ ] ADR de «la aplicación omite RLS» publicado
- [ ] Manual de operación actualizado
- [ ] Documentación de usuario / centro de ayuda publicado

### Go / No-Go
- [ ] Todos los gates de fase cerrados con evidencia
- [ ] Aprobación humana explícita para Vercel **y** para Supabase
- [ ] Plan de rollback escrito y ensayado
- [ ] Persona de guardia designada para las primeras 72 horas

---

## 10. Riesgos del plan y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|---|---|---|---|
| F0-04 resulta más profundo que 2 días (bug de `drizzle-kit` con Node 24) | Media | Alto — bloquea la Fase 2 | Plan B: fijar Node 22 vía `.nvmrc` y `engines`, alineando con CI; ambos caminos caben en la estimación |
| Los planes y precios no se deciden a tiempo | **Alta** | **Alto — detiene la ruta crítica** | Forzar la decisión en la semana 4 con una tarea de negocio explícita; sin ella, la Fase 4 no arranca |
| F1-08 (multi-organización) se descubre como requisito de un cliente ancla | Media | Alto — es un cambio de modelo de datos | Ya está estimada (3 d) y excluida del MVP; si aparece, entra antes de la beta, no después |
| F3-01 se expande al tocar 40 acciones de servidor | Media | Medio | Migrar por rutas, empezando por el camino dorado; el resto puede convivir con el patrón antiguo |
| Actualizar Next.js introduce regresiones | Baja | Medio | 1 027 pruebas unitarias + build como red de seguridad; es un salto de parche (16.2.9 → 16.2.11) |
| Aparecen nuevas CVE durante el desarrollo | **Alta** | Bajo si hay proceso | F0-07 pone `pnpm audit --prod` en CI desde la semana 1 |

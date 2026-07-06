# Uellix SROI Platform — Manual Ejecutivo para Project Managers

**Última actualización:** Julio 2026  
**Versión:** 1.0  
**Dirigido a:** Project Managers, Impact Officers, Coordinadores de Proyectos

---

## Índice

1. [Visión General](#visión-general)
2. [Conceptos Clave](#conceptos-clave)
3. [Estructura de la Plataforma](#estructura-de-la-plataforma)
4. [Guía Paso a Paso: Gestión de Proyectos](#guía-paso-a-paso-gestión-de-proyectos)
5. [Workflows Principales](#workflows-principales)
6. [Roles y Permisos](#roles-y-permisos)
7. [Preguntas Frecuentes](#preguntas-frecuentes)

---

## Visión General

### ¿Qué es Uellix?

**Uellix** es una plataforma de medición de **Retorno Social sobre la Inversión (SROI)**. Te permite cuantificar el valor social que crea tu organización, ayudando a:

- **Financiadores** a entender el impacto de sus contribuciones
- **Gestores de impacto** a tomar decisiones basadas en datos
- **Equipos** a demostrar y comunicar resultados de proyectos

### ¿Para qué sirve?

Uellix responde preguntas como:

> *"Invertimos $100,000 en un programa de educación. ¿Cuál fue el retorno social?"*

> *"¿Cuál fue la contribución de cada financiador al resultado final?"*

> *"¿Cómo se compara este año con el anterior?"*

### Flujo General

```
Descripción del Proyecto
    ↓
Definir Stakeholders (¿quiénes se benefician?)
    ↓
Identificar Outcomes (¿qué cambia en sus vidas?)
    ↓
Medir Indicadores (¿cuánto cambió?)
    ↓
Reunir Evidencia (¿tenemos pruebas?)
    ↓
Asignar Valores Monetarios (¿cuánto vale ese cambio?)
    ↓
Registrar Inversiones (¿cuánto invertimos?)
    ↓
Calcular SROI (Por cada $1 invertido, ¿cuánto valor social creamos?)
    ↓
Generar Reporte (Comunicar resultados)
```

---

## Conceptos Clave

### 1. **SROI (Social Return on Investment)**

Es un número que responde: *"Por cada dólar invertido, ¿cuánto valor social se creó?"*

**Ejemplo:**
- Invertimos: $100,000
- Valor social creado: $400,000
- **SROI Ratio: 4:1** (por cada dólar, se crearon 4 dólares de valor social)

### 2. **Outcomes (Resultados)**

Son los cambios específicos que ocurren en la vida de los beneficiarios.

**Ejemplos:**
- "Los adolescentes completan la educación secundaria"
- "Las mujeres acceden a crédito para pequeños negocios"
- "Las comunidades rurales tienen agua potable"

### 3. **Indicadores (Métricas de Medición)**

Responden: *¿Cómo medimos si el outcome ocurrió?*

**Ejemplo para "Los adolescentes completan educación secundaria":**
- Indicador: Tasa de graduación de secundaria
- Línea base: 65%
- Meta: 85%
- Resultado actual: 82%

### 4. **Evidencia (Pruebas)**

Documentos que respaldan que el cambio realmente ocurrió.

**Tipos:**
- Reportes de evaluación
- Historias de beneficiarios
- Datos de sistema de registro
- Certificados de logros
- Auditorías externas

### 5. **Proxy (Valor Monetario)**

Convierte un outcome en dinero para calcular SROI.

**Ejemplo:**
- Outcome: "Un adolescente completa educación secundaria"
- Proxy: $2,500 (valor presente neto de ingresos futuros estimados)

En Uellix, los proxies incluyen:
- Valor monetario
- Moneda (USD, COP, EUR)
- Año de referencia
- Nivel de confianza (qué tan seguro estamos del valor)

### 6. **Inversión (Contribution)**

Todo lo que invertiste en el proyecto: dinero, tiempo, recursos.

**Tipos:**
- Cash (efectivo transferido)
- In-kind (recursos no monetarios: tiempo de personal, equipamiento, oficina)

**Multi-Funder:** Uellix rastrea quién aportó qué.

### 7. **Asignación (Allocation)**

Especifica qué financiador contribuyó a qué outcome.

**Ejemplo:**
- Financiador A aportó 60% del valor que resultó en educación
- Financiador B aportó 40% del valor en acceso a crédito

### 8. **Funder Breakdown (Desglose por Financiador)**

Al final del cálculo, ves el SROI específico por cada financiador.

**Ejemplo:**
- SROI Global: 4:1
- SROI Financiador A: 5:1
- SROI Financiador B: 3:1

---

## Estructura de la Plataforma

### Navegación Principal

```
📊 Dashboard
├── 📁 Mis Proyectos
├── 🎯 Carteras (Portafolios)
└── ⚙️ Mi Organización

🔧 Para cada Proyecto:
├── 📖 Narrativa (Descripción + Teoría de Cambio)
├── 👥 Stakeholders (Grupos afectados)
├── 🎯 Outcomes (Cambios esperados)
├── 📊 Indicadores (Métricas)
├── 📄 Evidencia (Pruebas)
├── 💰 Proxies (Valores monetarios)
├── 💵 Inversiones (¿Quién aporta qué?)
├── 📍 Asignaciones (¿Quién a qué outcome?)
├── 🧮 Cálculo (Ejecutar SROI)
└── 📋 Reportes (Compartir resultados)
```

### Roles y Qué Puedes Hacer

| Rol | Acciones Permitidas |
|-----|------------------|
| **Viewer (Lector)** | Ver proyectos y reportes (solo lectura) |
| **Reviewer (Revisor)** | Lo anterior + revisar evidencia y proxies |
| **Analyst (Analista)** | Lo anterior + crear/editar proyectos, ejecutar cálculos |
| **Impact Manager** | Lo anterior + gestionar estrategia de impacto |
| **Org Admin** | Lo anterior + gestionar miembros del equipo, cuotas de IA |
| **Super Admin** | Control total de la plataforma |

---

## Guía Paso a Paso: Gestión de Proyectos

### Fase 1: Crear un Nuevo Proyecto

#### Paso 1: Ir a "Mis Proyectos" → "Nuevo Proyecto"

Llena información básica:
- **Nombre del proyecto:** (ej: "Programa de Educación Rural 2026")
- **Área temática:** Educación, Salud, Economía, etc.
- **Territorio:** País/región donde opera
- **Descripción breve:** ¿Qué hace este proyecto?

**Dato importante:** Cada proyecto está vinculado a una única organización. Si trabajas en múltiples organizaciones, necesitarás cambiar de contexto.

#### Paso 2: Crear la Narrativa

Ve a **Narrativa** en el menú del proyecto.

Aquí describes:
1. **El problema:** ¿Qué situación necesita cambiar?
2. **Tu intervención:** ¿Qué haces al respecto?
3. **El cambio esperado:** ¿Cómo será diferente?

**Consejo:** Sé específico. En lugar de "Mejorar educación", escribe "Aumentar la tasa de finalización de secundaria en comunidades rurales del 65% al 85%".

**Ayuda de IA:** Uellix (Stella) puede ayudarte a refinar y estructurar esta narrativa.

---

### Fase 2: Definir Stakeholders y Outcomes

#### Paso 3: Identificar Stakeholders

Ve a **Stakeholders** → "Agregar grupo".

**Stakeholder** = Grupo de personas afectadas por el proyecto.

**Ejemplos:**
- Adolescentes de 15-18 años en zonas rurales
- Mujeres emprendedoras de 25-45 años
- Pequeños agricultores

Para cada grupo, especifica:
- Nombre del grupo
- Descripción
- Cantidad aproximada
- Contexto (geográfico, demográfico)

#### Paso 4: Definir Outcomes

Ve a **Outcomes** → "Agregar outcome".

Para cada stakeholder, define qué cambia en sus vidas.

**Estructura:**
- **Outcome:** "Los adolescentes completan educación secundaria"
- **Stakeholder:** Adolescentes de 15-18 años (selecciona del paso anterior)
- **Materialidad:** Escala de 1-5 (¿qué tan importante es este cambio?)
  - 1 = Poco importante
  - 5 = Muy importante

**Consejo:** Puedes tener múltiples outcomes por stakeholder.

---

### Fase 3: Medir y Evidenciar

#### Paso 5: Agregar Indicadores

Ve a **Indicadores** → "Agregar indicador".

Para cada outcome, define cómo lo medirás.

**Estructura:**
- **Indicador:** "Tasa de graduación de secundaria"
- **Outcome:** (Selecciona el outcome del paso 4)
- **Línea base:** 65% (estado inicial)
- **Meta:** 85% (objetivo)
- **Resultado actual:** 82% (lo que realmente pasó)

**Nota:** Los indicadores pueden ser cuantitativos (números, %) o cualitativos (descripciones).

#### Paso 6: Recopilar Evidencia

Ve a **Evidencia** → "Agregar evidencia".

Sube pruebas que respalden el resultado:
- Reportes de evaluación
- Listas de beneficiarios
- Fotos/videos
- Testimonios
- Datos de registros

**Para cada evidencia:**
1. Carga el archivo o URL
2. Especifica de qué indicador es prueba
3. Uellix (Stella) calcula automáticamente un **score de confianza**
4. Puedes revisar y ajustar el score

**Score de confianza:** 0-100%
- 0-30% = Bajo
- 30-70% = Medio
- 70-100% = Alto

---

### Fase 4: Asignar Valores Monetarios

#### Paso 7: Revisar/Crear Proxies

Ve a **Proxies** → Busca o crea un proxy para tus outcomes.

**Proxy** = Valor monetario de un outcome.

**Ejemplo:** "La finalización de secundaria vale $2,500"

**De dónde vienen los proxies:**
- Biblioteca estándar (actualizaciones anuales)
- Tu organización (proxies internos)
- Literatura académica
- Estudios de impacto previos

**Para cada proxy, especifica:**
- Valor ($)
- Moneda (USD, COP, EUR)
- Año de referencia
- Confianza (qué tan seguro estamos)
- Justificación/fuente

**Nota:** Uellix normaliza todas las monedas a USD usando tasas de cambio actualizadas.

#### Paso 8: Vincular Proxies a Outcomes

Ve a **Asignaciones de Proxy** → "Vincular proxy a outcome".

Esto dice: "Este outcome tiene este valor monetario".

---

### Fase 5: Registrar Inversiones

#### Paso 9: Agregar Financiadores

Ve a **Inversiones** → "Agregar financiador".

Especifica quién aportó dinero o recursos:
- **Nombre del financiador:** (ej: "Banco XYZ", "Fundación ABC", "Gobierno")
- **Tipo:** Público, Privado, Fundación, Individual
- **Monto:** Cantidad aportada
- **Moneda:** USD, COP, EUR, etc.
- **Tipo de aporte:** 
  - Cash = dinero
  - In-kind = recursos (ej: $15,000 de tiempo de personal)

**Multi-funder:** Puedes agregar múltiples financiadores. Uellix rastreará automáticamente quién aportó qué.

**Conversión de monedas:** Si un financiador aportó 50,000 COP, Uellix convertirá a USD automáticamente.

---

### Fase 6: Asignar Contribuciones a Outcomes

#### Paso 10: Especificar Allocations

Ve a **Asignaciones** → "Configurar allocation".

Aquí especificas: *"¿Qué porcentaje de cada financiador contribuyó a cada outcome?"*

**Ejemplo:**
- Financiador A aportó 60% del valor en educación
- Financiador A aportó 40% del valor en empleabilidad
- Financiador B aportó 100% del valor en acceso a crédito

**Matriz:**
```
Outcomes  | Financiador A | Financiador B | Total
----------|---------------|---------------|--------
Educación |     60%       |      0%       |  60%
Trabajo   |     40%       |      0%       |  40%
Crédito   |      0%       |     100%      | 100%
```

**Nota:** Cada outcome debe sumar 100% entre todos los financiadores.

---

### Fase 7: Calcular SROI

#### Paso 11: Revisar Datos

Ve a **Cálculo** → Revisa el resumen:
- ✓ Inversión total
- ✓ Outcomes con valores
- ✓ Evidencia recopilada
- ✓ Allocations completas

**Stella Validator:** La IA revisa si hay datos faltantes o inconsistencias. Si aparecen avisos, resuélvelos antes de continuar.

#### Paso 12: Ejecutar Cálculo

Haz clic en **"Calcular SROI"**.

Uellix procesará:
1. **Inversión total:** Suma todas las contribuciones (convertidas a USD)
2. **Por cada outcome:**
   - Multiplica: Cantidad del indicador × Valor del proxy
   - Aplica ajustes (si corresponde)
   - Asigna por financiador según allocations
3. **Resultado global:**
   - Valor social total creado
   - SROI Ratio = Valor social / Inversión

**Resultado final:**
```
Inversión Total: $100,000
Valor Social Creado: $400,000
Retorno: $300,000
SROI Ratio: 4:1
```

#### Paso 13: Revisar Resultados Detallados

Ve a **Resultados** para ver:
- Breakdown por outcome
- Breakdown por financiador
- Sensitivity analysis (¿qué pasa si los valores varían?)
- Comparación con años anteriores (si hay)

---

### Fase 8: Generar y Compartir Reportes

#### Paso 14: Crear Reporte

Ve a **Reportes** → "Nuevo reporte".

Elige:
- Qué cálculo incluir
- Qué secciones incluir (narrativa, outcomes, resultados)
- **Incluir desglose por financiador?** Sí/No
  - Si sí: El reporte mostrará SROI específico para cada financiador

#### Paso 15: Personalizar Reporte

Uellix genera un borrador. Puedes:
- Editar secciones
- Cambiar orden
- Agregar notas adicionales
- Dejar comentarios para revisión

#### Paso 16: Finalizar y Compartir

Opciones:
- **Descargar PDF:** Para enviar por email o imprimir
- **Compartir enlace:** Genera un link leer-solo (ej: para financiadores)
- **Imprimir:** Directamente desde el navegador

---

## Workflows Principales

### Workflow 1: Cálculo Básico (1 Financiador)

```
1. Crear proyecto
2. Definir 1 outcome
3. Agregar 1 indicador con resultado
4. Agregar 1 proxy (valor monetario)
5. Registrar 1 inversión
6. Ejecutar cálculo
7. Generar reporte
```
**Tiempo estimado:** 2-3 horas (dependiendo de disponibilidad de datos)

### Workflow 2: SROI Multi-Funder con Desglose

```
1. Crear proyecto
2. Definir múltiples outcomes
3. Agregar indicadores y evidencia para cada uno
4. Crear/vincular proxies
5. Registrar múltiples inversiones (diferentes financiadores)
6. Configurar allocations (cuál financiador contribuyó a cuál outcome)
7. Ejecutar cálculo
8. Revisar SROI por financiador
9. Generar reporte con desglose
```
**Tiempo estimado:** 8-12 horas (incluye coordinación con stakeholders)

### Workflow 3: Revisión y Iteración

```
1. Calcular SROI inicial
2. Stella Validator revisa readiness
3. Resolver avisos/gaps
4. Volver a calcular
5. Generar reporte final
6. Circular entre revisores para feedback
7. Ajustar números según feedback
8. Re-calcular
9. Finalizar y publicar
```
**Tiempo estimado:** 1-2 semanas (incluye ciclos de feedback)

---

## Roles y Permisos

### Matriz de Permisos

| Acción | Viewer | Reviewer | Analyst | Impact Manager | Org Admin |
|--------|--------|----------|---------|----------------|-----------|
| Ver proyectos | ✓ | ✓ | ✓ | ✓ | ✓ |
| Crear proyectos | ✗ | ✗ | ✓ | ✓ | ✓ |
| Editar outcomes | ✗ | ✗ | ✓ | ✓ | ✓ |
| Revisar evidencia | ✗ | ✓ | ✓ | ✓ | ✓ |
| Crear proxies | ✗ | ✗ | ✓ | ✓ | ✓ |
| Ejecutar cálculo | ✗ | ✗ | ✓ | ✓ | ✓ |
| Generar reporte | ✗ | ✗ | ✓ | ✓ | ✓ |
| Gestionar miembros | ✗ | ✗ | ✗ | ✗ | ✓ |
| Admin de proxies globales | ✗ | ✗ | ✗ | ✗ | ✓ |
| Ver audit logs | ✗ | ✗ | ✗ | ✗ | ✓ |

### Cómo Agregar Miembros al Equipo

1. Ve a **Mi Organización** → **Miembros**
2. Haz clic en **"Invitar miembro"**
3. Ingresa su email
4. Selecciona su rol
5. Uellix envía un enlace de invitación
6. Ellos crean cuenta y acceden automáticamente

---

## Preguntas Frecuentes

### General

**P: ¿Cuánto tiempo toma hacer un cálculo SROI?**
R: Depende de la complejidad. Un proyecto simple: 2-3 horas. Un proyecto con múltiples outcomes, financiadores y stakeholders: 1-2 semanas incluyendo recopilación de datos y revisión.

**P: ¿Puedo tener múltiples proyectos en la plataforma?**
R: Sí. Todos se organizan en un dashboard. Puedes agruparlos en "Carteras" (portafolios temáticos).

**P: ¿Qué pasa si no tengo todos los datos?**
R: Stella Validator te dirá qué falta. Puedes:
- Agregar más evidencia
- Estimar valores basándote en literatura
- Marcar como "en proceso" y volver después

**P: ¿Puedo comparar resultados de años anteriores?**
R: Sí. Uellix guarda histórico de cálculos. Puedes compararlos en la sección de resultados.

### Inversiones y Monedas

**P: ¿Qué pasa si los financiadores aportaron en monedas diferentes?**
R: Uellix convierte automáticamente todo a USD usando tasas actuales. Verás tanto el monto original como la conversión.

**P: ¿Cómo registramos aportes no monetarios (in-kind)?**
R: Estímalo en dinero. Por ejemplo:
- 500 horas de personal a $40/hora = $20,000
- Uso de oficina por 6 meses = $5,000

**P: ¿Puedo cambiar la moneda de salida (en lugar de USD)?**
R: No en esta versión. Todos los cálculos usan USD como referencia. Pero puedes convertir el resultado final a tu moneda local.

### Proxies y Valores Monetarios

**P: ¿De dónde saco el valor monetario de un outcome?**
R: Opciones:
1. Biblioteca estándar de Uellix (actualizadas anualmente)
2. Estudios previos de tu organización
3. Literatura académica/informes de impacto
4. Consulta con expertos o benchmarking

**P: ¿Qué nivel de confianza debo usar en los proxies?**
R: Sé realista:
- Alto: Si basas en múltiples estudios recientes
- Medio: Si basas en 1-2 estudios o estimación educada
- Bajo: Si es aproximado o conservador

**P: ¿Puedo ajustar un proxy después de crear un proyecto?**
R: Sí. Si cambias un proxy, Uellix te pregunta si quieres recalcular automáticamente.

### Allocations (Asignaciones)

**P: ¿Qué pasa si dos financiadores contribuyeron al mismo outcome?**
R: Especificas el porcentaje de cada uno. Ejemplo:
- Financiador A: 60%
- Financiador B: 40%
- Total: 100%

**P: ¿Debo asignar TODOS los outcomes a TODOS los financiadores?**
R: No. Solo asigna outcomes a los que realmente contribuyeron ese financiador. Los no asignados quedan en 0%.

**P: ¿Cómo decidimos qué porcentaje es de quién?**
R: Opciones:
1. Por monto invertido (si A invirtió 60%, obtiene 60%)
2. Por actividad/contribución específica
3. Negociación entre financiadores
4. Por tiempo dedicado
Elije lo que tenga sentido para tu proyecto.

### Reportes

**P: ¿Qué es el "desglose por financiador"?**
R: Es una sección opcional en el reporte que muestra:
- Cuánto cada financiador aportó
- El SROI específico por financiador
- Outcomes en los que cada uno contribuyó

Útil si tienes múltiples financiadores.

**P: ¿Puedo compartir un reporte con financiadores?**
R: Sí. Genera un enlace compartible (read-only). Ellos ven los resultados pero no pueden editar.

**P: ¿Cuántas veces puedo generar reportes?**
R: Sin límite. Puedes tener múltiples borradores y versiones finales del mismo cálculo.

### Stella (Asistencia de IA)

**P: ¿Qué es Stella?**
R: Es un asistente de IA que ayuda con:
- **Advisor:** Refinar narrativa, sugerir confianza de evidencia
- **Validator:** Revisar si hay datos faltantes antes de calcular
- **Composer:** Generar narrativa del reporte automáticamente

**P: ¿Hay límite en cuántas veces puedo usar Stella?**
R: Sí. Tu organización tiene una cuota mensual (Org Admin maneja esto). Cada uso de Stella consume tokens.

**P: ¿Stella sustituye al equipo humano?**
R: No. Stella es un asistente. Decisiones críticas (valores, allocations, estrategia) deben ser tomadas por humanos.

### Datos y Seguridad

**P: ¿Quién puede ver mis proyectos?**
R: Solo miembros de tu organización con rol adecuado. Los datos están completamente aislados por organización.

**P: ¿Se guardan automáticamente los cambios?**
R: Sí. Uellix guarda cambios cuando haces clic en "Guardar" o cuando completas un campo.

**P: ¿Puedo descargar mis datos?**
R: Sí. Cada reporte puede descargarse como PDF. Contact us para exportar datos en otros formatos.

**P: ¿Hay historial de cambios?**
R: Sí. Admin puede ver audit logs de todas las acciones (quién cambió qué, cuándo).

---

## Buenas Prácticas

### 1. **Comienza con lo que tienes**
No esperes datos perfectos. Comienza con lo mejor disponible y refina iterativamente.

### 2. **Implica al equipo desde el inicio**
- Stakeholder identification requiere conocimiento del terreno
- Allocations requieren alineación con financiadores
- Proxies requieren expertise programático

### 3. **Documenta tu metodología**
En la sección de Narrativa y proxies, explica por qué elegiste ciertos valores. Esto ayuda a reproducibilidad.

### 4. **Revisa regularmente**
- Recalcula anualmente con nuevos datos
- Compara año a año
- Detecta trends

### 5. **Comunica resultados**
- Reportes visuales para ejecutivos
- Reportes detallados para donantes
- Storytelling basado en datos

### 6. **Solicita feedback**
Usa la función de comentarios para que colegas revisen borradores antes de finalizar.

---

## Contacting Support

**¿Problemas técnicos?**
- Email: support@uellix.org
- Portal: help.uellix.org

**¿Preguntas metodológicas de SROI?**
- Consulta metodología oficial: [link]
- Webinars trimestrales: [link]
- Comunidad de usuarios: [link]

---

**© 2026 Uellix. Todos los derechos reservados.**

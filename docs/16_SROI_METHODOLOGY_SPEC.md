# 16 — SROI Methodology Spec

## Propósito

Definir cómo Uellix implementa el proceso SROI de forma transparente, trazable y rigurosa.

## Flujo principal

```txt
Narrativa de impacto
→ Stakeholders
→ Resultados esperados
→ Indicadores
→ Evidencias
→ Proxies financieros
→ Filtros SROI
→ Valor social neto
→ Inversión
→ Ratio SROI
→ Stella Review
→ Impact Deck / reporte audit-ready
```

## Elementos del cálculo

### Outcome

Resultado de cambio atribuible al proyecto para un grupo de interés.

### Indicador

Medida cuantitativa o cualitativa que permite observar el outcome.

### Evidencia

Soporte documental o dato que respalda el indicador/outcome.

### Proxy financiero

Valor monetario usado para estimar el valor del outcome.

### Cantidad

Número de unidades, personas, eventos o magnitud del cambio.

### Filtros SROI

Ajustes metodológicos:
- deadweight;
- attribution;
- displacement;
- drop-off;
- duración;
- tasa de descuento.

### Inversión

Recursos invertidos para lograr el impacto.

## Fórmula base

Valor bruto del outcome:

```txt
Gross Outcome Value = Quantity × Proxy Value
```

Valor ajustado:

```txt
Adjusted Value = Gross Outcome Value
× (1 - Deadweight)
× (1 - Attribution)
× (1 - Displacement)
× Duration/Discount/Drop-off adjustment
```

Valor social neto:

```txt
Net Social Value = Sum of adjusted outcome values
```

Ratio SROI:

```txt
SROI Ratio = Net Social Value / Total Investment
```

## Transparencia

El sistema debe mostrar:
- fórmula;
- valores usados;
- proxies;
- fuentes;
- filtros;
- justificaciones;
- sensibilidad;
- limitaciones.

## Ajustes por usuario

El usuario puede ajustar:
- deadweight;
- attribution;
- displacement;
- drop-off;
- duración;
- tasa de descuento;
- cantidades;
- selección de proxies.

Todo ajuste debe tener:
- justificación;
- usuario;
- fecha;
- audit log;
- impacto en cálculo.

## Soporte para diversidad de proyectos

Uellix debe permitir proyectos en diferentes áreas:
- educación;
- salud;
- inclusión;
- empleo;
- sostenibilidad;
- innovación social;
- discapacidad;
- juventud;
- género;
- desarrollo territorial;
- emprendimiento;
- seguridad alimentaria;
- cambio climático.

No debe asumir una sola teoría de cambio ni un solo tipo de resultado.

## SROI Readiness Score

Indicador de qué tan preparado está el análisis para revisión.

Dimensiones sugeridas:
1. Completitud de narrativa.
2. Calidad de outcomes.
3. Calidad de indicadores.
4. Cobertura de evidencias.
5. Robustez de proxies.
6. Justificación de filtros.
7. Transparencia de cálculo.
8. Riesgos metodológicos.
9. Trazabilidad documental.
10. Versionamiento y audit trail.

Escala sugerida:
```txt
0–100
```

Categorías:
```txt
0–39: Low readiness
40–69: Moderate readiness
70–84: Strong readiness
85–100: Audit-ready candidate
```

Importante:
El score no certifica impacto. Indica preparación para revisión.

## Stella Validator

Debe revisar:
- outcomes sin indicador;
- indicadores sin evidencia;
- proxies sin fuente;
- filtros sin justificación;
- riesgo de doble conteo;
- claims excesivos;
- falta de inversión;
- inconsistencias entre narrativa y cálculo.

## Reporte

El reporte debe incluir:
- resumen ejecutivo;
- teoría de cambio;
- metodología;
- outcomes;
- indicadores;
- evidencias;
- proxies;
- filtros;
- cálculo;
- ratio SROI;
- SROI Readiness Score;
- revisión Stella;
- limitaciones;
- audit trail;
- anexos.

## Regla de claims

El reporte debe evitar afirmaciones absolutas. Debe diferenciar:

- datos observados;
- supuestos;
- estimaciones;
- interpretaciones;
- limitaciones;
- riesgos metodológicos.

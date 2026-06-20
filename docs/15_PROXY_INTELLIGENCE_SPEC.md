# 15 — Proxy Intelligence Spec

## Definición

Proxy Intelligence es el módulo que ayuda a seleccionar, justificar y auditar proxies financieros para monetizar outcomes en análisis SROI.

## Principio central

Todo proxy debe ser trazable, defendible y respaldado por fuente oficial o altamente reconocida.

## Fuentes prioritarias

- PNUD / UNDP.
- Banco Mundial.
- World Economic Forum.
- OECD.
- Naciones Unidas.
- BID.
- CEPAL.
- Organismos estadísticos oficiales.
- Ministerios.
- Entidades públicas verificables.
- Fuentes académicas reconocidas cuando aplique.

## Tipos de proxy

- Costos evitados.
- Disposición a pagar.
- Costos de reemplazo.
- Valor económico equivalente.
- Ahorros institucionales.
- Incremento de ingresos.
- Reducción de costos sociales.
- Indicadores macroeconómicos aplicables.
- Valores públicos territoriales.

## Campos requeridos

- nombre;
- descripción;
- outcome asociado;
- fuente;
- URL;
- organización fuente;
- país;
- territorio;
- moneda;
- valor;
- año;
- tema;
- metodología;
- justificación;
- nivel de confianza;
- riesgo metodológico;
- notas de ajuste territorial;
- fecha de consulta;
- estado;
- aprobado por;
- fecha de aprobación.

## Estados

```txt
suggested
pending_review
approved
rejected
archived
```

## Reglas

1. Stella puede sugerir proxies.
2. Un humano debe aprobar proxies.
3. No se puede usar un proxy rechazado.
4. No se puede aprobar proxy sin fuente.
5. No se puede aprobar proxy sin valor y año.
6. Todo ajuste territorial debe justificarse.
7. Todo proxy usado en cálculo debe quedar congelado en snapshot.
8. Los reportes deben mostrar fuentes y limitaciones.

## Stella y proxies

Stella puede:
- sugerir posibles proxies;
- explicar pertinencia;
- advertir riesgos;
- proponer ajustes territoriales;
- comparar alternativas.

Stella no puede:
- inventar fuente;
- inventar valor;
- aprobar proxy;
- ocultar incertidumbre;
- presentar proxy débil como robusto.

## Banco inicial

El MVP debe permitir banco curado manualmente.

Categorías iniciales sugeridas:
- educación;
- salud;
- empleo;
- ingresos;
- inclusión social;
- discapacidad;
- emprendimiento;
- sostenibilidad ambiental;
- reducción de violencia;
- bienestar;
- participación comunitaria.

## Búsqueda

Filtros:
- tema;
- país;
- fuente;
- año;
- moneda;
- nivel de confianza;
- estado;
- tipo de proxy.

## Nivel de confianza

```txt
high
medium
low
```

Criterios:
- calidad de la fuente;
- actualidad;
- correspondencia territorial;
- correspondencia temática;
- claridad metodológica;
- disponibilidad de documentación.

## Riesgo metodológico

```txt
low
medium
high
```

Riesgos:
- proxy demasiado general;
- año desactualizado;
- territorio no comparable;
- fuente secundaria;
- valor no monetario transformado;
- relación débil con outcome;
- riesgo de doble conteo.

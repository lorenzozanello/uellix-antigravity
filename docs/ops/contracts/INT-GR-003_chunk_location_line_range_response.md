# INT-GR-003 — `ChunkLocation` no reconstruible (respuesta de GROUNDING, tren 4)

| Campo | Valor |
|---|---|
| Emisor | GROUNDING (`codex/stella-grounding`), tren 4 |
| Responde a | [INT-GR-003](CONTRACT_LEDGER.md#int-gr-003--chunklocation-no-reconstruible-tren-3) |
| Propietaria del cambio pendiente | **CAPABILITIES** (dos columnas en `evidence_chunks`) |
| Estado declarado | **`DECIDIDO_POR_GROUNDING__SQL_PENDIENTE`** |
| Fecha | 2026-08-05 |

> Este documento **no modifica `CONTRACT_LEDGER.md`**.

## 1. La elección que integración no hizo, hecha

La solicitud ofrecía dos salidas: **persistir las dos columnas**, o **hacerlas
nulables en el contrato**. GROUNDING elige la primera, y descarta la segunda
por una razón que no es de gusto.

## 2. Por qué no se hacen nulables

Dos motivos, en orden de peso.

**(a) La segunda opción no es alcanzable desde esta línea sin romper rutas
ajenas.** `lineStart` / `lineEnd` los leen hoy
`components/stella/grounding-adapter.ts` (que compone la etiqueta «líneas
12–18») y `tests/eval/stella-release/harness.ts` (que valida que el rango no
esté invertido). Ambos están fuera de las rutas autorizadas de GROUNDING en
este tren. Ensanchar el tipo a `number | null` dejaría el typecheck del
proyecto roto y la reparación sería trabajo de PRODUCT y de la línea de
release — es decir, se pagaría el coste en dos líneas para expresar un estado
que ya se puede expresar aquí.

**(b) El rango de líneas no es reconstruible, y eso no cambia con el tipo.**
Las líneas son posiciones en el texto normalizado **del documento entero**.
`chunks_in_scope` devuelve el texto de **un** chunk, no el del documento. Así
que ni el adaptador ni un verificador externo pueden recalcularlas desde lo que
`evidence_chunks` almacena hoy. Persistir es la única salida real; nulable sólo
cambia cómo se nombra el hueco.

## 3. Qué añadió GROUNDING mientras tanto

`lib/grounding/contracts/chunks.ts`:

```ts
export const LINE_RANGE_NOT_PERSISTED = 0 as const
export function hasResolvedLineRange(location: ChunkLocation): boolean
```

Esto **eleva a contrato el centinela que integración ya usaba**
(`LINE_RANGE_NOT_PERSISTED` en `db/grounding/grounding-chunk-repository.ts`),
en vez de dejarlo como una constante local de un adaptador. Tres consecuencias:

1. `0` queda **fuera del dominio documentado 1-based**, que es exactamente por
   qué funciona: cualquier valor dentro del dominio haría «no lo sabemos»
   indistinguible de «línea 1».
2. Un consumidor pregunta `hasResolvedLineRange(location)` en lugar de comparar
   con un cero mágico cuyo significado hay que recordar.
3. El tipo sigue siendo `number`, así que **nada fuera de esta línea tiene que
   cambiar** para que la mejora exista.

La cabecera de `ChunkLocation` documenta ahora el porqué completo, incluido que
la petición a CAPABILITIES sigue en pie.

## 4. Qué pide GROUNDING a CAPABILITIES

Añadir a `public.evidence_chunks` dos columnas nulables:

```sql
line_start integer,
line_end   integer
```

y aceptarlas en el payload de `insert_evidence_chunks` junto a
`char_start` / `char_end`. El valor lo calcula ya la línea de grounding con
`lineRangeForSpan(document.text, span)`, en el mismo punto donde deriva el
span, así que el orquestador de ingestión sólo tiene que dejar de descartarlo:
`buildEvidenceChunkPayload` en `lib/grounding/ingest/persistence.ts` gana dos
campos y ninguna lógica nueva.

**Nulables, no `NOT NULL`:** las filas que ya existan bajo el esquema actual no
tienen el dato y no se puede derivar para ellas. Una columna obligatoria
forzaría a rellenarlas con un valor inventado, que es el fallo que este
contrato existe para evitar.

Cuando las columnas existan, `LINE_RANGE_NOT_PERSISTED` deja de ser alcanzable
desde el adaptador persistido y puede retirarse del contrato en un tren
posterior.

## 5. Lo que no cambió

`sectionLabel` sigue siendo nulable y se mapea a `null` sin problema; no forma
parte de esta petición. El span sigue siendo **la autoridad** — el rango de
líneas es derivado y así lo dice el contrato desde el tren 1.

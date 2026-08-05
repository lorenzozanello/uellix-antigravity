# INT-GR-004 — `chunks_in_scope` debería devolver el scope de la fila (respuesta de GROUNDING, tren 4)

| Campo | Valor |
|---|---|
| Emisor | GROUNDING (`codex/stella-grounding`), tren 4 |
| Responde a | [INT-GR-004](CONTRACT_LEDGER.md#int-gr-004--chunks_in_scope-debería-devolver-el-scope-de-la-fila) |
| Propietaria del cambio pendiente | **CAPABILITIES** (dos columnas en el `RETURNS TABLE`) |
| Estado declarado | **`CONTRATO_PREPARADO__SQL_PENDIENTE`** |
| Fecha | 2026-08-05 |

> Este documento **no modifica `CONTRACT_LEDGER.md`**.

## 1. El diagnóstico se acepta sin matizarlo

`chunks_in_scope` devuelve trece columnas y ni `organization_id` ni
`project_id` están entre ellas. El adaptador no puede leer el scope de la fila
y lo estampa desde la consulta. Por tanto `isSameScope` / `scopeContains`
dentro de `assertChunkSatisfiesQuery` **comparan la consulta consigo misma**
contra el único repositorio de producción. Sus comprobaciones de `evidenceId` y
`versionId` sí son reales, porque esos campos sí vienen de columnas devueltas.

La imposición efectiva descansa en tres afirmaciones SQL y en cero de
TypeScript. Es suficiente. **No es lo que un lector de
`enforceRepositoryScope` supondría**, y eso es el defecto.

## 2. Qué NO se hizo

No se añadió una cuarta comprobación que leyera los campos fabricados. La
resolución del tren 3 lo prohíbe explícitamente y tiene razón: parecería
verificación y no verificaría nada.

**Y hay que decirlo del tipo nuevo también.** `ChunkScopeAttestation` **no
demuestra** que un scope venga de una fila gobernada. Ningún tipo puede: un
adaptador que fabricara `{ source: 'governed_row', ... }` desde sus propios
argumentos de consulta pasaría todas las comprobaciones, porque los valores
fabricados coincidirían con todo aquello contra lo que se comparan.

## 3. Qué sí compra el contrato nuevo

`lib/grounding/retrieve/repository.ts` publica:

```ts
export interface ChunkScopeAttestation {
  readonly source: 'governed_row'
  readonly scope: GroundingScope     // organización Y proyecto, TAL COMO SE DEVOLVIERON
  readonly evidenceId: string
  readonly versionId: ContentHash
  readonly chunkId: ContentHash
}

export interface UnattestedChunkScope {
  readonly source: 'restated_from_query'
  readonly reason: string
}

export type ChunkScopeProvenance = ChunkScopeAttestation | UnattestedChunkScope
```

Hace **el hueco irrepresentable por omisión**, que es una cosa distinta y
alcanzable:

1. **`source` es una afirmación deliberada y revisable.** Un adaptador que no
   puede leer el scope de la fila tiene que escribir `UnattestedChunkScope` y
   decir por qué. No llega a `'governed_row'` por olvido ni por un cast — que es
   la vía de compatibilidad temporal que la petición pide **explícita, nunca
   silenciosa**.
2. **Bajo `requireScopeAttestation`, un repositorio sin atestación falla**, en
   vez de pasar una comprobación vacía. Un repositorio que directamente no
   implemente `attestScope` se trata igual que uno que declara no poder: nunca
   como atestado.
3. **Los cinco campos se contrastan contra el chunk Y contra la consulta.**
   Tres de ellos (`chunkId`, `evidenceId`, `versionId`) **ya no son
   tautológicos hoy**, porque vienen de columnas reales — así que una atestación
   que se contradice con el chunk que describe se detecta **ahora**, no cuando
   lleguen las columnas de scope.
4. **No se corre ninguna comprobación sustituta** cuando la atestación falta.
   Fijado por prueba: el `restated_from_query` no dispara ninguna comparación de
   scope, y el chunk cruzado que sí se atrapa lo atrapa
   `assertChunkSatisfiesQuery` leyendo el scope **del chunk**, que es otro valor.

`InMemoryChunkRepository` implementa `attestScope` **de verdad**: sus filas son
`GroundingChunk` producidos por ingestión, con el scope estampado en el
troceado — un origen distinto del de la consulta. Así que en esa ruta la
comprobación ya es portante, y la suite
(`lib/grounding/__tests__/scope-attestation.test.ts`, 15 pruebas) la ejercita
ahí.

## 4. Por qué el requisito está apagado por defecto

`requireScopeAttestation` es `false` salvo que el llamante lo pida. No es una
preferencia: el único repositorio de producción se apoya en `chunks_in_scope`,
que no devuelve las dos columnas. Ponerlo en `true` hoy haría fallar **todas**
las consultas reales mientras el SQL que lo satisfaría pertenece a otra línea —
convertiría un contrato abierto en una caída.

Se enciende el día en que las columnas se devuelvan, y de una sola línea:

```ts
runGroundedQuery({ ..., retrieval: { requireScopeAttestation: true } })
```

## 5. Qué pide GROUNDING a CAPABILITIES

Añadir dos columnas al `RETURNS TABLE` de
`uellix_grounding.chunks_in_scope`:

```sql
organization_id uuid,
project_id      uuid,
```

seleccionadas de la fila de `public.evidence_chunks`, **no de los argumentos**.
Esa distinción es todo el contrato: `SELECT p_organization_id, p_project_id`
compilaría, pasaría estas pruebas y no arreglaría nada.

Con eso, `assertScopeAttestation` pasa a ser el primer TypeScript capaz de
observar una fila cruzada, y el guard deja de ser decorativo sin que ninguna
comprobación nueva se invente.

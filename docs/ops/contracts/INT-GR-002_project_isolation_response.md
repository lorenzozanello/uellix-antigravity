# INT-GR-002 — Aislamiento por proyecto en `validateAnswerCitations` (respuesta de GROUNDING, tren 4)

| Campo | Valor |
|---|---|
| Emisor | GROUNDING (`codex/stella-grounding`), tren 4 |
| Responde a | [INT-GR-002](CONTRACT_LEDGER.md#int-gr-002--aislamiento-por-proyecto-a-f1-tren-3), solicitado por INTEGRACIÓN |
| Estado declarado | **`YA_RESUELTO_EN_HEAD`** — cerrado en `8b8693e`, anterior al HEAD del tren 3 |
| Fecha | 2026-08-05 |

> Este documento **no modifica `CONTRACT_LEDGER.md`**.

## 1. La solicitud describe un estado que el código ya no tiene

INT-GR-002 dice, y `docs/ops/workstreams/GROUNDING.md` §«Contratos abiertos
hacia esta línea» repite, que «A-F1 sigue abierto: `validateAnswerCitations`
compara sólo `organizationId`».

**Eso dejó de ser cierto en `8b8693e` — `fix(stella): enforce project isolation
in citations`, 2026-08-04 — que es antepasado del HEAD del tren 3
(`6f3c543`).** La descripción del contrato quedó desactualizada respecto del
árbol que integración ya tenía delante.

Verificable en un comando:

```bash
git merge-base --is-ancestor 8b8693e HEAD && echo "el arreglo está en HEAD"
```

## 2. Qué hay hoy en el contrato

`lib/grounding/contracts/answer.ts`:

- `CitableChunkRecord` lleva `scope: GroundingScope` — **organización y
  proyecto**, no un `organizationId` suelto. La forma anterior era
  `{ contentHash, organizationId }`, en la que la mitad de proyecto de la
  frontera no estaba «sin comprobar»: era **irrepresentable**, y ningún cuidado
  en el sitio de llamada podría haberla suministrado.
- `validateAnswerCitations` compara con
  `scopeContains(state.query.scope, chunk.scope)`, que es la relación correcta
  para este dominio: un lector org-wide (`projectId: null`) puede leer filas de
  un proyecto; un lector de proyecto no puede leer las de otro, ni las
  org-wide.
- El hallazgo se emite como `citation_out_of_scope`, y el orden de las
  comprobaciones lo pone **primero**: una cita fuera de la frontera se reporta
  como tal y nunca se degrada a un hallazgo más leve sobre su contenido.
- `toCitableChunkRecord(chunk)` existe para que el mapa de validación no se
  construya campo a campo — cada campo copiado a mano es un campo que se puede
  copiar del sitio equivocado, y los campos en cuestión son precisamente la
  frontera de aislamiento.

## 3. Pruebas que lo fijan

En este tren se añadieron ejecuciones de extremo a extremo, no sólo unitarias
del validador (`lib/grounding/__tests__/grounded-query.test.ts` §2):

- una consulta de `proj-1111` contra un corpus ingerido en `proj-2222` **no
  devuelve candidatos** y se abstiene;
- una consulta contra otra organización, igual;
- un repositorio que **filtra a través de la frontera de proyecto** hace
  **lanzar** al recorrido completo (`GroundingScopeViolationError`), no
  responder degradado;
- lo mismo a través de la frontera de organización;
- un repositorio que ignora su filtro de `evidenceIds` lanza
  `RepositoryContractViolationError`.

`lib/grounding/__tests__/isolation.test.ts` (tren 2) sigue cubriendo el
validador aisladamente.

## 4. Qué pide GROUNDING a integración

1. **Mover la fila del ledger** de `solicitado` a resuelto, citando `8b8693e`.
2. **Corregir la prosa de `GROUNDING.md`** líneas 929-933, que sigue afirmando
   que A-F1 está abierto. Esta línea corrigió su propia sección (véase
   «Tren 4» en ese archivo) pero no reescribe el registro histórico del tren 3,
   que es de integración.
3. **Conservar la doble afirmación del adaptador.** La solicitud dice que
   integración declara `project_id` explícitamente en su `WHERE` y que
   `chunks_in_scope` lo declara una segunda vez, «porque la capa de abajo no
   puede confiarse». La premisa cambió, la conclusión **no**: la policy RLS de
   `evidence_document_versions` sigue siendo org-scoped y no project-scoped, así
   que el predicado explícito **no es redundante** y quitarlo dejaría el
   aislamiento por proyecto apoyado en una sola afirmación. No se quite.

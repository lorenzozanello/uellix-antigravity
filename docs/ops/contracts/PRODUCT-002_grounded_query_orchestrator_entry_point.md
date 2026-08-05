# PRODUCT-002 — Punto de entrada del orquestador de consulta fundamentada

**Línea solicitante:** PRODUCT
**Línea propietaria:** INTEGRACIÓN (la ruta es INTEGRATION-OWNED; el orquestador
que debe invocar es de GROUNDING)
**Estado:** `solicitado` (PRODUCT tren 3, 2026-08-05)
**Depende de:** [INTEGRATION-001](INTEGRATION-001_grounding_product_citation_adapter.md)
(`aceptado`), [PRODUCT-001](PRODUCT-001_grounded-citation-provenance.md) (`aceptado`)

> El estado de la fila del ledger lo fija integración (§8 del documento de
> gobernanza). Esta línea abre la solicitud; no escribe
> `CONTRACT_LEDGER.md` ni se marca a sí misma `aceptado`.

## Por qué existe esta solicitud

Al cerrar el tren 2, PRODUCT tenía el adaptador completo y probado y **cero
call sites fuera de `components/stella/**`**. Era coherente con lo declarado
—INTEGRATION-001 anticipó que sin retrieval no habría `RetrievalCandidate` en
runtime— pero significaba que `StellaGroundedAnswerPanel` y el modo `citations`
de `StellaEvidencePanel` renderizaban un valor que nada producía.

El tren 3 cierra la mitad que le corresponde a esta línea: existe ahora un
contenedor de runtime (`StellaGroundedQueryPanel`) que hace el ciclo completo
—pregunta, carga, respuesta o error, decisión humana— y un tipo que describe
exactamente qué recibe (`grounded-query.ts`).

Lo que **no** puede hacer esta línea es escribir el otro extremo de esa costura.
El punto de entrada tiene que correr en el servidor, leer el scope de la sesión
autenticada, aplicar banderas y cuota, y hablar con el orquestador de GROUNDING.
Las tres cosas están fuera de las rutas autorizadas de PRODUCT (§3 y §7 de
`STELLA_PARALLEL_WORKSTREAMS.md`), así que §12 aplica: no se modifica el archivo,
se registra la solicitud.

## Qué se pide, exactamente

Una server action —o el archivo que integración decida— que satisfaga el tipo ya
publicado en [`components/stella/grounded-query.ts`](../../../components/stella/grounded-query.ts):

```ts
export type StellaGroundedQueryRunner = (
  request: StellaGroundedQueryRequest,   // { readonly query: string }
) => Promise<StellaGroundedQueryResult>  // ok + answerId + GroundedAnswerView
                                         // | error + StellaPanelErrorCode + message
```

`StellaGroundedQueryResult` no es una forma nueva: la mitad exitosa es el
`GroundedAnswerView` que produce `adaptGroundedAnswer` (INTEGRATION-001), y la
mitad de error es la taxonomía de 12 códigos `StellaPanelErrorCode` que las
cinco server actions de Stella ya devuelven. Se reutiliza en vez de inventarse
para que quien llame no aprenda un segundo vocabulario de error y para que
`StellaErrorNotice` la renderice sin cambios.

### 1. Invocar el orquestador de Grounding

El punto de entrada llama al pipeline de GROUNDING y adapta su salida con
`adaptGroundedAnswer` / `presentationInputFromRetrieval`
([`components/stella/grounding-adapter.ts`](../../../components/stella/grounding-adapter.ts)),
que ya es la única función autorizada a producir el modelo de presentación.

**No** debe construir un `GroundedAnswerView` a mano, ni derivar citas de otra
cosa que no sea `CitationReference` + `GroundingChunk` + `RetrievalCandidate`.
Un `GroundedAnswerView` fabricado en el servidor sería exactamente la segunda
forma de provenance que INTEGRATION-001 §2 prohíbe, con el agravante de que
llegaría a pantalla indistinguible de una verificable.

### 2. Transportar el scope autenticado — nunca el del cliente

`StellaGroundedQueryRequest` lleva **un solo campo**, `query`, y eso es
deliberado. El scope (`organizationId` / `projectId`) debe salir de
`requireOrganizationAccess` como ya lo hace `getStellaContextualAdvisor`
([`app/actions/stella/advisor.ts`](../../../app/actions/stella/advisor.ts)):
el llamante puede, como mucho, nombrar un `projectId`, y la construcción de
contexto lo rechaza si no pertenece a la organización de esa sesión.

Del lado del cliente esto está fijado por una prueba que compara el **conjunto
de claves** de la petición, no su contenido — `toHaveBeenCalledWith({ query })`
seguiría verde ante una petición que además llevara `organizationId`.

**Advertencia heredada, no cerrada:** A-F1 sigue abierto en GROUNDING —
`validateAnswerCitations` compara sólo `organizationId`, así que una cita de
**otro proyecto de la misma organización** se valida como correcta. Mientras eso
siga así, el punto de entrada no puede delegar el aislamiento por proyecto en esa
función. PRODUCT no lo compensa en la UI a propósito: reimplementar el scope en
un módulo de presentación crearía una segunda respuesta, divergente, a «¿puede
leerse esto?».

### 3. Transportar la query

Sin reescribirla, sin expandirla y sin fusionarla con contexto del proyecto de
forma que el usuario no pueda ver qué se preguntó. La `RetrievalQuery` que
GROUNDING recibe lleva el texto y el scope; el scope lo pone el servidor (§2).

### 4. Devolver la respuesta tipada

`{ status: 'ok', answerId, answer }`. `answerId` es obligatorio y **no lo puede
derivar el cliente**: es la identidad a la que se ata la decisión humana
(accept / edit / reject / undo) cuando se persista. Un id generado en el
navegador haría que dos pestañas produjeran dos identidades para el mismo
intercambio.

`requiresHumanReview` viaja dentro de `GroundedAnswerView` y es literalmente
`true` en el contrato de GROUNDING. No es un default de UI que alguien pueda
apagar desde el servidor.

### 5. Aplicar feature flags

Con el mismo mecanismo que el resto: `stellaConfig` / `stellaState`
([`lib/stella/config.ts`](../../../lib/stella/config.ts)), bandera **primero**,
antes de tocar nada. Con la bandera apagada se devuelve
`{ status: 'error', code: 'DISABLED' }` y no se llama al orquestador.

Esta unidad **no habilita ninguna capacidad y no crea ninguna bandera nueva**.
Si el punto de entrada necesita una (p. ej. `STELLA_GROUNDED_QUERY_ENABLED`),
`.env.example` es INTEGRATION-OWNED (§7): la añade integración, con valor
`false`, como se hizo con `CT-CAP-004`.

### 6. Aplicar cuota

`checkStellaQuota` / `nextQuotaResetIso` / `formatQuotaResetDate`, y
`consumeStellaRateLimit` para el límite por hora — los mismos que ya usa el
advisor. Los mensajes de `QUOTA_EXCEEDED` llegan a pantalla **textualmente**
(`stellaErrorPresentation` los pasa sin tocar, porque llevan cuota, uso y fecha
de reinicio), así que el servidor es responsable de que ese texto sea correcto
y esté en español.

`QUOTA_EXCEEDED` y `RATE_LIMITED` **no** son reintentables en la presentación, y
eso ya está decidido en `error-messages.ts`: la UI no ofrece «Reintentar» para
ninguno de los dos. El servidor no necesita hacer nada al respecto salvo no
enviar el código equivocado.

### 7. Sanitizar errores

Ningún error de proveedor, stack, nombre de tabla, fragmento de prompt o clave
puede cruzar la costura. `message` es para leer, no para diagnosticar. El patrón
existe: `buildGeminiErrorLog` registra el error real del lado servidor con
prefijo `[stella]` y la clave redactada, y devuelve `GEMINI_ERROR` al cliente.

El panel ya trata cualquier excepción no capturada del runner como
`UNKNOWN_ERROR` con mensaje vacío. Eso es una red de seguridad, no un permiso
para dejar que se propague algo con contenido sensible.

## Qué NO se pide

- **No se pide implementar retrieval.** Sigue sin existir, y ese es el orden
  correcto: sin él no hay `RetrievalCandidate` real y el punto de entrada no
  tendría qué adaptar. Esta solicitud describe la costura; su implementación
  útil espera a que GROUNDING tenga retrieval con datos.
- **No se pide persistir la decisión humana aquí.** Ya existe
  `recordStellaDecision`, con la bandera `STELLA_DECISIONS_PERSISTENCE_ENABLED`
  aplicada **antes** de tocar la base, y `persistStellaDecision` traga su
  `DISABLED` en silencio porque es el resultado esperado hasta el gate G2. El
  panel fundamentado emite `onDecision` y deja que el llamante lo cablee, igual
  que `StellaContextualAdvisorField`. Añadir persistencia dentro del punto de
  entrada crearía una segunda respuesta a «¿esto se guardó?».
- **No se pide resolver la atribución de contradicción.** El hallazgo A-M del
  tren 2 —una afirmación que cita un chunk nombrado por *cualquier*
  `ContradictionMarker` se pinta como `contradictory_evidence`, aunque la
  contradicción sea sobre otro dato del mismo chunk— **no es reparable ni en el
  adaptador ni aquí**: `sideA`/`sideB` son `CitationReference[]`, y dos
  afirmaciones que citan el mismo chunk producen la misma `CitationReference`.
  Atribuir a nivel de afirmación exige que el marcador nombre afirmaciones, que
  es un cambio del contrato de GROUNDING y sigue siendo petición a esa línea.
- **No se pide certificar nada.** La respuesta es orientación consultiva; el
  panel lo dice en pantalla y `requiresHumanReview` lo dice en el tipo.

## Criterio de aceptación

Integración puede marcar este contrato `aceptado` cuando exista un módulo que:

1. satisfaga `StellaGroundedQueryRunner` sin que `components/stella/**` lo
   importe (la costura es una prop; el cableado ocurre en la página);
2. obtenga el scope de `requireOrganizationAccess` y no de su argumento;
3. devuelva `DISABLED` con la bandera apagada sin llamar al orquestador;
4. devuelva `QUOTA_EXCEEDED` con el mensaje del servidor intacto;
5. no deje pasar ningún detalle de proveedor en `message`;
6. produzca su `GroundedAnswerView` mediante `adaptGroundedAnswer`, no a mano.

Los seis son verificables sin retrieval real. El séptimo —que la respuesta sea
útil— no lo es, y por eso no está en la lista.

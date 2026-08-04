# CT-CAP-001 — Contratos de aplicación para CAP-01 … CAP-05

| Campo | Valor |
|---|---|
| **Solicitante** | CAPABILITIES |
| **Propietaria** | CAPABILITIES |
| **Estado** | `solicitado` |
| **Fecha** | 2026-08-04 |
| **Módulo** | `lib/capabilities/contracts.ts` |
| **Consumidores previstos** | PRODUCT, RELEASE |

## 1. Qué se publica

Un módulo TypeScript **sin importaciones**: tipos más constantes congeladas.
No importa `@/db/client`, ni driver, ni el SDK de Stripe, ni `zod`. Importarlo
desde un componente cliente, una server action, una ruta o un test no abre
nada. En el momento en que necesite una conexión deja de ser un contrato.

### 1.1 Vocabulario común — `CapabilityResult<T>`

Los cinco paquetes contestan en un vocabulario deliberadamente pobre: cada
función `SECURITY DEFINER` colapsa «no tienes permiso», «no existe esa fila» y
«ese argumento está fuera de rango` en **un** refusal —
`capability request denied`, SQLSTATE `U0001`— justamente para que la
diferencia no sirva de oráculo. Esa propiedad se conserva, y por eso mismo un
error del driver es lo que **no** hay que entregarle a una UI: lleva mensaje, a
veces el texto de la sentencia, y ninguna forma estable.

La frontera se enuncia una vez como un conjunto **cerrado** de resultados:

| `outcome` | Significado | ¿Reintentable? |
|---|---|---|
| `succeeded` | La capacidad hizo la operación | no |
| `idempotent` | Ya la había hecho; nada cambió — es éxito, no error | no |
| `denied` | Refusal terminal (`U0001`, o `U0002` para slug tomado) | no |
| `contended` | Conflicto de bloqueo/serialización transitorio (`U0003`) | **sí** |
| `unavailable` | La capacidad está apagada. **No se intentó nada** | depende |

`unavailable` no es un modo de fallo de la base de datos: es el estado en que
están hoy las cinco capacidades —cinco paquetes diseñados, ninguno aplicado,
todas las banderas en `false`—. Quien no pueda expresar «apagado» como
resultado de primera clase acaba deletreándolo como excepción, y entonces
«apagado» y «roto» son la misma línea de log.

### 1.2 SQLSTATEs

| Código | Constante | Semántica |
|---|---|---|
| `U0001` | `CAPABILITY_SQLSTATE.DENIED` | Refusal uniforme, terminal |
| `U0002` | `CAPABILITY_SQLSTATE.SLUG_TAKEN` | **Sólo CAP-05.** Separado porque es el único refusal sobre el que un usuario puede actuar («elige otro nombre»); colapsarlo en `U0001` haría indistinguible un error de formulario corregible de una denegación |
| `U0003` | `CAPABILITY_SQLSTATE.CONTENDED` | Contención transitoria, reintentable |

**Cualquier otro SQLSTATE es un error inesperado y debe propagarse.** No se
mapea a un resultado. Contestar «reintenta» a todo convierte un defecto
permanente en un bucle infinito de reintentos, que es la misma pérdida
silenciosa con la máscara contraria.

### 1.3 Exhaustividad

`assertNeverCapabilityOutcome(outcome: never): never` es la garantía de que el
conjunto sigue cerrado entre cuatro líneas de trabajo. Todo consumidor que haga
`switch` sobre `outcome` debe cerrar con
`default: return assertNeverCapabilityOutcome(x)`; añadir un miembro rompe
entonces la compilación en cada punto de consumo en vez de caer por defecto en
silencio.

`isRetryableCapabilityResult()` deriva la reintentabilidad **del resultado,
nunca de `error.message`**. Un mensaje no es una interfaz.

## 2. Contratos por capacidad

| Capacidad | Tipo de carga | Función SQL de referencia |
|---|---|---|
| **CAP-01** Invitación | `InvitationAcceptance { organizationId, memberRole }` | `uellix_capability.accept_invitation(text)` |
| **CAP-02** Verificación pública | `PublicVerification` (11 campos) | `uellix_capability.verify_report(text)` |
| **CAP-03** Evento Stripe | `StripeEventResult` (disposición cerrada + `httpStatus`) | `stripe_begin_event` / `stripe_apply_subscription` / `stripe_fail_event` |
| **CAP-04** Lead público | `PublicLeadSubmission { accepted: true }` | `uellix_capability.submit_lead(text,text,text,text)` |
| **CAP-05** Bootstrap de organización | `OrganizationBootstrap { organizationId, slug }` | `uellix_capability.bootstrap_organization(uuid,text,text,text,text,text)` |

### 2.1 Tres decisiones que no son estilo

1. **Las columnas `numeric` de CAP-02 viajan como `string`.** `numeric` es
   precisión arbitraria y el `number` de JavaScript es binario64: parsear aquí
   redondearía en silencio un valor que el pipeline calcula con `decimal.js`
   precisamente para no redondear. El consumidor formatea la cadena o se la
   pasa a una librería decimal.
2. **CAP-04 sólo expone `accepted: true`.** `submit_lead` es `RETURNS void`, y
   eso es una decisión de seguridad: sin valor de retorno un envío duplicado es
   indistinguible de uno nuevo, así que un endpoint público sin autenticar no
   puede usarse para comprobar si una dirección ya se conoce. `accepted` significa
   «la capacidad no refusó», nunca «esta dirección era nueva».
3. **CAP-03 nunca devuelve una organización.** Ver CAP_03_STRIPE.md §8 y la
   cabecera de `lib/capabilities/stripe-webhook.ts`: la correlación viaja, la
   resolución ocurre dentro de `stripe_apply_subscription` bajo las policies
   `RESTRICTIVE` `cap_stripe_only_claimed_read` / `cap_stripe_only_claimed_org`.

### 2.2 `StripeEventResult` — las seis disposiciones

| `disposition` | HTTP | Reintentable | Cuándo |
|---|---|---|---|
| `applied` | 200 | no | El cambio de plan aterrizó, con su fila de auditoría, en una transacción |
| `duplicate` | 200 | no | Evento ya completado — la respuesta idempotente |
| `ignored` | 200 | no | Tipo de evento no manejado, o manejado y deliberadamente no aplicado (DP-CAP-15) |
| `retry` | 503 | sí | Otra entrega tiene la reclamación, o `U0003` |
| `refused` | 503 | sí | La capacidad dijo que no y el evento quedó marcado con un código |
| `unavailable` | 503 | sí | Bandera apagada o identidad no aprovisionada. **No se intentó nada** |

**Ninguna disposición no terminal es 4xx.** Stripe deja de reintentar un 4xx, y
una entrega que Stripe abandona es un cambio de suscripción que nunca aterriza
— exactamente la pérdida que CAP-03 existe para impedir.

## 3. Lo que este contrato NO promete

- **No promete que ninguna capacidad esté habilitada.** Los cinco descriptores
  llevan `enabled: false` y ese campo está tipado como el literal `false`: un
  paquete habilitado exige cambiar el tipo, no sólo el valor.
- **No promete una conexión.** El ejecutor de CAP-03 vive en
  `db/capabilities/stripe-capability-executor.ts` y devuelve `null` cuando no
  hay credencial aprovisionada. Ese `null` es el hecho operativo, no una
  excepción.
- **No declara ninguna disponibilidad en entorno alojado.** Ver
  CT-CAP-004: la variable de entorno de la capacidad ni siquiera está en
  `.env.example` todavía.

## 4. Estabilidad y cambio

Este módulo es propiedad de CAPABILITIES. PRODUCT y RELEASE lo **consumen** y
no lo modifican (gobernanza §5 y §6). Todo cambio de forma —añadir un miembro a
`CapabilityOutcome`, cambiar un tipo de carga, mover un SQLSTATE— es un cambio
de contrato y abre una fila nueva en el ledger.

Añadir una capacidad **no** es un cambio de contrato: `CAPABILITY_REGISTRY`
está indexado por `CapabilityId` y un identificador nuevo se acomoda sin tocar
el vocabulario común.

## 5. Decisión de integración

_Pendiente._

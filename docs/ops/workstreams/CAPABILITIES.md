# Línea de trabajo: CAPABILITIES

Ver [`docs/ops/STELLA_PARALLEL_WORKSTREAMS.md`](../STELLA_PARALLEL_WORKSTREAMS.md)
para el protocolo completo (contratos, commits, integración, disciplina de
recursos). Este documento es el estado vivo de esta línea únicamente.

## Identificación

- **Branch:** `codex/stella-capabilities`
- **Worktree:** `C:\Users\Lorenzo\Documents\uellix-stella-capabilities`
- **HEAD base:** `ff1ffb6` (`docs(ops): define parallel Stella workstreams`) —
  el `INTEGRATION_ROOT_HEAD` de esta campaña
- **Propietario:** sin asignar

## Rutas autorizadas (exclusivas)

- `db/**`
- `supabase/**`
- `db/prepared/**`
- Cualquier migración, policy, rol, función SQL, esquema, grant o RLS en
  cualquier ubicación del repositorio.
- `docs/ops/capabilities/CAP_01_INVITATIONS.md` … `CAP_05_ORGANIZATION_BOOTSTRAP.md`
- El hallazgo de referencia `RR-CAP-10` (ver nota de numeración en el
  documento de gobernanza §3).
- **`lib/capabilities/**` — declarado en esta unidad.** Módulo dedicado de
  contratos TypeScript, por paridad con lo que §4 concede a GROUNDING
  («contratos TypeScript … o módulo dedicado que la línea defina»). Se registra
  aquí y en `docs/ops/contracts/CONTRACT_LEDGER.md` en vez de asumirse por
  propiedad tácita, que es lo que §7 prohíbe.

## Rutas prohibidas

- Todo lo marcado `INTEGRATION-OWNED` en el documento de gobernanza §7.
- Componentes de UI, Composer, experiencia Stella (propiedad de PRODUCT).
- Extracción, normalización, retrieval, ranking, provenance de grounding
  (propiedad de GROUNDING) salvo el esquema/tabla que los soporte, que sí
  es de esta línea bajo contrato.
- E2E, CI, observabilidad, scripts de release (propiedad de RELEASE).

## Dependencias

- Ninguna dependencia de entrada de otra línea.
- GROUNDING y PRODUCT dependen de los contratos de esquema que esta línea
  publique — ver "Contratos".

## Contratos

Ledger: [`docs/ops/contracts/CONTRACT_LEDGER.md`](../contracts/CONTRACT_LEDGER.md)
(ruta creada por esta unidad; era la «ruta nueva prevista» de §8).

| ID | Dirección | Estado |
|---|---|---|
| CT-CAP-001 | CAPABILITIES **publica** los contratos de aplicación CAP-01…CAP-05 | `solicitado` |
| CT-CAP-002 | CAPABILITIES **pide** a integración normalizar `RR-CAP-10-A-bis` | `solicitado` |
| CT-CAP-003 | CAPABILITIES **pide** a integración `db/prepared/** text eol=lf` en `.gitattributes` | `solicitado` |
| CT-CAP-004 | CAPABILITIES **pide** a integración documentar `UELLIX_STRIPE_DATABASE_URL` en `.env.example` | `solicitado` |

## Unidad actual

**TRAIN 1 — `CAP-03`: escrituras de capacidad por funciones gobernadas, y
publicación de contratos.** Entregada.

### Qué se cerró

Los **tres `UPDATE` directos sobre `organizations`** de
`app/api/webhooks/stripe/route.ts`. Estaban muertos detrás de
`WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false` y aun así había que quitarlos:
`stella_0011` sacó `stella_monthly_quota`, `stella_plan_label` y las tres
columnas `stripe_*` de todo grant `UPDATE` del runtime, de modo que esas
sentencias levantarían **42501** en cuanto alguien encendiera la bandera — un
fallo cuya causa (un ACL aplicado semanas antes) no está cerca de la línea que
falla.

Además eran el último sitio del árbol donde sobrevivía la **forma** del diseño
antiguo: leer la organización con el ORM, decidir en TypeScript a qué fila
pertenece un evento de Stripe, y escribirla. Todo el argumento de tenencia de
CAP-03 depende de que esa decisión **no** se tome ahí.

### Identificador canónico del riesgo

**`RR-CAP-10-A`** (registro de riesgos, línea 273). `RR-CAP-10-A-bis` **no
existe** en el registro: sus únicas dos apariciones en el árbol son la nota de
la propia gobernanza §3 y un comentario de prosa en
`lib/admin/organization-administration.ts:11`. Los tres `UPDATE` del webhook son
el **resto no cerrado de `RR-CAP-10-A`**, que la edición anterior dejó fuera
explícitamente. Solicitud de normalización: **CT-CAP-002**.

### Forma nueva

```
route.ts  →  lib/capabilities/stripe-webhook.ts  →  db/capabilities/stripe-capability-executor.ts
   |                    |                                        |
firma HMAC        plan + disposición                     conexión uellix_stripe
   |              (puro, sin driver)                     → las 3 funciones de stella_0008
   +-- gate: WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false ------------------+
```

- **Ninguna escritura directa sobre `organizations`.** El route no importa
  `@/db/client` ni la tabla; la capa tipada tampoco.
- **La organización se deriva de la correlación validada.** La capa transporta
  los dos identificadores emitidos por Stripe; la fila la resuelve
  `stripe_apply_subscription` bajo `cap_stripe_only_claimed_read` /
  `cap_stripe_only_claimed_org`. **La rama `client_reference_id` desaparece del
  árbol** (DP-CAP-15) en vez de «validarse»: ningún predicado sobre la fila
  actual distingue una primera suscripción legítima de una reclamación hostil,
  porque la única evidencia en ambos sentidos es el campo que elige el atacante.
- **Sin atajo por la clave elevada de Supabase** (RR-CAP-10-C). La conexión es
  `uellix_stripe`, con su propia variable, y el rol declarado se valida antes de
  abrir socket.
- **`U0003` conserva semántica reintentable**: 503, sin marcar el evento como
  fallido — la subtransacción se deshizo y la fila sigue reclamable.
- **Los errores inesperados siguen fallando.** Sólo `U0001` y `U0003` se mapean
  a disposiciones; cualquier otro SQLSTATE se propaga y el route contesta 500.
- **La bandera sigue apagada** y sigue evaluándose antes de que nada pueda
  alcanzar la base de datos. `stella_0008` no está aplicado en ninguna parte y
  `UELLIX_STRIPE_DATABASE_URL` no está aprovisionada: sin credencial el
  resolutor devuelve `null` y el handler contesta `unavailable` / 503.
- **Ninguna declaración de disponibilidad en entorno alojado.**

De paso se cierra **RR-CAP-03-B**: el `catch` genérico registraba el objeto de
error completo, y un error del driver puede citar el valor de la fila que falló
—aquí, datos de pago—. Ahora registra sólo `error.name`, como la ruta de leads.

## Pruebas ejecutadas

Focalizadas (§11), nunca en paralelo con otra línea. Sin gates pesados, sin
Docker, sin `supabase start`, sin remoto.

| Suite | Resultado |
|---|---|
| `tests/stripe-webhook-capability.test.ts` (nueva, 32 casos) | **verde** |
| `tests/stripe-webhook-route.test.ts` (9 casos, 2 reescritos) | **verde** |
| `tests/capability-isolation.test.ts` | verde salvo 1 fallo preexistente (ver riesgos) |
| `tests/database-{runtime-entrypoints,target-safety,role-safety,runtime-identity}.test.ts` | **verde** |
| `tests/capability-documentation.test.ts`, `tests/database-ddl-containment.test.ts`, `tests/prepared-sql-source-of-truth.test.ts`, `tests/admin-organization-administration.test.ts`, `tests/marketing-lead-route.test.ts`, `tests/database-migrator-path.test.ts` | **verde** |
| `pnpm typecheck` | **verde** |
| `pnpm lint` (focalizado a los ficheros tocados) | **verde** |

Lo que la suite nueva demuestra: cero `UPDATE` directo alcanzable; bandera
apagada y evaluada primero; correlación de organización sin `client_reference_id`;
`U0003` reintentable sin marcar fallo; error inesperado no absorbido; contratos
exportados y exhaustivos (con guarda `never`); ausencia de la clave elevada;
compatibilidad de firmas, SQLSTATEs, códigos de fallo y estados de reclamación
contra `db/prepared/stella_0008_stripe_webhook_identity.sql`.

## Riesgos

- **CT-CAP-003 — `db/prepared/**` se materializa en CRLF y rompe cuatro suites.**
  `.gitattributes` fija `eol=lf` para `db/baseline/**` y para los scripts de
  shell, y no para `db/prepared/**`; con `core.autocrlf=true` el checkout
  reescribe los 32 `.sql` a CRLF y cuatro suites que anclan en `\n` fallan
  (`capability-isolation`, `prepared-stella-sql`, `capability-policy-contract`,
  `capability-mutation`). **Medido, no deducido:** normalizando a LF en el
  worktree las cuatro entregan `687 passed`; restaurando con
  `git checkout -- db/prepared/` vuelven los cuatro fallos. Preexistente en
  `ff1ffb6`, ajeno a los ficheros de esta unidad, y **no reparable desde esta
  línea** porque `.gitattributes` es `INTEGRATION-OWNED`.
- **`tests/database-entrypoint-safety.test.ts` — la suite de integración
  colecciona 0 de 49 tests.** El worktree no tiene `.env.local`, así que
  `resolveRuntimeDatabaseUrl()` aborta en el guard al importar. Ambiental y
  preexistente; levantarlo exigiría el stack local, prohibido en esta unidad.
- **Precio no mapeado — acoplamiento a un centinela.** `mapStripePriceToQuota`
  devuelve la cuota gratuita para un precio desconocido, lo que como valor por
  defecto de una lectura es inocuo y como entrada de un `UPDATE` de
  `stella_monthly_quota` es **una degradación silenciosa de un cliente que
  paga** cada vez que se añade un precio en Stripe antes que en el entorno.
  `stripePlanResolverFrom` lo convierte en `price_unmapped`, pero la única
  señal que expone el mapeo actual es la etiqueta `'Custom'`. Hacer que el mapeo
  devuelva un «no mapeado» explícito toca `lib/stripe/client.ts`, que tiene
  otros *call sites* (facturación, UI), y pertenece a habilitar la capacidad.
- **`lib/admin/organization-administration.ts` tiene ahora un comentario falso**
  («still contains three … statements»). No se corrige aquí porque va atado a la
  resolución de **CT-CAP-002**.
- **RR-CAP-14-A sigue abierto e inherente**: la base de datos no puede verificar
  una firma de Stripe. La credencial de `uellix_stripe` **es** la frontera de
  confianza. Nada de esta unidad lo cambia y nada de esta unidad lo insinúa.

## Estado de entrega a integración

**Entregado. Árbol limpio.** Dos commits locales sobre `ff1ffb6`, sin push:

1. `refactor(app): route capability writes through governed functions`
2. `feat(app): publish capability application contracts`

Nada aplicado a ninguna base de datos. Ningún acceso a remoto. Ningún paquete
`db/prepared/**` modificado ni aplicado. Ninguna capacidad habilitada.

**Ficheros solicitados a integración** (no modificados por esta línea):
`.gitattributes` (CT-CAP-003), `.env.example` (CT-CAP-004),
`docs/ops/STELLA_FABLE_RISK_REGISTER.md` y
`lib/admin/organization-administration.ts` (CT-CAP-002).

# CT-CAP-002 — Normalización del identificador `RR-CAP-10-A-bis`

| Campo | Valor |
|---|---|
| **Solicitante** | CAPABILITIES |
| **Propietaria** | INTEGRACIÓN |
| **Estado** | `solicitado` |
| **Fecha** | 2026-08-04 |
| **Ruta afectada** | `docs/ops/STELLA_FABLE_RISK_REGISTER.md`, `lib/admin/organization-administration.ts` |

## 1. Qué se buscó y qué se encontró

La gobernanza (§3) instruye tratar `RR-CAP-10` como hallazgo de referencia y
registrar explícitamente `RR-CAP-10-A-bis` si resultara ser un desglose
posterior no documentado. La verificación contra el árbol en `ff1ffb6`:

| Identificador | ¿Registrado? | Dónde |
|---|---|---|
| `RR-CAP-10` | **Sí** | `docs/ops/STELLA_FABLE_RISK_REGISTER.md` línea 223. **CERRADO 2026-08-04** por `stella_0011` + `stella_0012` |
| `RR-CAP-10-A` | **Sí** | Registro de riesgos línea 273. Restricción de **orden**: el código debe llamar a las funciones del definer antes de aplicar el paquete |
| `RR-CAP-10-B` | **Sí** | Registro de riesgos línea 274 (`white_label_enabled`) |
| `RR-CAP-10-C` | **Sí** | Registro de riesgos línea 275 (clave elevada de Supabase) |
| **`RR-CAP-10-A-bis`** | **NO** | **Cero apariciones en el registro de riesgos.** Sólo dos ocurrencias en todo el árbol: la nota de la propia gobernanza (§3) y **`lib/admin/organization-administration.ts:11`**, en un comentario de prosa |

## 2. El identificador canónico existe

**Es `RR-CAP-10-A`.** Su entrada en el registro dice, literalmente, que se cierra
para los dos *call sites* de administración de plataforma
(`lib/admin/stella-services.ts`, `lib/admin/organizations.ts`), y la cabecera de
`lib/admin/organization-administration.ts` declara en la misma edición que el
webhook queda **fuera**:

> `app/api/webhooks/stripe/route.ts` still contains three
> `db.update(organizations).set({ stellaMonthlyQuota, … })` statements; they are
> dead behind `WEBHOOK_DATABASE_IDENTITY_AVAILABLE = false` … Rewriting them
> belongs to enabling CAP-03, not here — tracked as RR-CAP-10-A-bis.

Es decir: los tres `UPDATE` del webhook son el **resto no cerrado de
`RR-CAP-10-A`**, y `-A-bis` es un alias acuñado en ese comentario que nunca
llegó al registro. No es un riesgo distinto y no tiene entrada propia.

Esta unidad ha cerrado ese resto. Los tres `UPDATE` ya no existen.

## 3. Qué se pide

Una de estas dos, a criterio de integración —**esta línea no ha aplicado
ninguna**, porque `docs/ops/STELLA_FABLE_RISK_REGISTER.md` no está entre sus
rutas autorizadas (gobernanza §3) y el registro es la fuente de verdad de los
identificadores:

**Opción A (recomendada) — retirar el alias.**
Sustituir en `lib/admin/organization-administration.ts:11`
«tracked as RR-CAP-10-A-bis» por «tracked as RR-CAP-10-A (webhook remainder)»
y anotar en la entrada `RR-CAP-10-A` del registro que el resto del webhook se
cerró en esta unidad. Un identificador que sólo existe en un comentario es una
referencia colgante: alguien que lo busque en el registro no encuentra nada y
no puede distinguir «no existe» de «no lo he encontrado».

**Opción B — promover el alias a entrada real.**
Crear `RR-CAP-10-A-bis` en el registro con alcance explícito «los tres `UPDATE`
directos de `app/api/webhooks/stripe/route.ts`», estado **CERRADO 2026-08-04**,
y enlazarlo desde `RR-CAP-10-A`.

## 4. Lo que esta línea sí ha hecho

- Ha usado **`RR-CAP-10-A`** como identificador canónico en todo el código y en
  las pruebas de esta unidad. Ningún artefacto nuevo cita `-A-bis`.
- No ha modificado el registro de riesgos.
- No ha modificado `lib/admin/organization-administration.ts`: su comentario
  quedará desactualizado («still contains three … statements» ya no es cierto)
  hasta que integración resuelva este contrato. Se registra aquí para que no se
  descubra leyendo un comentario falso.

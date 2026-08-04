# CT-CAP-004 — `UELLIX_STRIPE_DATABASE_URL` en `.env.example`

| Campo | Valor |
|---|---|
| **Solicitante** | CAPABILITIES |
| **Propietaria** | INTEGRACIÓN |
| **Estado** | `solicitado` |
| **Fecha** | 2026-08-04 |
| **Ruta afectada** | `.env.example` (**INTEGRATION-OWNED**, gobernanza §7) |

## 1. Qué se pide

Documentar en `.env.example` la variable de conexión de CAP-03, **sin valor**:

```dotenv
# CAP-03 — conexión exclusiva del handler del webhook de Stripe.
# Debe declarar el rol uellix_stripe. NO se comparte con ningún otro servicio.
# Sin aprovisionar: el handler devuelve 503 y no intenta nada.
# Ver docs/ops/capabilities/CAP_03_STRIPE.md §13.
UELLIX_STRIPE_DATABASE_URL=
```

## 2. Por qué

`db/safety/resolve-capability-database-url.ts` estableció la regla **una
variable por capacidad**: `DATABASE_URL` significaba a la vez el runtime, el
migrador y el auditor, y la lectura más privilegiada ganaba siempre. CAP-03
añade una cuarta identidad —`uellix_stripe`— y su credencial se aprovisiona
**fuera de banda** (el paquete `stella_0008` no fija contraseñas, igual que
`stella_0004`).

`.env.example` es donde el repositorio enumera qué identidades existen. Una
variable que sólo aparece en código y en documentación de diseño es una que un
operador descubre cuando algo ya no funciona.

## 3. Lo que esta solicitud NO pide

- **No pide aprovisionar la credencial.** Eso es el paso 2 del rollout de
  CAP_03_STRIPE.md §13 y va después de aplicar `stella_0008`, que no está
  aplicado en ninguna parte.
- **No pide encender la bandera.** `WEBHOOK_DATABASE_IDENTITY_AVAILABLE` sigue
  en `false` y `tests/stripe-webhook-route.test.ts` la fija.
- **No declara ninguna disponibilidad en entorno alojado.**

Con la variable presente y vacía, `resolveStripeCapabilityExecutor()` devuelve
`null`, el handler responde `unavailable` / 503 y no se abre ningún socket. El
comportamiento no cambia; sólo deja de ser invisible.

## 4. Estado

Esta línea **no** ha modificado `.env.example`. El código funciona sin la
entrada; la solicitud es de legibilidad operativa, no de desbloqueo.

# CT-CAP-003 — Fin de línea de `db/prepared/**`

| Campo | Valor |
|---|---|
| **Solicitante** | CAPABILITIES |
| **Propietaria** | INTEGRACIÓN |
| **Estado** | `aceptado` — **aplicado** (integración, tren 1, 2026-08-04). `db/prepared/** text eol=lf` en `.gitattributes`; renormalización con cero blobs nuevos |
| **Fecha** | 2026-08-04 |
| **Ruta afectada** | `.gitattributes` (**INTEGRATION-OWNED**, gobernanza §7) |

## 1. El síntoma

En un worktree recién creado en Windows fallan **cuatro suites** que analizan
`db/prepared/**`, sin que su contenido commiteado tenga nada mal:

| Suite | Fallo |
|---|---|
| `tests/capability-isolation.test.ts` | `verify_report is STABLE, so the public read path cannot write` |
| `tests/prepared-stella-sql.test.ts` | `accepts only the exact string 'true' as destruction authorization` |
| `tests/capability-policy-contract.test.ts` | `produces no violations at all` |
| `tests/capability-mutation.test.ts` | Aborta el fichero entero: `mutation anchor not found: "…FOR UPDATE TO uellix_cap_invitation\nUSING (status = 'pendi"` |

## 2. La causa, medida

`.gitattributes` fija `text eol=lf` para `db/baseline/**` y para los scripts de
shell, y para nada más. `db/prepared/**` queda a merced de `core.autocrlf`, que
en esta máquina vale `true`, así que el checkout materializa
`stella_0007_public_verification_capability.sql` con **1142 finales CRLF y cero
LF**.

La aserción de la línea 649 ancla en `\n`:

```js
expect(body).toMatch(/CREATE OR REPLACE FUNCTION uellix_capability\.verify_report[\s\S]*?\nSTABLE\n/)
```

Contra `\nSTABLE\r\n` no casa. Comprobado contra el blob del propio commit:

| Fuente | ¿Casa? |
|---|---|
| `git show HEAD:db/prepared/stella_0007_public_verification_capability.sql` (LF) | **sí** |
| El mismo fichero en el worktree (CRLF) | **no** |

Es decir: **no es un defecto del SQL ni de la prueba, es el checkout.** El
contenido commiteado es correcto.

### 2.1 Medido sobre la clase entera, no deducido de un caso

Normalizando **en el worktree** los 32 ficheros `.sql` de `db/prepared/` a LF y
volviendo a ejecutar las cuatro suites:

```
Test Files  4 passed (4)
     Tests  687 passed (687)
```

Restaurando después con `git checkout -- db/prepared/` vuelven los CRLF y
vuelven los cuatro fallos. La causa es única y es el fin de línea; no hay un
segundo defecto escondido detrás.

## 3. Por qué importa más de lo que parece

1. **Es un falso negativo intermitente por plataforma.** La suite pasa en CI
   (Linux, LF) y falla en el worktree de quien la escribe. Una línea de trabajo
   que arranca con una prueba roja que no ha causado pierde la señal: la
   siguiente rotura real se lee como «ya estaba así».
2. **`db/prepared/**` es exactamente el material que se aplica con `psql`.** El
   riesgo de un final de línea equivocado en un paquete SQL no es teórico —
   `.gitattributes` ya documenta el caso análogo para `db/baseline/**`, donde el
   manifiesto SHA-256 dejaría de cuadrar.
3. **Este es el mismo mecanismo que ya rompió trabajo antes** en repos Uellix
   con `core.autocrlf=true`.

## 4. Qué se pide

Añadir a `.gitattributes`:

```gitattributes
# Los paquetes preparados se aplican con psql y las pruebas de aislamiento
# anclan en \n (p. ej. /\nSTABLE\n/ sobre la firma de verify_report). Con
# core.autocrlf=true un checkout en Windows los reescribe a CRLF y esas
# aserciones fallan sin que el contenido commiteado haya cambiado.
db/prepared/** text eol=lf
```

**Esta línea no lo ha aplicado**: `.gitattributes` es `INTEGRATION-OWNED`
(gobernanza §7) y el criterio de detención (§12) prohíbe modificarlo sin una
solicitud explícita. Esto es esa solicitud.

## 5. Alternativa descartada

Normalizar los finales de línea **dentro** de la prueba (`replace(/\r\n/g, '\n')`).
Se descarta por dos razones: `tests/**` no es propiedad de esta línea para
cambios que no sean los suyos, y sobre todo trataría el síntoma dejando el
material que se aplica a la base de datos con un final de línea dependiente de
la plataforma — que es la parte que sí conviene fijar.

## 6. Estado tras esta unidad

Se deja **abierto y sin tocar**: la reparación está en `.gitattributes`, que
esta línea no puede modificar. Los cuatro fallos son preexistentes en `ff1ffb6`
y ninguno alcanza los ficheros que esta unidad modifica — `db/prepared/**` queda
byte a byte como estaba (comprobado con `git status`).

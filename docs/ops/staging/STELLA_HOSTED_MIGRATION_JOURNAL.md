# STELLA — RR-25: el journal autoritativo de aplicación hosted

> Train 5C2. **Ninguna escritura hosted se ha realizado.** El journal está
> implementado en bytes generados y verificados localmente; nada se ha ejecutado
> contra el proyecto remoto.

---

## 1. El defecto, y por qué el train anterior no lo cerró

Local, `pnpm db:migrate:local` usa el migrator de drizzle y escribe
`drizzle.__drizzle_migrations`. Hosted, el plan era `psql -1 -f` por unidad, que
**no escribe nada**. `TargetStateProbe.baselineUnitsInstalled` estaba documentado
como «según el ledger del operador», y no existía ledger: la comprobación
anti-skip de `PHASE_STELLA_BOOTSTRAP` leía una lista que alguien tecleaba.

Train 5C1 **diseñó** el journal: `baseline-journal.ts` exportaba
`journalInsertSql()`. **Nadie lo llamaba.** Ningún artefacto contenía el INSERT
que describía. El gate `hosted-baseline-journal-ready` lo detectó y refutó, con la
frase correcta: *un descriptor no es una implementación*.

Este documento describe la implementación.

---

## 2. La propiedad exigida: atomicidad, no promptitud

> «migration SQL + journal APPLIED deben comprometerse de forma atómica.»

No vale «la fila se escribe justo después». Eso son dos transacciones con una
ventana de caída entre ellas, y una caída en esa ventana deja **una unidad
aplicada y no registrada** — exactamente el estado que el ledger existe para hacer
imposible en silencio.

`psql` ofrece un mecanismo para esto: `-1` envuelve **toda la invocación** en una
transacción. Así que el INSERT tiene que estar dentro de esa invocación.

---

## 3. Wrapper, no copia

La forma obvia de meter el INSERT en la invocación es generar cincuenta archivos
derivados: cada unidad más el append. Eso son **cincuenta copias del corpus
completo** junto al corpus — un segundo juego de bytes que puede derivar del
primero, que es justo el fallo contra el que este repositorio gasta su presupuesto
de `hosted:verify` y `storage:verify`.

Cada wrapper **incluye** su unidad en lugar de copiarla:

```sql
\set ON_ERROR_STOP on

\if :{?uellix_project_ref}
\else
\echo 'REFUSED: -v uellix_project_ref=<ref> was not supplied.'
\quit 1
\endif

\ir ../../../db/migrations/0031_rls_core.sql

INSERT INTO uellix_provisioning.applied_units
  (environment, project_ref, package_id, phase,
   source_sha256, derived_sha256, security_surface_digest, status)
VALUES
  ('staging', :'uellix_project_ref', '0031_rls_core.sql', 'PHASE_BASELINE',
   '<sha>', NULL, NULL, 'APPLIED');
```

`\ir` lo resuelve psql relativo al directorio del propio wrapper y empalma el
archivo en la misma sesión, así que `-1` cubre ambos. El SQL canónico sigue siendo
su única copia.

```
db/prepared/journal/000_journal_bootstrap.sql       ← unidad CERO
db/prepared/journal/001_0000_quick_husk.sql
…
db/prepared/journal/041_20260716000001_storage_policies.sql   ← incluye PARTE A
…
db/prepared/journal/050_…
```

Generación y verificación: `pnpm journal:generate` · `pnpm journal:verify`.

---

## 4. Unidad CERO

Una unidad no puede registrarse en una tabla que no existe, así que el ledger es
una **unidad cero** de `PHASE_BASELINE`, planificada como paso — un prerrequisito
que nadie planifica es un prerrequisito que alguien salta.

Dos CHECK merecen atención:

| Constraint | Qué impide |
|---|---|
| `applied_units_status_check` | una columna de estado libre acaba conteniendo `ok`, `OK` y `done` |
| `applied_units_project_ref_check` | forma de 20 minúsculas |
| **`applied_units_not_production_check`** | **una fila que nombre producción levanta excepción DENTRO de la transacción de la unidad, y la excepción hace rollback de la UNIDAD.** La base de datos se niega a aplicar una unidad que se registraría contra producción |
| `applied_units_one_applied_per_package` | una segunda fila APPLIED. 28 de las 40 unidades Drizzle no sobreviven a una segunda aplicación, así que la BD se niega a **registrar** la contradicción |

---

## 5. Los límites honestos, porque no son cero

**5.1 `project_ref` lo aporta el operador** (`-v uellix_project_ref=…`). Nada del
lado servidor en Supabase informa el project ref, así que no puede derivarse en
banda. Lo acotan tres cosas en su lugar: el CHECK de forma, el CHECK de denylist
—que hace rollback de la unidad— y, después, `reconcileJournal` comparándolo con
`projectRefFromHost(connectionHost)`. Está **acotado y cruzado**, no confiado.

**5.2 Un wrapper no puede registrar `FAILED`.** Una unidad fallida hace rollback, y
una fila escrita dentro del rollback se va con él. Es el trueque correcto: el
ledger nunca afirma un apply que no ocurrió, y **la ausencia de fila es lo que un
fallo parece**. `FAILED` permanece en el dominio para el único escritor que corre
fuera de la transacción de una unidad: el reconciliador de la frontera humana.

**5.3 PARTE B nunca la registra su canal.** Se aplica por una superficie que no
puede unirse a una transacción psql, así que su estado se **reconstruye** desde
`pg_policies`. Un hecho leído del catálogo no puede estar desacompasado con el
catálogo — propiedad más fuerte que una fila escrita al lado.

**5.4 El journal no se cree a sí mismo.** Un ledger que vive en la base que
describe lo puede falsificar quien pueda escribir en ella. La propiedad realmente
disponible es más débil y suficiente: **el journal no puede discrepar en silencio
del catálogo.** `reconcileJournal` compara cada afirmación `APPLIED` contra estado
observado de forma independiente, así que fabricar una fila no compra una unidad
saltada — compra un gate fallido.

---

## 6. La frontera humana y el journal

Una operación humana no puede compartir transacción con psql. Por eso:

```
PARTE A committed                → journal APPLIED (dentro de la misma transacción)
                                   estado: UNIT_41_HELPERS_APPLIED
        ↓
frontera abierta                 → journal MANUAL_BOUNDARY_PENDING
                                   estado: UNIT_41_POLICIES_PENDING
        ↓
el operador ejecuta PARTE B      (canal no observable)
        ↓
tres nombres presentes           estado: UNIT_41_POLICIES_APPLIED_UNVERIFIED
        ↓
B0-16 read-only PASS             reconciliación verificable
        ↓
                                 → journal MANUAL_BOUNDARY_VERIFIED
                                   estado: UNIT_41_COMPLETE
```

`reconcileStorageBoundary()` **no recibe ninguna afirmación del operador**. Recibe
lo que dijeron `pg_proc` y `pg_policies` y lo que concluyó B0-16, y se niega a
marcar la frontera verificada si falta cualquiera de los tres. Además refuta en
ambas direcciones:

- fila `APPLIED` de PARTE A sin helpers en `pg_proc` → imposible bajo `psql -1`;
  o la fila es falsa o algo borró las funciones;
- helpers presentes **sin** fila → algo aplicó la unidad fuera del canal
  gobernado;
- journal ya en `MANUAL_BOUNDARY_VERIFIED` con catálogo en otro estado → el ledger
  va por delante de la base de datos, que es la dirección que importa.

---

## 7. Máquina de estados de la unidad 41

```
UNIT_41_NOT_STARTED
   └─→ UNIT_41_HELPERS_APPLIED           (PARTE A committed)
         └─→ UNIT_41_POLICIES_PENDING    (frontera abierta)
               └─→ UNIT_41_POLICIES_APPLIED_UNVERIFIED   (3 nombres, superficie sin medir)
                     └─→ UNIT_41_COMPLETE                (superficie verificada)
   cualquiera ─→ UNIT_41_FAILED
```

Reglas, y son las que la instrucción exigió:

- **PARTE A aplicada ≠ COMPLETE.**
- **PARTE B ejecutada ≠ COMPLETE.**
- Sólo PARTE A committed **+** PARTE B committed **+** postcondición exacta PASS
  **+** journal consistente produce `UNIT_41_COMPLETE`.
- No hay ninguna arista hacia `COMPLETE` que no pase por una superficie verificada
  — y una prueba lo comprueba sobre la tabla de transiciones, no sobre el
  comentario.

`UNIT_41_FAILED` no es alcanzable por no hacer nada: llegar a FAILED exige
evidencia de que algo está mal (superficie medida y distinta, 2 de 3 con la
frontera cerrada, policies sin sus helpers).

---

## 8. Crash / recovery

| Escenario | Estado recuperado | Por qué |
|---|---|---|
| crash antes del SQL | unidad ausente | no hay fila ni objetos |
| crash durante el SQL | unidad ausente | `psql -1` hace rollback de todo |
| crash después del SQL antes del journal | **no existe esa ventana** | el INSERT está dentro de la transacción |
| fallo del journal | la unidad hace rollback con él | mismo `-1` |
| proceso matado | igual que crash | |
| retry | `applied_units_one_applied_per_package` rechaza el segundo APPLIED | |
| PARTE A aplicada dos veces | idem | |
| retry con hashes distintos | `JOURNAL_SHA_MISMATCH` | la BD tiene otra versión de la unidad |
| PARTE B parcial (2 de 3) | `UNIT_41_FAILED` si la frontera cerró | permissive OR: falta un guard, no es un guard menor |
| predicado incorrecto | `UNIT_41_FAILED` vía B0-16 | igualdad normalizada, no contención |
| hash de artefacto incorrecto | la frontera no abre | precondición |
| fallo de postcondición | `UNIT_41_FAILED` | |
| baseline reiniciado tras la frontera | `JOURNAL_DUPLICATE_APPLIED` | |
| fila de journal ausente | `JOURNAL_MISSING_UNIT`; un baseline parcial no es un baseline más pequeño | |
| catálogo no observado | `JOURNAL_CONTRADICTS_CATALOG` — **no medido es rechazado** | |
| `project_ref` de producción | la unidad hace rollback por CHECK | |

Todo se deriva de **journal + catálogo + hashes**, fail-closed.

---

## 9. Estado

`RR-25` está **implementado**: `pnpm journal:verify` compara los 51 wrappers byte a
byte, el gate `hosted-baseline-journal-ready` exige el append **en todos** los
wrappers (no en uno solo, que era un cincuentavo del requisito), y el runner
planifica los wrappers en lugar de los archivos crudos.

`applyAuthorized` sigue en `false`. Lo que bloquea ahora es
`hosted-storage-management-channel-verified` — ver
[STELLA_STORAGE_MANAGEMENT_CHANNEL.md](STELLA_STORAGE_MANAGEMENT_CHANNEL.md).

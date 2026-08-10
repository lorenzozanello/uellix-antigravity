# Certificación local de la vía de entrega de `stella_hosted_0002`

**Commit 5.3.** Motor `public.ecr.aws/supabase/postgres:17.6.1.143`, `--network none`,
contenedores efímeros, cero credenciales remotas.

```
pnpm remediation:verify      # gate offline (pin, anclas, forma de staging)
pnpm certify:remediation     # el motor
```

Artefacto: `artifacts/remediation-certification/latest.json`.

---

## 1. Qué certifica, y por qué `certify:pg176` no podía

`certify:pg176` aprovisiona con el bootstrap **de hoy**, que ya lleva §5d (E-01) y
§5e (E-04). Es la evidencia correcta para un proyecto **nuevo** y no dice nada del
que existe: staging fue aprovisionado **antes** del Commit 5.1, y `stella_hosted_0002`
existe entera para llevarlo de donde está a donde la cadena puede empezar.

Aprovisionar con el bootstrap actual habría hecho que §0 (S6) **rechazara** la
remediación —`assert_capability_membership_topology` ya existiría, que es su propio
testigo— y habría hecho la transición `ABSENT → INSTALLED` inmedible.

Así que este harness aprovisiona la **otra** forma: el bootstrap histórico, byte a
byte, resuelto por su blob de git.

```
STAGING_SHAPE_BOOTSTRAP_BLOB   79205b75b41eefe38221f4c4d02d5bbc60ce9bd2
                               (db/prepared/hosted/…0001….hosted.sql @ 4ee87cb)
STAGING_SHAPE_BOOTSTRAP_SHA256 2b2df1abf1ba19411ba55b6a3a4a62653bfe784bc79977d3f24e6a6dc531d602
```

Un blob de git es direccionable por contenido: el identificador **es** el pin. Se
descartó copiar el archivo al árbol por dos razones: un archivo bajo `db/` que
parece un bootstrap y no lo es acaba aplicándose, y una copia es una segunda
ortografía que deja de ser «lo que recibió staging» en cuanto alguien la toca.

El estado fuente reproducido queda abierto en cuatro defectos —E-01, E-02, E-03,
E-04— y eso se **mide**, no se asume: `assertStagingShapeIsUnremediated` rechaza si
el bootstrap resuelto ya trae alguno.

---

## 2. El transporte del testigo (lo que 5.2 dejó roto)

El testigo de producción era correcto; el **lector** de la certificación no. Leía la
salida tabular de psql con un separador de campo, y eso falla en silencio: un valor
que contiene el separador parte la fila en un número distinto de campos y todas las
columnas posteriores se leen desplazadas. `proconfig` ya viene unido por `|`, un ACL
por comas, y `prosrc` contiene saltos de línea.

No se arregló eligiendo un separador mejor. Se eliminó el paso de parseo:

```
SQL → jsonb_build_object → UNA celda → JSON.parse → validador tipado
```

`queryDocument` rechaza cualquier respuesta que no sea exactamente una línea. El
validador **rechaza** en vez de coercer: un booleano ausente no es `false`, porque
`false` es una medición y ausente es la falta de una, y la diferencia decide entre
aplicar y no volver a aplicar nunca.

El mismo patrón cubre la huella de estado fuente y la postura de la cadena.

---

## 3. Frescura y libro de intentos

El testigo se construye **para un intento**, cuyo id se compila como literal dentro
del SQL: el servidor devuelve el eco. Reejecutar la sonda de ayer no produce una
observación fresca, produce un documento que nombra el intento de ayer.

Maquinaria compartida con la cadena (`parseAttemptLedger`, `attemptStatus`);
**identidad separada**: tipo `prechain-remediation` obligatorio en cada registro y
archivo propio (`artifacts/hosted-remediation-attempts.jsonl`). Un registro de la
cadena no puede autorizar una remediación aunque se peguen las líneas.

El intento se **consume antes** de la escritura. Ese es todo el contrato de
ambigüedad: si el proceso muere en cualquier punto posterior al plan, el libro dice
`CONSUMED`, el planificador se niega a reutilizarlo, y la única salida es un intento
nuevo con una observación nueva. Correcto en las dos direcciones — el commit perdido
se lee `INSTALLED` y no se reaplica; el rollback no observado se lee `ABSENT` y se
autoriza un intento nuevo.

---

## 4. Resultados de motor

```
EXACT_STAGING_REMEDIATION          PASS   (baseline 50/50, bootstrap histórico PASS)
REMEDIATION_WITNESS (fuente)       ABSENT
PRECHAIN_GATE (antes)              11 rechazos  → authorizeGovernedT1 REMEDIATION_ABSENT
REMEDIATION_ATTEMPT_LEDGER         ENFORCED (replay → REMEDIATION_ATTEMPT_NOT_OPEN)
0002 apply                         exit=0  (psql -1 -v ON_ERROR_STOP=1, como postgres)
REMEDIATION_WITNESS (después)      INSTALLED
POST_REMEDIATION_PRECHAIN_GATE     PASS — 8 contratos de objeto, 0 rechazos
T1_AUTHORIZATION_AFTER_REMEDIATION AUTHORIZED
POST_REMEDIATION_GOVERNED_CHAIN    9_OF_9_PASS
OWNER_TRANSFERS_ENGINE             27_OF_27_CORRECT
CANONICAL_OWNER_CONTEXT_ENGINE     3_OF_3_CORRECT
TRANSFER_MEMBERSHIP_CLEANUP        11_OF_11
TEMP_SCHEMA_CREATE_RESIDUAL        ZERO
PERSISTENT_ROLE_TOPOLOGY           EXPECTED
SD_GATE_ENGINE_V2                  PASS
RLS_POLICY_ENGINE                  PASS
REMEDIATION_TRANSACTION_ROLLBACK   PASS_9_OF_9
REMEDIATION_AMBIGUOUS_SUCCESS      RECOVERED_WITHOUT_REAPPLY
REMEDIATION_AMBIGUOUS_FAILURE      NEW_ATTEMPT_REQUIRED
REMEDIATION_PARTIAL_RECOVERY       HUMAN_ONLY
OLD_BOOTSTRAP_SECOND_PASS          PROHIBITED
REMEDIATION_PIN                    ENFORCED
```

El rechazo del motor a `T1` **antes** de la remediación merece citarse, porque es la
forma de staging reproducida con fidelidad:

```
ERROR:  malformed array literal: "CREATEROLE"
CONTEXT: PL/pgSQL function uellix_bootstrap.assert_hosted_capabilities(text) line 11
```

Eso es E-03 enmascarando E-02 dentro del cuerpo antiguo — exactamente lo que un
operador vería hoy contra staging, y lo que §3 de `0002` reemplaza.

---

## 5. R1–R9

Nueve puntos, nueve estados de catálogo materialmente distintos, cada uno el primer
statement **después** de un tipo distinto de cambio de autoridad.

| | punto | autoridad abierta al morir | alcanzado | rollback |
|---|---|---|---|---|
| R1 | antes de `ALTER ROLE` | nada mutado (caso de control) | sí | completo |
| R2 | tras `ALTER ROLE … CREATEROLE` | atributo de rol cambiado | sí | completo |
| R3 | tras `GRANT CREATE ON DATABASE` | ACL de base de datos | sí | completo |
| R4 | tras el primer grant E-01 | 1 de 8 objetos, conjunto a medias | sí | completo |
| R5 | tras abrir `SET ROLE uellix_owner` | sesión elevada | sí | completo |
| R6 | tras abrir el préstamo de esquema | `postgres` con USAGE,CREATE explícito | sí | completo |
| R7 | tras `CREATE OR REPLACE` del helper | cuerpo de función reemplazado | sí | completo |
| R8 | reelevado, antes del `REVOKE` | todo aplicado, préstamo abierto | sí | completo |
| R9 | tras el `REVOKE`, antes de §5 | todo aplicado, préstamo devuelto | sí | completo |

«Rollback completo» significa que la huella de estado fuente —atributos de rol, ACL
de base de datos, ACL de esquemas, ACL de los objetos E-01, **hash de `prosrc`** de
los helpers, pertenencias, roles de capacidad— es idéntica antes y después, medida
en una **sesión nueva** después de que la transacción terminó, y que el testigo
fresco vuelve a leer `ABSENT`. Nunca se infiere del código de salida de psql.

El residuo del préstamo **no** se detecta con `has_schema_privilege('postgres', …)`:
`pg_read_all_data` está concedido a `postgres` `WITH INHERIT` en todo proyecto
Supabase y confiere USAGE sobre cada esquema, así que ese predicado sigue TRUE
después del revoke. Se compara la representación explícita del ACL.

---

## 6. Dos discrepancias con el documento del Commit 5.1, declaradas

**Recuento de políticas.** Este harness mide **118** políticas (115 en los esquemas
gobernados + 3 del shim de `storage`) y 11 triggers, sin duplicados y sin ninguna
política sobre una relación con RLS deshabilitada. El documento
`PG176_ENGINE_CERTIFICATION.md` §6 dice «164 políticas». Esa cifra **no se
reproduce** con esta sonda y no se ha podido reconstruir cómo se obtuvo; el artefacto
truncado que 5.2 dejó en `artifacts/pg176-certification/latest.json` era una corrida
`--only=provision` y no contenía la postura. `RLS_POLICY_ENGINE` se juzga por
propiedades —cero duplicados, cero políticas inertes, conjunto no vacío— y no por
igualdad con un número, precisamente por esto.

**Gate SD.** Hay 27 funciones `SECURITY DEFINER`; **19** están en esquemas de la
cadena y las 19 fijan `search_path` vacío. De las 8 restantes, todas en `public` y
creadas por `db/migrations`, tres —`current_user_org_ids`,
`current_user_is_super_admin`, `current_user_role_in_org`— llevan
`search_path=public`. Son hechos **prechain**, idénticos en una corrida que nunca
aplica la cadena, y la cadena ni las crea ni las posee (E-01 existe justamente
porque `uellix_owner` tiene que recibir privilegios sobre ellas en vez de la
propiedad). El gate las **registra** en `outsideChainScope` en lugar de rechazarlas,
y rechaza `EXECUTE` a `PUBLIC` en cualquier definer, dentro o fuera de alcance.

Medición asociada: `SET search_path = ''` se almacena como `search_path=""` —la
cadena vacía llega **entre comillas**—. Un check escrito contra `search_path=` no
coincide con nada y reprueba las 27 funciones correctas. Fue el primer resultado de
este gate.

---

## 7. Lo que este commit NO hace

No toca staging, no escribe en remoto, no reintenta T1 y no mueve un solo byte
gobernado: `db/prepared/hosted/governed/*.governed.sql` es idéntico a `fd5e9ef` y
`authority:verify` lo confirma contra una regeneración determinista.

`SAFE_TO_APPLY_STAGING_PRECHAIN_REMEDIATION` sigue siendo **false**. Lo que cambió
es que ahora existe evidencia de motor de que la vía de entrega completa —incluida
la recuperación de los tres finales que no son «commit limpio»— se comporta como el
contrato dice.

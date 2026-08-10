# Hallazgos adversariales y del dry run — campaña de capacidades

**Fecha:** 2026-08-03. **Estado:** todos los BLOCKER y MAJOR cerrados y
verificados por ejecución. **Nada aplicado a ningún stack vivo.**

> **Alcance de la evidencia de segunda aplicación (A-M6 = B-F10, D2).**
>
> Este documento registra que los cinco paquetes se aplicaron **dos veces** con
> estado idéntico. Esa medición **se conserva y sigue siendo cierta**: se hizo en
> el ciclo de vida canónico self-hosted, dentro de la ventana de superusuario,
> en un contenedor desechable con PostgreSQL 17.6.
>
> **No es el contrato de la cadena Stella hosted sobre Supabase managed.** Allí un
> paquete `INSTALLED` no se vuelve a aplicar — política forward-only, y además
> `CREATE OR REPLACE` en segunda pasada exigiría una propiedad que el ejecutor
> managed no tiene. Es el mismo mecanismo que este documento ya midió en A-M6,
> observado desde el otro lado: allí se resolvió con la ventana de superusuario,
> que en managed no existe.
>
> Contrato vigente: `docs/ops/staging/STELLA_HOSTED_FORWARD_ONLY_CONTRACT.md`.

Tres fuentes independientes, en orden cronológico:

| Fuente | Método | BLOCKER | MAJOR | MINOR | NIT |
|---|---|---|---|---|---|
| **Revisor A** (ronda 1) | Lectura, lente de privilegio y aislamiento | 5 | 2 | 3 | 2 |
| **Revisor B** (ronda 1) | Lectura, lente de rutas de ataque (15 ataques) | 4 | 6 | 11 | 3 |
| **Dry run** | Ejecución en contenedor desechable sin red, PostgreSQL 17.6 | 9 | — | — | — |

A y B coinciden en cuatro hallazgos (marcados **=**), así que la unión es de
**10 BLOCKER, 7 MAJOR** distintos. Ninguno se rebajó de severidad.

> **Lo que dice el reparto.** Los dos revisores, leyendo el mismo SQL con lentes
> distintas, encontraron once defectos de bloqueo entre los dos — y la ejecución
> encontró **nueve más que ninguno de los dos podía ver**, cuatro de ellos con
> fallo en *tiempo de ejecución* (dentro de un webhook, o de un enlace de
> invitación) en vez de al aplicar. Ese es el argumento de RR-CAP-0 convertido
> en dato: el diseño no estaba terminado hasta que corrió.

---

## 1. BLOCKER

| ID | Capacidad | Mecanismo | Dónde | Corrección | Prueba de cierre | Estado |
|---|---|---|---|---|---|---|
| **A-B1 = B-F1** | 01·02·03·04·05 | `ALTER FUNCTION … OWNER TO R` exige que **R** tenga `CREATE` sobre el esquema, no sólo que el ejecutor sea miembro de R. Los definers sólo tienen `USAGE`. Y `COMMENT ON` posterior exige propiedad resuelta por `has_privs_of_role`, que `INHERIT FALSE` niega | los 5 forward, ventana 2 | Todo el ciclo de vida de la función (`CREATE OR REPLACE`, `ALTER OWNER`, `COMMENT`, `REVOKE`, `GRANT`) pasa a la **ventana 3 de superusuario**, tras `RESET ROLE` | Dry run §1: 5/5 aplican. Gate estático `'$id: the function lifecycle happens in the superuser window'` | **CERRADO** |
| **A-B2 = B-F2** | 01·05 | `auth.uid()` exige `USAGE` sobre el esquema `auth` **para el definer**. `stella_0004` lo concedió sólo a `uellix_owner`, y la membresía va en sentido contrario. Misma clase que `stella_0005d` con `storage` | `stella_0006:251`, `stella_0010:206` | `GRANT USAGE ON SCHEMA auth` en la ventana 1 para los dos definers que lo llaman; postcondición `has_schema_privilege`; revocación en los rollbacks | Dry run CAP-01 L1 y CAP-05 «bootstrap creates the organisation» pasan. Gate `'$id grants USAGE on schema auth'` | **CERRADO** |
| **A-B3 = B-F3** | 01 | `SELECT *` se expande en tiempo de parseo, así que exige `SELECT` sobre **las 13 columnas** de `invitations`; el grant nombraba 8. Y el cuerpo lee de verdad `invited_by` | `stella_0006`, lectura de la invitación | Lista de columnas explícita en escalares (sin `%ROWTYPE`); `invited_by` añadido al grant | Dry run CAP-01 L1. Gate: los grants por columna están inventariados | **CERRADO** |
| **A-B4 = B-F4** | 01·05 | `RETURNING id` exige `SELECT` sobre `id`; el grant sobre `organization_members` era `(user_id, status)` | `stella_0006`, `stella_0010` | `id` añadido a ambos grants; postcondición explícita en 0006 §4.7 y 0010 §4.4 | Dry run CAP-01 L1b y CAP-05 «founding membership» | **CERRADO** |
| **A-B5** | 03·04·05 | `pg_catalog.coalesce()` y `pg_catalog.nullif()` **no existen**: `COALESCE` y `NULLIF` son producciones gramaticales que construyen `CoalesceExpr`/`NullIfExpr`, sin filas en `pg_proc`. Falla **en ejecución**, no al crear la función | `stella_0008:361`, `stella_0009` ×4, `stella_0010` ×5 | Forma desnuda. Al ser gramática y no nombre, son inmunes a `search_path` por construcción | Dry run: las tres capacidades ejecutan. Gate `'no SQL-standard construct is over-qualified'` | **CERRADO** |
| **B-F5** | 02 | `report_public_disclosures` llevaba su propio `organization_id` sin nada que lo atara al del reporte, y la validación de FK corre como owner y **salta RLS** — así que un admin de la organización A podía publicar el reporte de B, mostrado bajo el nombre de **B** | `stella_0007`, tabla y policies internas | La columna **desaparece**: la organización se deriva de `sroi_reports` dentro de las policies, cuyo `EXISTS` se evalúa bajo el RLS del llamante. `approved_by` atado a `auth.uid()` y fuera del grant de `UPDATE` | Dry run CAP-02 «F5 cross-tenant publication refused» (42501) y «F5b forged approver refused» (42501); «own-org publication allowed» pasa | **CERRADO** |
| **B-F6** | 03 | `UPDATE … SET status='failed'` seguido de `RAISE` **en la misma transacción**: el `RAISE` revierte el marcado. El evento quedaba en `processing` con código `NULL` y todo reintento recibía `in_progress` hasta expirar el lease — reintroduciendo la pérdida silenciosa que el handler existe para evitar | `stella_0008:327-350` | El marcado sale de la función: lo hace el handler llamando a `stripe_fail_event`, **en su propia transacción** | Dry run CAP-03 «F6 failure persists with its code» → `failed/org_not_resolved`; «a failed event is reclaimable» → `claimed`. Gate `'CAP-03 does not mark a failure inside the transaction it aborts'` | **CERRADO** |
| **B-F7** | 01·03·04·05 | Ninguna función tenía bloque `EXCEPTION`, así que todo SQLSTATE distinto de `U0001` llegaba al llamante **con su `DETAIL`** — y el `DETAIL` de PostgreSQL cita valores de fila: `Key (user_id)=(<uuid>)` de `user_single_active_membership`, o `Key (stripe_subscription_id)=(sub_…)`. Fuga de datos **y** oráculo | las 8 funciones | `EXCEPTION … WHEN OTHERS` en cada función `plpgsql`: relanza `U0001`/`U0002`, colapsa el resto, y registra **sólo el SQLSTATE**, nunca `SQLERRM` | Gate `'$id: every function collapses engine errors into the uniform refusal'` + `not.toMatch(/RAISE LOG[^;]*SQLERRM/)` | **CERRADO** |
| **B-F8** | 05 | La defensa de idempotencia documentada no defendía: `SELECT … FOR UPDATE` **no bloquea nada** cuando la fila aún no existe, y la clave compuesta sólo se tocaba al final como `ON CONFLICT DO UPDATE`, que nunca bloquea. Lo que impedía el duplicado era un índice preexistente que ningún documento nombraba | `stella_0010:213-216` | La clave se **reclama por `INSERT` antes de cualquier otra escritura**, así que la PK serializa de verdad. El respaldo real para dos claves distintas —`user_single_active_membership`— se nombra ahora en una precondición | Dry run concurrencia B (misma clave → 1 org) y C (claves distintas → 1 membresía, 1 org, el perdedor no deja fila de intento) | **CERRADO** |
| **B-F9** | 03 | La guarda de tenencia cubría **1 de 3** ramas, y sólo si la organización ya tenía un `customer_id` **distinto**. Una organización que nunca se suscribió podía ser capturada por cualquier `client_reference_id`, y las ramas `customer`/`subscription` no comprobaban que `p_stripe_customer_id` coincidiera con lo resuelto | `stella_0008:338-350` | Las tres ramas guardadas: `organization` se rechaza si hay **cualquier** dato de facturación; `customer` exige `p_stripe_customer_id = p_match_value`; `subscription` exige que el `customer_id` de la organización coincida | Dry run CAP-03 «F9 checkout cannot capture an already-billing org» y «F9b customer branch cannot repoint the customer id», ambos `U0001` | **CERRADO** |

## 2. MAJOR

| ID | Capacidad | Mecanismo | Corrección | Prueba de cierre | Estado |
|---|---|---|---|---|---|
| **A-M6 = B-F10** | las 5 | `CREATE OR REPLACE` en la segunda pasada exige propiedad resuelta por `has_privs_of_role`, que `INHERIT FALSE` niega. Los paquetes se declaraban convergentes y abortaban a mitad | Ciclo de vida en la ventana de superusuario | Dry run §2: los cinco aplicados **dos veces**, estado idéntico | **CERRADO** |
| **A-M7** | las 5 | `SET ROLE` es **transitivo**: `uellix_migrator` es `LOGIN` y alcanza `uellix_owner`, que era miembro de los cinco roles de capacidad con `SET TRUE`. Una cadena de conexión real llegaba a las cinco capacidades en dos sentencias, mientras el modelo afirmaba que ninguna lo hacía. La postcondición sólo miraba miembros **directos** | La membresía **desaparece**: al hacer la transferencia de propiedad como superusuario ya no hace falta. Los definers tienen **cero miembros** | Dry run ISO «every capability role has ZERO members». Gate `'$id: the definer role is granted to NOBODY'` | **CERRADO — y la afirmación del modelo pasa a ser cierta** |
| **B-F11** | 02 | El documento afirmaba que crear y revocar una disclosure «sí van a `audit_logs`». No hay trigger, ni inserción, ni protección append-only: la afirmación descansaba en código de aplicación que no existe | Registrado como **RR-CAP-02-F** y la afirmación del documento corregida a lo que el SQL hace. El trigger queda como trabajo de implementación, no como hecho | Documento §10 reescrito | **CERRADO como sobreafirmación**; el trigger queda pendiente y registrado |
| **B-F13** | 02 | `record_verification_hit` es la **única** escritura alcanzable por tráfico anónimo y no tenía `lock_timeout`, `statement_timeout` ni timeout de rol detrás. Su `ON CONFLICT DO UPDATE` serializa a todos los visitantes de un certificado sobre una fila | `SET LOCAL lock_timeout='1s'` y `statement_timeout='2s'`, y un `EXCEPTION WHEN OTHERS` que la hace *best-effort* de verdad | Presente en `stella_0007`; documentado en CAP-02 §4.2 | **CERRADO** |
| **B-F19** | 02 | Tres de las siete filas de la matriz de roles para CAP-02 no coincidían con el SQL (`slug` concedido, camino de escritura del runtime oculto, `sroi_calculation_runs` descrito como condicional) | Matriz regenerada contra el SQL | Matriz §5.2 corregida | **CERRADO** |
| **B-F21 = A-m10** | 02 | El rollback conservaba la tabla **y** el `GRANT SELECT, INSERT, UPDATE … TO uellix_writer` **y** las dos policies de escritura, y *afirmaba* su supervivencia. Estado posterior al rollback con un camino de escritura del runtime sobre una tabla que no existía antes | El rollback conserva la tabla y sus filas, conserva `disclosures_select_member`, y **retira** los grants de escritura y las dos policies de escritura. La asimetría se declara en la cabecera | Dry run §4: rollback limpio; postcondición explícita `'the runtime still holds a write privilege …'` | **CERRADO** |
| **A-m8 = B-F20** | las 5 | Las postcondiciones de aislamiento cruzado usaban `rolname LIKE 'uellix\_cap\_%'`, que **no cubre `uellix_stripe`** — el único rol de capacidad con credencial. Y la comprobación inversa en 0008 sólo miraba las funciones existentes *en ese momento*, así que el orden de aplicación abría un hueco | Las postcondiciones **enumeran `pg_roles`** y afirman que el conjunto de ejecutores es exactamente el declarado; 0008 afirma el negativo sobre todas las funciones del esquema | Dry run ISO «uellix_stripe executes nothing outside CAP-03» y «uellix_app cannot execute a Stripe function» | **CERRADO** |

## 3. Hallazgos que sólo la ejecución encontró

Ninguno visible por lectura. Cuatro fallan **en ejecución**, no al aplicar.

| ID | Capacidad | Mecanismo | SQLSTATE | Corrección | Gate |
|---|---|---|---|---|---|
| **D1** | las 5 | `ALTER FUNCTION … OWNER TO` — confirma A-B1 empíricamente | 42501 al aplicar | ventana 3 | superuser-window |
| **D2** | las 5 | `CREATE OR REPLACE` en segunda pasada — confirma A-M6 | 42501 al reaplicar | ventana 3 | doble aplicación en el ciclo |
| **D3** | 01·02·03·05 | Las policies `{public}` preexistentes se evalúan **para todos los roles**, definers incluidos, y llaman a los tres helpers `SECURITY DEFINER` cuyo `EXECUTE` revocó `stella_0004` a `PUBLIC`. Cuatro capacidades fallaban **toda** lectura contra una policy que les era irrelevante | **42501 en ejecución** | `GRANT EXECUTE` de los tres helpers al definer, con postcondición | `'grants the RLS helpers, without which every guarded read dies at 42501'` |
| **D4** | 01·05 | `USAGE` sobre `auth` — confirma A-B2 | **42501 en ejecución** | ventana 1 | `'grants USAGE on schema auth'` |
| **D5** | 03·04·05 | `pg_catalog.coalesce/nullif` — confirma A-B5 | **42883 en ejecución** | forma desnuda | `'no SQL-standard construct is over-qualified'` |
| **D6** | 03 | **`min(uuid)` no existe** en PostgreSQL. La resolución de organización del webhook moría dentro del webhook | **42883 en ejecución** | `array_agg` + `array_length` | `'no aggregate is used on a uuid column'` |
| **D7** | 03 | `has_any_column_privilege(…, 'DELETE')` **no devuelve `false`**: `DELETE` no tiene forma por columna, así que lanza «unrecognized privilege type» y abortaba el paquete entero | 0A000 al aplicar | Dos comprobaciones: por columna para `SELECT/INSERT/UPDATE/REFERENCES`, por tabla para `DELETE/TRUNCATE/TRIGGER` | `'has_any_column_privilege is never asked for DELETE'` |
| **D8** | 01 | `SELECT … FOR UPDATE` se filtra por el `USING` de la policy de **UPDATE**, que aquí es `status='pending'`. Una lectura con bloqueo de una fila **ya aceptada** devuelve `NOT FOUND`: la rama idempotente era inalcanzable y recargar la página de aceptación daba un rechazo | lógico | Lectura **sin** bloqueo primero; el bloqueo se toma sólo en el camino `pending` y se recomprueba bajo él | `'CAP-01 reads without the lock before taking it'` |
| **D9** | 04 | `ON CONFLICT (expresión)` incorpora las columnas del árbitro al requisito `SELECT` de la sentencia. **Un *conflict target* y un definer sin `SELECT` son mutuamente excluyentes.** Medido: `INSERT` simple → `INSERT 0 1`; `ON CONFLICT DO NOTHING` → `INSERT 0 1`; con objetivo → `permission denied for table` | 42501 en ejecución | `ON CONFLICT DO NOTHING` **sin objetivo**. Se conserva la propiedad que importa —el escritor no puede enumerar— y se declara el coste | `'CAP-04 uses an UNTARGETED ON CONFLICT'` |

## 4. MINOR y NIT — sobreafirmaciones de documentación

Este proyecto trata la sobreafirmación como defecto. Las siete corregidas:

| ID | Afirmación que no era cierta | Corrección |
|---|---|---|
| **B-F14** | La matriz del modelo y el threat model de CAP-03 **reintroducían** la afirmación que sus propias secciones §4.1 y §3 retractan: que `uellix_stripe` no tiene `USAGE` sobre `public` | Ambas celdas dicen ahora «ningún privilegio de tabla ni de columna», y remiten a §4.1 / RR-CAP-7 |
| **B-F15** | «Cada capacidad emite el error desde **exactamente un punto** de su cuerpo, para que no haya dos rutas con latencias distintas». `accept_invitation` lanza desde siete y `bootstrap_organization` desde seis | Reescrito: mismo SQLSTATE y mismo mensaje desde **todos** los puntos; el número de sentencias se iguala **sólo** donde el documento de la capacidad lo dice |
| **B-F16** | §5.3 punto 3 atribuía el aislamiento de `audit_logs` a un `WITH CHECK` que «ata la fila a la organización». Ninguna de las tres policies menciona `organization_id`, y no puede | Reescrito a lo que las policies **sí** hacen: disjunción por `entity_type`, prefijo de `action` y nulidad de `actor_user_id`. La frase «ninguna de las cuatro depende de leer el cuerpo» se acota a los puntos 1, 2 y 4 |
| **B-F17** | CAP-01 §6 decía «cuatro policies», luego añadía una quinta; el paquete crea **seis**. Y describía `cap_invitation_select_users` como acotada a la propia fila cuando el SQL la creaba `USING (true)` | Documento corregido a seis, con las dos que faltaban tabuladas; **y el SQL corregido** a `USING (id = auth.uid())`, que es lo que el documento decía |
| **B-F18** | «las **tres** policies de `marketing_leads` que CAP-04 retira». Retira dos; la tercera se conserva y la postcondición falla si desaparece | «las **dos**», con la tercera nombrada |
| **B-F22** | CAP-02 afirmaba que `LANGUAGE sql` con un `SELECT` «elimina por construcción una clase de canal lateral de temporización». Un plan compartido no es trabajo compartido: un hash inexistente se corta en el índice único | Reescrito: el **resultado** es indistinguible por construcción; el **tiempo** no está igualado ni medido. Registrado como **RR-CAP-02-E**, con el mismo trato que RR-CAP-01-A |
| **B-F25b** | RR-CAP-05-C describía «un `INSERT` en la tabla de settings correspondiente». Esa tabla no existe | **CERRADO**: la configuración de una organización son sus propias columnas, y las que la capacidad no nombra toman el `DEFAULT` — que es precisamente el mecanismo por el que no puede elegir plan ni cuota |

## 5. MINOR y NIT restantes, registrados y no cerrados

| ID | Descripción | Por qué no se cierra aquí |
|---|---|---|
| **A-m9** | `pg_tables` omite vistas, vistas materializadas, tablas foráneas y secuencias | **CERRADO**: todas las postcondiciones usan `pg_class` filtrado por `relkind` |
| **A-n11** | Índice no único redundante sobre `token_hash` | **CERRADO**: el forward lo elimina, el rollback lo recrea |
| **B-F12** | `capability_verification_hits` no lo lee nadie: la capacidad que el documento describe («¿cuántas veces se verificó?») no está implementada | Registrado como **RR-CAP-02-G**. El `COMMENT` de la tabla dice ahora «recogido, no expuesto». Exponerlo es trabajo de producto |
| **B-F23** | La postcondición de `proconfig` usaba coincidencia por prefijo, que también acepta `search_path=public, pg_temp` | **CERRADO**: enumera las dos grafías legales del valor vacío, en los cinco paquetes |
| **B-F24** | La exclusión de línea base por prefijo `cap_`/`disclosures_` es también un punto ciego: nada creado con esos prefijos lo ven las precondiciones | Registrado como **RR-CAP-8**, NIT. Acotarlo a nombres exactos es posible y no se hace aquí para no acoplar las precondiciones al inventario de cada paquete |
| **B-F25a** | `stripe_webhook_events.status DEFAULT 'received'` era inalcanzable | **CERRADO**: el `DEFAULT` se retira; `received` queda en el `CHECK` como valor reservado |
| **B-F25c** | El índice único trata los `NULL` como distintos y el `GROUP BY` de la precondición como iguales; sólo coinciden mientras `source` sea `NOT NULL` | **CERRADO**: la precondición de CAP-04 afirma explícitamente que `source` es `NOT NULL` y aborta si deja de serlo |
| **RR-CAP-01-A** | Canal lateral de temporización en CAP-01 | Mitigado (el correo se resuelve antes de mirar la invitación), **no declarado cerrado**: la igualdad exacta no se ha medido |
| **RR-CAP-02-E** | Idem en CAP-02 | Registrado, no mitigado |
| **RR-CAP-03-A** | El *lease* de 15 minutos es una heurística | Registrado |
| **RR-CAP-03-B** | El `catch` del handler actual registra el objeto de error completo | **Precondición de habilitación**; el handler no se toca en esta unidad |

---

## 6. Qué NO se rebajó

Ningún hallazgo cambió de severidad. Dos que podrían haberse rebajado y no se
rebajaron:

* **B-F5** (publicación entre tenants) se mantuvo MAJOR aunque exigía conocer
  un UUID de reporte ajeno. La FK se valida como owner y salta RLS, así que el
  UUID era el único obstáculo — y un UUID no es un secreto.
* **A-M7** (`SET ROLE` transitivo) se mantuvo MAJOR aunque exigía la credencial
  de `uellix_migrator`. Esa credencial existe, es `LOGIN`, y el modelo afirmaba
  categóricamente que *"no existe cadena de conexión, sesión ni JWT que resuelva
  a un rol de capacidad"*. La afirmación era falsa; el arreglo la hace cierta.

# Ronda 2 — revisión adversarial del diseño corregido

Continuación de [`ADVERSARIAL_FINDINGS.md`](ADVERSARIAL_FINDINGS.md).
**Fecha:** 2026-08-03. **Nada aplicado a ningún stack vivo.**

Los dos revisores independientes se relanzaron sobre los paquetes reescritos y
sobre el dry-run ya ejecutado.

| Revisor | BLOCKER | MAJOR | MINOR | NIT |
|---|---|---|---|---|
| **A** — privilegio y aislamiento | **0** | 10 | 9 | 2 |
| **B** — rutas de ataque (30 ataques) | **0** | 3 | 12 | 4 |

**Los BLOCKER de la ronda 1 quedaron cerrados y verificados.** B confirma
**26 de 30 ataques detenidos**, nombrando la sentencia exacta que detiene cada
uno; los cuatro restantes son los MAJOR de abajo.

---

## El hallazgo que sólo aparece al cruzar los dos revisores

Los dos llegaron a conclusiones **opuestas** sobre la misma guarda de CAP-03:

* **A2-F04** — la guarda es demasiado **estricta**. Refusaba cualquier
  organización con historial de facturación, y `stripe_customer_id` nunca se
  limpia, así que un cliente que cancela y vuelve a suscribirse quedaba
  rechazado **para siempre**, con Stripe reintentando el mismo evento hasta
  rendirse. El caso que rompía era el que paga.
* **B2-F1** — la guarda es demasiado **laxa**. Una organización que **nunca** se
  suscribió tiene esas columnas en `NULL`, así que la guarda pasa y cualquier
  `client_reference_id` la reclama. Y `client_reference_id` lo elige quien crea
  la sesión de checkout: un Payment Link de Stripe lo acepta como parámetro del
  comprador.

Ambos tienen razón, y la contradicción **es** la respuesta: ningún predicado
sobre la fila actual distingue una primera suscripción legítima de una
reclamación hostil, porque la única evidencia en cualquiera de los dos sentidos
es el campo que elige el atacante.

**La vía `match_kind = 'organization'` se elimina.** La capacidad se niega a ser
el sitio donde una organización se ata por primera vez a un cliente de Stripe.
Esa atadura la debe registrar un flujo autenticado de primera parte **antes** de
que llegue ningún webhook — **DP-CAP-15**, sin decidir.

---

## MAJOR

| ID | Cap. | Mecanismo | Corrección | Prueba de cierre | Estado |
|---|---|---|---|---|---|
| **A2-F01** | 01 | La rama idempotente pasó a decidirse sobre la lectura sin bloqueo, así que dos envíos concurrentes del mismo sujeto la saltaban: T2 leía `pending` (T1 sin confirmar), bloqueaba en `FOR UPDATE`, y al confirmar T1 la recomprobación EPQ aplicaba `USING (status='pending')` → `NOT FOUND` → rechazo. El *reload* secuencial funcionaba; el reenvío **concurrente** no | Lectura de recuperación **sin bloqueo** tras el `FOR UPDATE` fallido — tiene que ser sin bloqueo, por la misma policy que devolvió vacío | Dos sesiones **solapadas** en el dry run: T1 retiene 1 s, T2 bloquea, T1 confirma, **T2 devuelve la organización**; 1 membresía | **CERRADO** |
| **A2-F02** | 01·02·05 | **El hallazgo estructural.** Las policies PERMISSIVE se combinan con **OR**, y las 105 `{public}` de línea base se aplican también a los definers. Sus predicados llaman a `auth.uid()`, una GUC de **sesión** que `SECURITY DEFINER` no reinicia, así que dentro del definer resuelven al **llamante**. Un llamante org-admin desactivaba por OR todas las cotas de las policies `cap_*`. Toda afirmación del tipo "la policy sobrevive a una reescritura del cuerpo" era **falsa**; la cota real la daba el ACL | **9 policies `AS RESTRICTIVE`** (3 CAP-01, 2 CAP-02, 1 CAP-04, 3 CAP-05). Una restrictiva se combina con AND y no puede desactivarse por OR | Dry run: 141 policies tras aplicar (132 + 9), postcondición por paquete, gate estático | **CERRADO — y las afirmaciones pasan a ser ciertas** |
| **A2-F03** | 02 | `issued_on` y `report_variant` se devolvían **sin flag**, mientras la cabecera afirmaba que un reporte con disclosure y ningún booleano "no revela nada más". La fecha de bloqueo de un reporte privado y qué variante se produjo **son** revelaciones | `show_issued_on` y `show_report_variant`, `DEFAULT false`, ambos campos entre `CASE` | Dry run CAP-02 L5 (todo `NULL`) y L6 (fecha y variante siguen ocultas) | **CERRADO** |
| **A2-F04 + B2-F1** | 03 | Ver arriba | La vía `organization` se elimina; las dos restantes exigen que **todo** identificador del evento concuerde con la fila que resolvió | Dry run «the client_reference_id path is gone entirely» → `U0001` | **CERRADO** |
| **A2-F05 + B2-F2** | 03 | La rama `subscription` decía "si el llamante nos dijo un cliente, debe coincidir" — que no es guarda cuando el llamante no dice nada. Y nada ataba `p_stripe_subscription_id` a `p_match_value`, así que un evento resuelto por `sub_A` podía escribir `sub_B` | Ambos operandos obligatorios; la suscripción del evento debe ser aquella **por la que** se resolvió la fila | Dry run CAP-03 | **CERRADO** |
| **A2-F06** | 04 | La función afirmaba «la postcondición de abajo fija el conjunto de constraints» y esa postcondición **no existía**. Un `ON CONFLICT DO NOTHING` sin objetivo se traga la violación de **cualquier** constraint único, y con `RETURNS void` un lead descartado es indistinguible de uno guardado | Postcondición que enumera `pg_index` y aborta ante cualquier índice único/exclusión fuera de los dos previstos | §4.4a, ejecutada en cada aplicación del dry run | **CERRADO** |
| **A2-F07** | las 5 | `WHEN OTHERS` **no captura** `query_canceled` (57014) ni `assert_failure`: PL/pgSQL los excluye. Un `statement_timeout` disparando a mitad —y `uellix_stripe` lo lleva como GUC de rol— llegaba al llamante como 57014 con el mensaje de PostgreSQL. Además `SET LOCAL statement_timeout` **dentro** de una función ya en ejecución es inerte: el temporizador se arma una vez, en `start_xact_command()` | Rama `WHEN query_canceled` en las siete funciones `plpgsql`; en el contador, que es best-effort, **devuelve** en vez de lanzar. El `statement_timeout` inerte se retira y la afirmación de "dos timeouts" se corrige | Gate estático extendido | **CERRADO** |
| **A2-F08** | modelo | §5.3 afirmaba disjunción de columnas entre roles de capacidad; `uellix_cap_invitation` y `uellix_cap_bootstrap` tienen grants **idénticos** sobre `organization_members` y `users`, y dos listas de `action` se solapan en `('organization_member','membership.created')` | §5.3 reescrito a lo que las policies **sí** hacen | Documento corregido | **CERRADO como sobreafirmación** |
| **A2-F09** | 04 | `stella_0004` §6b concede incondicionalmente los cuatro privilegios sobre `marketing_leads` a `uellix_writer` y **aborta** si faltan. Ambos scripts son re-ejecutables, así que reaplicar `stella_0004` tras CAP-04 restauraba el grant y pasaba sus propias comprobaciones, sin diagnóstico | Policy **`AS RESTRICTIVE … TO uellix_app USING (false)`**: se combina con AND, así que niega al runtime pase lo que pase con los grants | Dry run CAP-04 L8/L9; postcondición que exige la policy y que sea `RESTRICTIVE` | **CERRADO técnicamente**, no sólo documentado |
| **A2-F10 + B2-F15** | 03·04 | Los documentos fuente describían el comportamiento **anterior** a la reescritura, incluidos los dos defectos que la ronda 1 eliminó | §4.1, §5.1 y §5.2 de CAP-03 regenerados | Documentos corregidos | **CERRADO** |
| **B2-F3** | modelo·03 | *"Que `uellix_app` no pueda llamar a estas funciones es lo que impide que un endpoint cualquiera mueva una cuota"* — **falso y preexistente**: `uellix_writer` tiene `UPDATE` a nivel de tabla sobre `organizations` y `orgs_update_admin_or_super` es `{public}` sin predicado de columna, así que cualquier org-admin escribe `stella_monthly_quota` por el ORM hoy, sin CAP-03 | La afirmación se corrige a lo cierto (CAP-03 no **añade** esa vía); la vía preexistente se registra | Documentos corregidos | **CERRADO como afirmación**; la vía preexistente **ABIERTA** como RR-CAP-10 |
| **B2-F14** | modelo | El documento fuente **seguía prescribiendo** la membresía que el SQL ahora prohíbe, en cuatro sitios; un operador que lo implementara **abortaría el paquete**. Y RR-CAP-0 seguía diciendo "todo es SQL leído" mientras los ficheros que gobierna citan mediciones del dry run | §3 regla 2, §5.1 (tabla y prosa), §1.1 y RR-CAP-1 reescritos; RR-CAP-0 actualizado | Documento corregido | **CERRADO** |

## MINOR y NIT — corregidos

| ID | Mecanismo | Corrección |
|---|---|---|
| A2-F11 / B2-F5 | `(r.locked_at AT TIME ZONE 'UTC')::date` sobre una columna **naive** produce un `timestamptz`, y el `::date` lo renderiza en la zona de la sesión: un reporte bloqueado a las 23:30 UTC publica fecha distinta según la conexión. Doce líneas más abajo el mismo idioma **es** correcto, porque allí el operando sí es `timestamptz` | `r.locked_at::date` |
| A2-F12 / B2-F4 | La expiración de invitación comparaba `timestamp` con `timestamptz`, promoviendo el operando naive con la zona de la sesión: un plazo de seguridad decidido de forma no determinista | `(pg_catalog.now() AT TIME ZONE 'UTC')` |
| A2-F13 / B2-F13 | El rollback de CAP-03 seguía revocando una membresía que el forward ya no concede | Línea eliminada |
| A2-F14 | Los barridos por `relkind` excluían `'S'` mientras su comentario nombraba las secuencias | Comentario corregido al alcance real |
| A2-F21 | Un evento re-reclamado arrastraba el `last_error_code` anterior hasta `completed` | `last_error_code = NULL` en el `DO UPDATE` |
| B2-F7 | `revoked_by` no estaba fijado y una revocación podía deshacerse | `WITH CHECK (revoked_by IS NULL OR revoked_by = auth.uid())` |
| B2-F9 | Sin estado terminal para un evento que el handler ignora, la fila quedaba en `processing` para siempre y el índice de estado dejaba de distinguir un worker muerto de tráfico rutinario | Estado `ignored` + código `not_applicable` |
| B2-F12 | El respaldo de concurrencia se afirmaba **por nombre de índice**; uno que hubiera perdido `UNIQUE` habría pasado | Se afirma la **forma** (`indisunique AND indpred IS NOT NULL`), y se añade a CAP-01, que dependía de él sin comprobarlo |
| B2-F18 | Referencia a columna externa sin cualificar en las tres policies de disclosure: si `sroi_reports` ganara una columna `report_id`, el predicado se volvería auto-referencial y reescribiría una regla de autorización sin error ni fallo de test | `public.report_public_disclosures.report_id` |
| B2-F19 | `submit_lead` era la única función `plpgsql` sin `lock_timeout`, y es alcanzable anónimamente | `SET LOCAL lock_timeout = '3s'` |
| B2-F6 | *"No hay resolución implícita, así que no hay nada que sombrear"* — inexacto: `pg_temp` **nunca** se busca para funciones ni operadores (regla del motor, no de la ruta), y **sí** se consulta para relaciones y tipos | §3.1 reescrito a lo que la construcción sostiene |
| B2-F11 | *"Sus únicos privilegios en toda la base"* — verificado sólo sobre `public` y `uellix_capability` | Alcance acotado explícitamente |
| B2-F17 | CAP-01 §8 prometía un 200 idempotente que la reescritura no daba | Fila corregida **y el comportamiento arreglado** (A2-F01), así que la promesa vuelve a ser cierta |
| B2-F18b | *"No compilaría"* — PostgreSQL comprueba ACL al arrancar el ejecutor, no al crear la función | Corregido a «fallaría en ejecución con 42501; lo que impide llegar ahí es la postcondición» |

## Lo que queda abierto

| ID | Riesgo | Severidad | Por qué no se cierra aquí |
|---|---|---|---|
| **RR-CAP-10** | Cualquier `organization_admin` puede escribir `stella_monthly_quota` y `stella_plan_label` por el ORM: `uellix_writer` tiene `UPDATE` a nivel de tabla sobre `organizations` y `orgs_update_admin_or_super` no tiene predicado de columna. **Preexistente**; CAP-03 no lo añade ni lo cierra | MAJOR (preexistente) | Cerrarlo exige acotar por columna el `UPDATE` del runtime sobre `organizations` — un cambio a la superficie de escritura de la aplicación, con su propio análisis de impacto. No cabe en un paquete de capacidad |
| **RR-CAP-11** | `anon` y `authenticated` conservan sus grants de tabla sobre `marketing_leads` tras CAP-04, sin policy de escritura aplicable | MINOR | Los grants pertenecen al contrato PostgREST de `stella_0004`, no a esta capacidad. Inertes hoy; registrados en vez de aceptados en silencio |
| **DP-CAP-15** | Quién ata una organización a un cliente de Stripe por primera vez, y con qué evidencia | decisión de producto | La vía insegura se eliminó; la segura no se inventa aquí |

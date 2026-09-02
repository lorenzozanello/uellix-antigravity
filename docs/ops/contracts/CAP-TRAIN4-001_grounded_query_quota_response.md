# CAP-TRAIN4-001 — Respuesta a INT-CAP-001: cuota consumible para `grounded_query`

| Campo | Valor |
|---|---|
| **Solicitante** | INTEGRACIÓN (revisión adversarial del tren 3, 2026-08-05) |
| **Propietaria** | CAPABILITIES |
| **Estado** | `aceptado` — **entregado como diseño**. `db/prepared/stella_0013_grounded_query_quota.sql`, no aplicado a ninguna base |
| **Fecha** | 2026-08-05 |
| **Contrato origen** | `docs/ops/contracts/CONTRACT_LEDGER.md` § INT-CAP-001 |

## 1. Lo que se pidió, y por qué era la mitad pequeña

INT-CAP-001 pide una cosa por su nombre: añadir `grounded_query` al CHECK
`stella_interactions_stella_role_check`. **Se hizo**, y por sí sola no habría
cerrado nada.

Con el valor añadido y nada más, la fila pasa a ser *representable* y la
capacidad sigue sin poder *cobrar*:

| Hueco | Por qué el CHECK no lo cierra |
|---|---|
| `checkStellaQuota` **lee** un conteo y devuelve. La decisión y la escritura son dos sentencias sin transacción entre ellas | Dos llamantes concurrentes observan `used = quota - 1` y ambos siguen. Un vocabulario que permite la fila no serializa a los dos |
| Nada identifica «la misma operación» | Un server action reintentado cobra dos veces. `context_hash` es el hash del *contexto* de una interacción y se repite legítimamente |
| El llamante podía nombrar su organización | La ruta de lectura reimpone la frontera; la de escritura no tenía ninguna, porque no había ruta de escritura |

Por eso el paquete entrega el vocabulario **y** el mecanismo que lo hace
cobrable.

## 2. Lo entregado

`uellix_stella.consume_stella_quota(uuid, uuid, varchar(50), char(64))` —
`SECURITY DEFINER`, `search_path = ''`, propiedad de `uellix_cap_stella_quota`
(NOLOGIN, cero miembros), invocable sólo por `uellix_app`.

Cumple los diez requisitos del encargo:

| # | Requisito | Cómo |
|---|---|---|
| 1 | recibe organización y categoría gobernada | argumentos `p_organization_id`, `p_stella_role` |
| 2 | reconoce `grounded_query` | array `v_governed` de 7 valores; §7 del script **afirma** que ese array y el CHECK nombran el mismo conjunto |
| 3 | comprueba el límite | `v_used >= v_quota` contra `organizations.stella_monthly_quota`, mes UTC como `lib/stella/quota.ts` |
| 4 | consume exactamente una unidad | un `INSERT` en `stella_interactions` |
| 5 | rechaza cuando está agotada | `outcome = 'quota_exceeded'`, **sin** excepción — ver §3 |
| 6 | segura ante reintento | `ON CONFLICT (organization_id, idempotency_key) DO NOTHING` sobre índice único parcial |
| 7 | no cobra dos veces | el índice único hace de la garantía una propiedad de los **datos**, no de quién llamó |
| 8 | sin consumo cross-organization | `current_user_org_ids()` + el proyecto verificado contra la organización + la misma pareja repetida en la policy RLS |
| 9 | no depende de datos del cliente | `created_by` viene de `auth.uid()`; `context_hash` es un digest server-side; `response_json` es un literal fijo |
| 10 | no requiere `service_role` | ningún grant a `service_role` en el paquete |

**Clave de idempotencia:** columna nueva `stella_interactions.idempotency_key
char(64)`, nullable en general y **obligatoria** para `grounded_query`
(`stella_interactions_grounded_query_idempotency_check`), con
`uq_stella_interactions_idempotency` `UNIQUE (organization_id,
idempotency_key) WHERE idempotency_key IS NOT NULL`.

Es nullable porque las cinco acciones Stella hermanas escriben por la ruta de
runtime ordinaria y no tienen clave que aportar; `NOT NULL` habría convertido
este paquete en un cambio rompedor de cinco flujos que funcionan, en beneficio
de un sexto.

## 3. Tres decisiones que conviene discutir

**Devuelve un resultado en vez de lanzar cuando la cuota está agotada.**
«Agotada» es un estado de negocio esperado que el producto pinta con la fecha
de renovación. Lanzar abortaría la transacción del *llamante*, así que una
acción que ya hubiera escrito su fila de auditoría la perdería: una negativa a
servir se convertiría en silencio en una negativa a registrar. Las excepciones
quedan para lo que son — entrada malformada (`U0100`), alcance ajeno (`U0102`),
categoría fuera del vocabulario (`U0106`).

**Un lock de advisory por organización, no `SELECT ... FOR UPDATE`.**
PostgreSQL exige privilegio `UPDATE` sobre una tabla para tomar un lock de fila
en ella. Conceder `UPDATE ON public.organizations` al rol de capacidad para que
un lock resulte cómodo es exactamente cómo una frontera deja de significar
algo — la misma reparación que `register_document_version` ya lleva desde el
tren 2. El lock se toma **antes** del conteo, y el gate `quota-advisory-lock`
comprueba ese orden: un lock tomado después no serializa nada, porque ambas
transacciones ya leyeron el mismo número.

**Se extiende `stella_interactions` en vez de crear un segundo ledger.**
`checkStellaQuota` cuenta filas de esa tabla. Una tabla nueva habría que
contarla *también*, editando una función de la que dependen cinco acciones, y
hasta que todas migraran la cuota impuesta y la cobrada serían dos números
distintos.

## 4. Residual declarado, no cerrado

`uellix_app` **hereda** `uellix_writer`
(`db/baseline/stella_g2_roles.sql:223`), que tiene `SELECT, INSERT` directo
sobre `stella_interactions` (`db/baseline/stella_g2_schema.sql:11321`). La
escritura directa al ledger **ya existía** y es el mecanismo canónico de las
cinco acciones hermanas; este paquete no puede revocarla sin romperlas.

Lo que sí hace: el CHECK de obligatoriedad impide que esa ruta cobre una unidad
`grounded_query` **sin identidad**, y el índice único impide que cobre **dos
veces la misma**. El residual queda acotado a «un llamante puede sobrecargarse
a sí mismo con claves distintas», que no obtiene una respuesta fundamentada
—el server action sigue decidiendo— y no cruza ninguna frontera de tenencia.

**Suposición de zona horaria.** El límite mensual se calcula con
`date_trunc('month', timezone('UTC', now()))` para coincidir literalmente con
`startOfCurrentUtcMonth()` de `lib/stella/quota.ts`. `created_at` es
`timestamp` sin zona, escrito por `now()`, así que los dos coinciden
exactamente cuando el `TimeZone` del servidor es UTC — el valor por defecto de
Supabase y el de todos los entornos de este proyecto.

## 5. El rollback puede negarse, y es correcto

Estrechar el CHECK a seis valores sobre un ledger con filas `grounded_query` es
imposible: la tabla es append-only para **todo** rol incluido el dueño
(`trg_stella_interactions_append_only`), así que las filas no se pueden retirar
para hacerle sitio a la constraint. El script las cuenta primero y **explica**,
en vez de dejar que el operador lea una violación de constraint cruda tres
secciones más tarde y adivine.

Verificado en vivo: `scripts/stella-train4-dry-run.sh` §10.

## 6. Evidencia

- **Estática:** `tests/train4-persistence-mutation.test.ts` — 60 mutaciones, cada una rechazada por el gate que posee la propiedad; baseline limpio; cero gates sin ejercitar salvo `source-missing`, declarado.
- **Viva:** `scripts/stella-train4-dry-run.sh` §7 y §9, en contenedor desechable sin red — primer consumo, reintento con la misma clave, clave distinta, agotamiento, organización cruzada (`U0102`), proyecto cruzado (`U0102`), rol no gobernado (`U0106`), clave malformada (`U0100`), ausencia de residuo tras los rechazos, y **dos sesiones reales disputando la última unidad** (la segunda espera al COMMIT de la primera y recibe `quota_exceeded`).
- **Convergencia:** aplicar ×2 idéntico, rollback == baseline, reaplicar == aplicado.

## 7. Lo que esta línea NO hizo

No se tocó `app/actions/stella/grounded-query.ts`. El server action sigue sin
llamar a la función: conectar la llamada es trabajo de INTEGRACIÓN, y hasta que
ocurra `QUOTA_LEDGER_ROLE_MISSING` sigue describiendo el estado real del
runtime. Lo que cambia es que la constante ya no describe un bloqueo: describe
una llamada pendiente.

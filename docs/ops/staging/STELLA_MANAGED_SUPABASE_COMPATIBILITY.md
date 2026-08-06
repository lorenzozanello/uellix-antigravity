# STELLA — Compatibilidad con Supabase gestionado (Train 5B)

> Cierra el bloqueador **B1** de
> [`STELLA_STAGING_RISK_REGISTER.md`](STELLA_STAGING_RISK_REGISTER.md): «los diez
> paquetes exigen superusuario y Supabase gestionado no lo ofrece».
>
> **Nada se aplicó a ninguna base.** Cero acceso remoto, cero Supabase, cero
> Docker, cero proveedor, cero secretos leídos.

---

## 1. La decisión

El objetivo es un **proyecto Supabase gestionado independiente**, creado sólo
para staging. Se descarta el self-hosting, que habría preservado el requisito de
SUPERUSER y con él el modelo de `stella_0004` sin cambios.

Consecuencia asumida y declarada: **el modelo de roles hosted es más débil que el
local**, y lo es por una razón concreta y no negociable (§4). No se disimula en
un comentario — el propio bootstrap lo emite como `RAISE NOTICE` al terminar y
lo registra en el centinela.

## 2. La arquitectura, en una frase

Los diez paquetes canónicos **no se editan**. El artefacto hosted se **deriva**
de ellos por cuatro reglas enumeradas, y el manifiesto fija tanto el SHA-256 del
fuente como el número exacto de veces que cada regla debe disparar.

```
db/prepared/<paquete>.sql            fuente única de verdad (sin tocar)
        │
        │  db/hosted/rewrite-rules.ts        4 reglas enumeradas
        │  db/hosted/hosted-package-manifest.ts   SHA-256 + conteos esperados
        ▼
db/prepared/hosted/<paquete>.hosted.sql   artefacto derivado, versionado
```

**Por qué generación y no diez variantes a mano.** Una copia editada produce dos
fuentes para un contrato, y la segunda diverge la primera vez que alguien parchea
sólo el original — exactamente como `grounding_0001` dejó de satisfacer GR-001 y
hubo que superseder. Con el generador, editar un canónico sin regenerar da
`HOSTED_SOURCE_SHA_MISMATCH`; aflojar una regla sin tocar el canónico da
`HOSTED_REWRITE_COUNT_MISMATCH`. Un hash solo no vería lo segundo.

## 3. Las cuatro reglas

| Regla | Qué sustituye | Por qué es **más estrecha**, no más débil |
|---|---|---|
| `superuser-precondition` | Las 3 líneas de `IF NOT (SELECT rolsuper …) THEN RAISE` | Pasa a `uellix_bootstrap.assert_hosted_capabilities('<pkg>')`, que comprueba CREATEROLE, membresía en `uellix_owner`, `CREATE` sobre los esquemas destino, la existencia del shim **y la fila de centinela**. Un superusuario satisface todo eso, así que nada que antes se rechazara ahora se acepta |
| `auth-schema-grant` | `GRANT USAGE ON SCHEMA auth` + `GRANT EXECUTE ON auth.uid()` | No son emitibles en gestionado (RR-09). Se sustituyen por `GRANT EXECUTE ON public.uellix_auth_uid()`, el shim del bootstrap |
| `auth-uid-precondition` | `to_regprocedure('auth.uid()') IS NULL` | Pasa a una **conjunción**: exige el shim **y** la función subyacente. Estrictamente más fuerte |
| `auth-uid-call` | `auth.uid()` ejecutable | Pasa a `public.uellix_auth_uid()`. Nunca en comentarios, nunca dentro de literales de cadena, nunca en líneas `GRANT`/`REVOKE` |

Conteos fijados por paquete (el manifiesto los impone; el generador se niega si
no cuadran):

| Paquete | superuser | auth-grant | auth-precond | auth-call |
|---|--:|--:|--:|--:|
| `grounding_0002` | 1 | 0 | 0 | 0 |
| `grounding_0003` | 1 | 0 | 0 | 0 |
| `grounding_0004` | 1 | 0 | 0 | 0 |
| `stella_0013` | 1 | 1 | 1 | 2 |
| `stella_0014` | 1 | 1 | 1 | 10 |
| `stella_0015` | 1 | 0 | 1 | 4 |
| `stella_0016` | 1 | 0 | 1 | 5 |
| `stella_0017` | 1 | 0 | 1 | 2 |
| `stella_0018` | 1 | 0 | 0 | 1 |

`grounding_0002/0003/0004` no necesitan la ruta de auth: sus funciones gobernadas
llegan a la identidad **a través de** `public.current_user_org_ids()`, que es
`SECURITY DEFINER` y corre como su propio dueño. Sólo `stella_0013` y
`stella_0014` concedían `USAGE ON SCHEMA auth` directamente.

### 3.1 Lo que NINGUNA regla toca

Predicados de policy, columnas de scope, transferencias de ownership, `REVOKE`,
marcadores `SECURITY DEFINER`, `search_path`, CHECKs y bloques de
autoverificación. Verificado por `tests/hosted/managed-compatibility.test.ts`,
que además comprueba que las tres menciones supervivientes de `rolsuper` en los
artefactos son **postcondiciones** sobre roles que creamos —no guardas— y que
`U0110`, `U0111`, `U0112` y `U0106` siguen presentes.

## 4. El bootstrap hosted

`db/prepared/stella_hosted_0001_managed_role_bootstrap.sql` (+ su rollback).

**No edita `stella_0004`, y se niega a correr donde `stella_0004` es aplicable.**
Si detecta un superusuario, aborta y remite al paquete local — instalar en
silencio el modelo más débil sobre una base capaz de sostener el fuerte sería una
degradación que nadie eligió.

### 4.1 Detección de entorno — cinco condiciones, todas refusals

| # | Condición |
|---|---|
| E1 | Topología Supabase real: los 7 roles (`supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`, `authenticator`, `anon`, `authenticated`, `service_role`) y los 3 esquemas (`auth`, `storage`, `extensions`) |
| E2 | `current_user` **NO** es superusuario |
| E3 | `current_user` tiene CREATEROLE **y** CREATE sobre `public` |
| E4 | `uellix.bootstrap_environment` es exactamente `'staging'`. **Sin default.** Espacio final, mayúscula distinta o ausencia son rechazos |
| E5 | Helpers RLS presentes, `auth.uid()` presente, y —E5b— **el dueño de los helpers puede alcanzar `auth.uid()`** |

E5b es la que decide si el shim es posible. Si falla, el mensaje nombra
`STELLA_TRAIN_5B_BLOCKED_AUTH_SCHEMA` y no hay rodeo desde SQL.

### 4.2 El shim de auth

```sql
CREATE OR REPLACE FUNCTION public.uellix_auth_uid()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT auth.uid() $$;
```

`stella_0013` había rechazado explícitamente «re-implementar la expresión
`current_setting` de `auth.uid()`» por ser una copia que diverge. **Esto no es
eso:** el cuerpo es la llamada, así que sigue habiendo **una sola derivación de
identidad** en la base y esta función es una puerta hacia ella.

Es `SECURITY DEFINER` propiedad del instalador, que en gestionado es `postgres`
y tiene BYPASSRLS. Eso normalmente merece sospecha; aquí no confiere nada porque
**el cuerpo no lee ninguna relación** — no hay tabla sobre la que RLS pudiera
saltarse. La §6 del paquete lo **afirma**: comprueba que el cuerpo delega, que no
contiene `FROM`, y que es `SECURITY DEFINER` con `search_path` vacío. Una edición
futura que inlinease la expresión o añadiese una tabla haría fallar el paquete.

### 4.3 Equivalencia de roles

| Rol | Local (`stella_0004`) | Hosted (`stella_hosted_0001`) | Diferencia |
|---|---|---|---|
| `uellix_owner` | NOLOGIN, dueño de 38 tablas + 8 funciones de `public` | NOLOGIN, dueño de `uellix_bootstrap` y de lo que la cadena le transfiera | **No toma el ownership del baseline.** Deliberado: hacerlo exigiría `USAGE ON SCHEMA auth` para el owner (RR-09) y rompería **toda** la RLS del producto |
| `uellix_migrator` | LOGIN, alcanza owner por SET | idéntico (SET TRUE, INHERIT FALSE) | ninguna |
| `uellix_app` | LOGIN, NOBYPASSRLS | idéntico | ninguna |
| `uellix_writer` | NOLOGIN, heredado por app | idéntico | ninguna |
| `uellix_auditor` | LOGIN read-only | idéntico | ninguna |
| Roles de capacidad | los crean los paquetes | los crean los paquetes | ninguna |

**La divergencia que importa:** en local, `stella_0004` traslada el ownership de
los 46 objetos de `public`. En hosted **no se hace**, y no por comodidad: los
helpers RLS son `SECURITY DEFINER` y su dueño debe poder resolver `auth.uid()`.
Transferirlos a `uellix_owner`, que no puede recibir `USAGE ON SCHEMA auth`, los
dejaría fallando con `permission denied for schema auth` **para todos los
invocantes**. Se conserva el dueño del baseline y se documenta.

### 4.4 RR-02 — lo que sigue siendo más débil

Un rol **no superusuario** con CREATEROLE recibe `ADMIN OPTION` automática sobre
cada rol que crea (PostgreSQL 16+). Así que `postgres` puede, en cualquier
momento, `GRANT uellix_owner TO postgres WITH SET TRUE` y volverse el owner.

La separación owner/runtime es aquí un **obstáculo auditable** —cruzarlo exige
una sentencia explícita y registrable— y no una barrera criptográfica. **No
cerrable en Supabase gestionado.** Lo que sí se conserva:

- el runtime no alcanza al owner por herencia (postcondición §6.2);
- `uellix_app` nunca tiene BYPASSRLS;
- los roles de capacidad son NOLOGIN con cero miembros;
- `service_role` no se usa, no recibe nada, y `stella_0017` le revoca el ledger.

## 5. El migrator hosted

`db/hosted/hosted-migrator.ts` es una superficie **separada** de
`db/migrator.ts`, que sigue pidiendo la capacidad `local_migration`
(loopback/contenedor) y por tanto sigue rechazando todo destino hosted, para
siempre. Ampliar aquella capacidad para que sirviera aquí habría sido exactamente
lo que `DATABASE_TARGET_SAFETY.md` §3.1 prohíbe.

**Es un planificador puro:** no abre conexión, no lee el sistema de archivos, no
consulta el reloj. Devuelve una negativa o un plan ordenado con los hashes de
cada paso. Ejecutarlo es una unidad posterior y **no está cableada** — un módulo
que no puede conectarse es mejor garantía que uno que decide no hacerlo.

Orden de comprobaciones (y el orden es una decisión):

1. **identidad del destino** — antes que nada;
2. pertenencia a la cadena, y luego orden;
3. **supersesiones** (el mismo registro que usa `db/migrator.ts`);
4. completitud: primera provisión = las diez; unidad de grounding; cadena de
   tickets hasta `0018`;
5. generación (aquí afloran deriva de fuente y deriva de regla);
6. **la puerta de escritura**, la última y separada de todo lo demás.

El paso 3 va **antes** que el 4 a propósito: reaplicar `stella_0014` sobre
`stella_0015` también es una cadena incompleta, pero no es *por eso* que se
rechaza — se rechaza porque republicaría cuatro firmas `SECURITY DEFINER` ciegas
al proyecto. Un operador que lea el motivo débil primero intentará satisfacerlo
añadiendo paquetes, que es justo el movimiento equivocado.

### 5.1 Identidad de staging — tres señales independientes

| Señal | Qué la falsifica | Qué NO la falsifica |
|---|---|---|
| `declared-environment` | copiar una invocación | pegar una cadena de conexión |
| `host-derived-project-ref` | pegar una cadena de conexión | copiar una invocación |
| `in-database-sentinel` | — | ninguna de las dos |

Y **un veto que las supera a todas:** `KNOWN_PRODUCTION_IDENTIFIERS` se comprueba
primero e incondicionalmente. Tres señales concordantes son motivo para seguir; un
identificador de producción conocido es motivo para parar, y un diseño donde
suficiente concordancia falsificada vence a una coincidencia con producción es un
diseño donde el peor resultado es alcanzable por el error más decidido.

La lista de hosts ya incluye `uellix-antigravity.vercel.app` —hallada por la
revisión adversarial del Train 5A en `lib/site.ts:26`—, `app.uellix.com` y
`uellix.com`. La lista de **project refs está vacía** y llenarla es requisito de
aprovisionamiento: una lista vacía retira un **veto**, nunca una puerta.

### 5.2 Registro sin secretos

`redactForHostedLog` elimina por **forma**, no por lista de nombres conocidos:
cualquier URL completa, cualquier JWT (incluido truncado) y cualquier clave
`sb*_`. El project ref **se conserva** a propósito: es público en toda URL que el
proyecto sirve y es lo más útil para diagnosticar un destino equivocado.

## 6. R6h

Sin cambios de contrato. `stella_interactions_governed_identity_check` sigue
`NOT VALID` en el artefacto generado, y la autoverificación de `stella_0017` sigue
**abortando si la encuentra VALIDADA**. Ningún artefacto de la cadena emite
`VALIDATE CONSTRAINT` — el gate `r6h-audit-ready` lo comprueba sobre los diez.

Una validación futura exigirá un **paquete aditivo que supersede la expectativa
de `stella_0017`**, no una edición de `stella_0017` ni un `ALTER TABLE` suelto.
Registrado, no ejecutado.

## 7. Qué sigue sin resolverse offline

| Asunto | Por qué no se cierra aquí |
|---|---|
| **RR-09 / acceso a `auth`** | Si el dueño de los helpers RLS puede alcanzar `auth.uid()` en un proyecto gestionado real sólo se mide allí. El bootstrap **se niega** si no puede: es una respuesta fail-closed, no una verificada |
| **PostgreSQL ≥ 17** | El proyecto de staging debe crearse en 17+. Comprobable en CHECKPOINT A |
| **RR-03** | El `pg_default_acl` de `supabase_admin` sigue sin ser corregible desde hosted. No lo toca este train |
| **RR-02** | No cerrable. Documentado, emitido como NOTICE y registrado en el centinela |
| **Aislamiento de staging** | Sigue sin existir el proyecto. B2 del registro de riesgos sigue abierto |
| **Rotación de clave de proveedor** | B3 sigue abierto |

## 7b. Revisión adversarial (Fase 16)

Dos revisores independientes de sólo lectura. **A (Fable)** encontró 1 BLOCKER,
2 MAJOR y 7 MINOR; **B (Sonnet)** encontró 0 BLOCKER, 0 MAJOR, 1 MINOR y 1 NIT.
Los tres hallazgos serios de A eran reales —los verifiqué contra el código antes
de aceptarlos— y **habrían detenido el aprovisionamiento a mitad de camino, con
staging medio construido**, porque la suite es estructural y no ejecuta
PostgreSQL.

| # | Sev. | Hallazgo | Corrección |
|---|---|---|---|
| A-1 | **BLOCKER** | La postcondición del shim comprobaba sólo `proconfig @> ARRAY['search_path=']`. PostgreSQL almacena `SET search_path = ''` como `search_path=""`, así que el predicado era siempre verdadero y el `RAISE` disparaba **en cada aplicación**: el bootstrap era inaplicable. `grounding_0002:1087-1093` registra el mismo defecto como ya medido en este repo | Se comprueban **ambas** grafías. Añadido a las sondas del gate `hosted-capability-preflight-ready`, con control negativo |
| A-2 | **MAJOR** | Siete de los nueve paquetes hacen `SET ROLE uellix_owner`, y en PG16+ un CREATEROLE no superusuario recibe `ADMIN OPTION` **sin `set_option`** al crear un rol. El instalador no podía convertirse en owner: la cadena se detenía en el primer paquete. Además la aserción C2 pedía `MEMBER`, que no implica ese derecho | §2b nueva: el grant `SET` se emite **deliberadamente y una sola vez**, en un paquete revisado, en vez de aparecer como paso manual no documentado. C2 pasa a exigir `'SET'` |
| A-3 | **MAJOR** | La barrida exhaustiva de `stella_0017` §5(1b) excluye superusuarios, `uellix_owner` y `uellix_cap_stella_quota`. En hosted el dueño del ledger es `postgres` —no superusuario, no excluido— así que la aserción disparaba y `stella_0017` abortaba, dejando staging **parcialmente aplicado** con R6a/R6b abiertos | §2c nueva: transferencia **estrecha** del ownership de `public.stella_interactions` a `uellix_owner`. Estrecha a propósito: es la transferencia amplia la que RR-09 bloquea, y una tabla no tiene esa dependencia |
| A-4 | MINOR | E5b comprobaba que el dueño de los helpers RLS alcanza `auth.uid()`, pero el shim lo crea —y por tanto lo posee— `current_user`, que puede ser otro rol | E5c nueva sobre `current_user` |
| A-5 | MINOR | El redactor no cubría el formato vigente de claves Supabase (`sb_secret_…`) ni un DSN libpq `password=…`, y eco-citaba verbatim el valor del operador | Patrones añadidos; el eco pasa por `echoOperatorValue`, que además **trunca** |
| A-6 | MINOR | Las sondas de supersesión fallaban **abiertas**: una clave ausente contaba como «no instalado» | `HOSTED_PROBE_MISSING`, salvo primera provisión (donde «nada instalado» es un hecho, no un supuesto) |
| A-7 | MINOR | El rollback del bootstrap no estaba anclado por ningún SHA | Pin añadido en la suite del manifiesto |
| B-1 | MINOR | La regla 4 excluía **la línea entera** si contenía una comilla, así que `RAISE NOTICE 'actor=%', auth.uid();` habría quedado sin reescribir en silencio — **y el test de sobrantes reimplementaba la misma heurística**, compartiendo el punto ciego | La exclusión pasa a ser **por ocurrencia**, por paridad de comillas; el test usa ahora un escáner propio que despoja comentarios y literales — método distinto, misma pregunta |
| A-8 / B-2 | NIT | La lista de sondas del rollback omitía `stella_0017` y `grounding_0003` | Añadidas |

**No corregidos, y por qué:** la postcondición del cuerpo del shim compara por
substring y sólo corre al (re)aplicar (A: evadible por un `CREATE OR REPLACE`
fuera de banda). Sólo el instalador —que ya es omnipotente sobre este esquema—
puede hacer esa edición, así que es evidencia-de-manipulación, no barrera; la
afirmación de §4.2 se lee ahora con esa reserva. Y el veto de producción es hoy
vacuo para destinos de BD hasta que el aprovisionamiento llene `projectRefs`,
que es exactamente lo que §6 de REQUIREMENTS pide.

## 8. Comandos

```bash
pnpm hosted:generate
```

```bash
pnpm hosted:verify
```

`hosted:verify` regenera en memoria y compara byte a byte contra
`db/prepared/hosted/`. Falla también ante un artefacto **huérfano**: un archivo
que nadie genera es un archivo que nadie regenera, y por tanto el que en silencio
se convierte en la segunda fuente de verdad.

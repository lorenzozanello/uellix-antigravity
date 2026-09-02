# Baseline de capacidades — línea base pre-CAP-01…CAP-05

Este directorio contiene el estado del esquema **anterior** a la campaña de
capacidades, versionado y verificable por hash. Es la entrada de
`scripts/capability-dry-run.sh` y de `scripts/capability-baseline-verify.sh`.

**No es un backup.** No contiene una sola fila de ninguna tabla. No sirve para
restaurar datos y no debe usarse como base de producción.

## Por qué existe

Hasta el 2026-08-04 el dry-run empezaba así:

```
docker exec supabase_db_uellix-stella-g2-local-rehearsal pg_dumpall --roles-only …
docker exec supabase_db_uellix-stella-g2-local-rehearsal pg_dump    --schema-only …
```

El resultado iba a un `mktemp -d` que el `trap … EXIT` borraba al terminar. El
baseline era, literalmente, un efecto secundario de la ejecución: nunca se
commiteó, nunca se hasheó, y sólo existía mientras ese contenedor concreto
estuviera vivo. Cuando el stack persistente se detuvo —el 2026-08-04, de forma
deliberada— la unidad `CAPABILITY_PARSER_FAIL_CLOSED_HARDENING` se bloqueó con
`CAPABILITY_PARSER_FAIL_CLOSED_BLOCKED_BASELINE_ARTIFACT`, porque no existía
ninguna forma reproducible de obtener 38/107/10.

Además la línea base tampoco era reconstruible desde las migraciones: hay tablas
gestionadas fuera de Drizzle (ADR 21) que `pnpm db:migrate:local` no reproduce
sobre una base limpia. Ver [`../prepared/README.md`](../prepared/README.md).

## Procedencia

| Campo | Valor |
|---|---|
| Fecha de extracción | 2026-08-04 |
| Rama | `codex/stella-g2-local-rehearsal` |
| Commit | `a0b3b315edf56de67ad8e493eb7fe4ee61ff3158` |
| Origen | volumen Docker `supabase_db_uellix-stella-g2-local-rehearsal` |
| PostgreSQL de origen | 17.6 (`PG_VERSION` = 17) |
| Imagen | `public.ecr.aws/supabase/postgres:17.6.1.143` |
| Image ID | `sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453` |

### Cómo se obtuvo, y qué NO se hizo

El stack persistente **nunca se inició**. La secuencia fue:

1. El volumen original se montó **`:ro`** en un contenedor auxiliar. Sólo para
   leer `PG_VERSION` y la estructura de directorios.
2. Se copió con `cp -a` (preserva propietario, grupo, modo, enlaces y
   *timestamps*) a un volumen temporal independiente. Verificado: 2127 archivos,
   29 directorios, 2156 entradas, estructura idéntica, `uid=100 gid=101 mode=700`
   en la raíz.
3. PostgreSQL se arrancó **sólo sobre la copia**, con `--network none` y sin
   publicar puertos. La recuperación de crash, el WAL y los checkpoints
   escribieron en la copia; el volumen original no recibió una sola escritura.
4. `pg_dump --schema-only` y `pg_dumpall --roles-only --no-role-passwords`
   contra esa copia.
5. Contenedores y volumen temporal destruidos. El volumen original sigue
   existiendo, detenido y sin contenedores conectados.

En ningún momento se ejecutó `supabase start`, `supabase db reset`, una
migración, un seed ni un paquete de capacidad sobre el volumen original, ni se
accedió a ningún destino remoto.

## Archivos

| Archivo | Qué es |
|---|---|
| `stella_g2_roles.sql` | `pg_dumpall --roles-only --no-role-passwords`: 21 roles, sus atributos, sus `ALTER ROLE … SET`, sus comentarios y sus membresías. Sin contraseñas ni hashes. |
| `stella_g2_schema.sql` | `pg_dump --schema-only` de la base `postgres`: 13 esquemas, 38 tablas en `public`, 110 policies (107 en `public`), 17 triggers (10 de usuario en `public`), funciones, secuencias, constraints, índices, extensiones y ownership. Sin datos. |
| `stella_g2_post_restore.sql` | Lo que `pg_dump` **no** emite: el propietario de `public` y `GRANT USAGE ON SCHEMA public TO PUBLIC`. Ver abajo. |
| `MANIFEST.sha256` | SHA-256 de los tres. Rutas relativas. |

### Por qué hace falta `stella_g2_post_restore.sql`

`pg_dump` trata `public` como preexistente: no lo crea, no fija su propietario y
no emite la entrada de ACL correspondiente a PUBLIC. Sí emite los `GRANT` a
roles nombrados. Faltan exactamente dos cosas, y la segunda no es cosmética:

```
ALTER SCHEMA public OWNER TO pg_database_owner;
GRANT USAGE ON SCHEMA public TO PUBLIC;   -- la entrada `=U/pg_database_owner`
```

Eso es **RR-CAP-7**. Todos los roles de capacidad heredan `USAGE` sobre `public`
de esa concesión a PUBLIC; sin ella los `SECURITY DEFINER` no pueden ni nombrar
`public.users`, cada llamada falla con 42501 y el ensayo acaba midiendo el
sembrado en lugar de los paquetes. Antes se parcheaba a mano, en línea y sin
versionar, dentro del propio dry-run. Ahora está versionado, hasheado y afirmado
por `tests/capability-baseline-artifact.test.ts`.

## Orden de restauración

Estrictamente:

1. `stella_g2_roles.sql` — a nivel de clúster.
2. `stella_g2_schema.sql` — sobre una base **vacía**.
3. `stella_g2_post_restore.sql` — sobre la misma base.

Los tres se aplican con `ON_ERROR_STOP=1` y **sin** `|| true`. Los `NOTICE` sobre
membresías ya concedidas no son errores y no abortan.

### Dos detalles de entorno que no son opcionales

**La base destino debe estar vacía.** La imagen de Supabase inicializa
`postgres` con sus propios esquemas (`auth`, `storage`, `realtime`, `graphql`,
`vault`, `extensions`); restaurar encima choca en cada `CREATE SCHEMA`. Ambos
scripts recrean `postgres` desde `template0` antes de restaurar. Ése era el
motivo real del `|| true` que ocultaba fallos de sembrado.

**Hay que reapuntar dos background workers antes de recrear esa base:**

```
postgres -D /etc/postgresql -c cron.database_name=template1 -c pg_net.database_name=template1
```

`pg_cron` y `pg_net` tienen `postgres` fijada por configuración. Al soltarla, el
lanzador de pg_cron sale con código 1 y el worker de pg_net **segfaulta**
(`terminated by signal 11`). El postmaster trata la muerte anómala de cualquier
worker como posible corrupción de memoria compartida y reinicia el clúster
entero: el restore muere a mitad, en un DDL arbitrario y sin relación con la
causa. `-D /etc/postgresql` tampoco es opcional — es el `Cmd` por defecto de la
imagen y lleva `shared_preload_libraries`; pasar argumentos propios reemplaza el
`Cmd` entero, y sin él falla `CREATE EXTENSION pg_net`.

## Conteos esperados tras restaurar

| Propiedad | Valor |
|---|---|
| PostgreSQL | 17.6 |
| Tablas en `public` | **38** |
| Policies en `public` | **107** |
| Triggers de usuario en `public` | **10** |
| Propietario de las tablas | `uellix_owner` |
| Propietario de `public` | `pg_database_owner` |
| ACL de `public` | incluye `=U/pg_database_owner` |
| Roles `uellix_*` | 5 |
| Roles de capacidad (`uellix_cap*`, `uellix_stripe`) | 0 |
| Policies `cap_*` | 0 |
| Esquema `uellix_capability` | ausente |
| `evidence_chunks` | ausente |
| `stella_suggestion_decisions` | presente |
| Filas en `public` | 0 |

Aplicando encima `stella_0006`…`stella_0010` el estado converge a **42 tablas /
141 policies / 6 roles / 8 funciones / 1 esquema**.

## Cómo verificarlo

```bash
bash scripts/capability-baseline-verify.sh
```

Levanta un contenedor desechable con `--network none`, comprueba el manifiesto,
restaura los tres artefactos de forma fail-closed y afirma la tabla de arriba.
Destruye el contenedor pase o falle. No toca ningún stack.

El ensayo completo —forward, convergencia, 72 aserciones vivas, concurrencia,
rollback y reaplicación— es:

```bash
bash scripts/capability-dry-run.sh
```

## Normalizaciones aplicadas

Sólo elementos **no semánticos** que impedían un hash estable, más una guarda de
existencia. No se alteró DDL, orden, ownership, ACL, policies, funciones,
`search_path`, extensiones, triggers, constraints ni índices.

| ID | Qué | Por qué |
|---|---|---|
| N-1 | `\restrict`/`\unrestrict` con clave fija `uellix_baseline_g2` | psql 17.6 emite un **nonce aleatorio en cada ejecución**. Sin fijarlo, cada regeneración cambiaría el hash sin cambiar una línea de DDL. Se fija la clave en lugar de borrar la directiva para conservar la protección contra inyección de meta-comandos. |
| N-2 | Las 21 sentencias `CREATE ROLE` envueltas en `IF NOT EXISTS` | 14 de los 21 roles ya existen en cualquier clúster Supabase de fábrica. Sin la guarda, un restore fail-closed muere en el primer `role "anon" already exists`. Los `ALTER ROLE` posteriores se mantienen literales, así que el estado final es idéntico se creara el rol o ya estuviera. |
| N-3 | Final de línea LF fijado en `.gitattributes` | El repositorio tiene `core.autocrlf=true`; un checkout en Windows reescribiría los artefactos a CRLF y el manifiesto dejaría de cuadrar. |

## Cuándo hay que regenerarlo

Este baseline describe el estado del esquema en `a0b3b31`. Hay que regenerarlo
cuando:

- se aplique al stack de referencia cualquier migración de `db/migrations`,
  `db/policies` o `db/manual-migrations` que cambie estructura;
- se aplique un paquete `db/prepared/stella_000X` **anterior** a 0006;
- cambien los conteos 38 / 107 / 10;
- cambien roles, ownership o la ACL de `public`;
- se suba la versión mayor de PostgreSQL o la imagen de Supabase.

Que `scripts/capability-baseline-verify.sh` siga en verde **no** demuestra que
el baseline esté al día respecto del stack: demuestra que los artefactos son
internamente consistentes. La correspondencia con el stack sólo puede
reestablecerse regenerándolo.

### Cómo regenerarlo

Requiere una lectura del volumen persistente. La regla es que el stack **no se
inicia**: se clona el volumen y se arranca la copia.

```bash
# 1. El original, sólo lectura, a un volumen temporal.
docker volume create uellix_cap_baseline_clone
docker run --rm --network none \
  -v supabase_db_uellix-stella-g2-local-rehearsal:/src:ro \
  -v uellix_cap_baseline_clone:/dst \
  --entrypoint /bin/sh public.ecr.aws/supabase/postgres:17.6.1.143 \
  -c 'cp -a /src/. /dst/'

# 2. PostgreSQL SÓLO sobre la copia, aislado.
docker run -d --name uellix_cap_baseline_src --network none \
  -v uellix_cap_baseline_clone:/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=dryrun -e POSTGRES_HOST_AUTH_METHOD=trust \
  public.ecr.aws/supabase/postgres:17.6.1.143

# 3. Los dos volcados.
docker exec uellix_cap_baseline_src pg_dump -U postgres --dbname=postgres --schema-only -f /tmp/schema.sql
docker exec uellix_cap_baseline_src pg_dumpall -U postgres --roles-only --no-role-passwords -f /tmp/roles.sql

# 4. Sacarlos, aplicar N-1 y N-2, regenerar el manifiesto:
#    cd db/baseline && sha256sum stella_g2_roles.sql stella_g2_schema.sql \
#      stella_g2_post_restore.sql > MANIFEST.sha256
# 5. Destruir contenedor y volumen temporal, y verificar:
#    bash scripts/capability-baseline-verify.sh
```

Después de regenerar hay que revisar el barrido de secretos: los artefactos no
pueden contener `COPY`, `INSERT` fuera de cuerpos de función, emails, JWT,
claves ni connection strings. `tests/capability-baseline-artifact.test.ts` lo
comprueba.

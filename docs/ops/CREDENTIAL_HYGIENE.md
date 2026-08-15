# Higiene de credenciales

**Estado:** vigente desde 2026-08-15.
**Alcance:** todo material de autenticación que pueda llegar a un archivo de este
repositorio — DSNs de PostgreSQL, claves de API, claves de servicio de Supabase,
JWTs, claves privadas — en código, documentación, tests, scripts y fixtures.
**Módulos:** `scripts/scan-secrets.ts`, `tests/scan-secrets.test.ts`, el paso
«Scan for credentials» de `.github/workflows/ci.yml`.
**Fuente relacionada:** [`DATABASE_TARGET_SAFETY.md`](DATABASE_TARGET_SAFETY.md)
(qué destino es legítimo), [`AUDIT_2026-07-06.md`](../AUDIT_2026-07-06.md)
(el hallazgo original y su registro de remediación).

---

## 1. La regla

**Ninguna credencial real entra en el repositorio.** Ni en un `.env` commiteado,
ni citada dentro de un informe de auditoría, ni pegada en un runbook «sólo para
que el próximo operador la tenga a mano».

Esto no es una precaución teórica. Es la lección de un incidente concreto,
descrito en §4.

## 2. Qué es secreto y qué no

La mitad de los errores en esta materia son de *sobre*-redacción: se tacha un
identificador público, el documento pierde su valor de auditoría, y el lector
siguiente no puede saber a qué apuntaba la credencial.

| No es secreto | Por qué |
| --- | --- |
| El project ref de Supabase (`ctaxtgujyyprgynmnvtq`, `bvyzblhqymxruxdguaee`) | Aparece en toda URL que el proyecto sirve. `redactForHostedLog` lo **preserva a propósito**: es lo más útil que un operador puede ver al diagnosticar un destino equivocado. |
| El host (`db.<ref>.supabase.co`, `aws-1-us-east-2.pooler.supabase.com`) | Derivable del ref, y necesario para saber qué entorno es. |
| El usuario (`postgres`, `uellix_app`, `uellix_migrator`) | El modelo de roles es público y está documentado. |
| Las publishable / anon keys (`sb_publishable_…`, `sbp_…` en su forma pública) | Diseñadas para viajar al navegador. |

| Sí es secreto | Acción |
| --- | --- |
| La contraseña de un DSN | Rotar y redactar. |
| `sb_secret_…`, service-role keys | Rotar y redactar. |
| `GEMINI_API_KEY` / `AIza…` | Rotar y redactar. |
| Cualquier JWT firmado, cualquier clave privada | Rotar y redactar. |

La redacción correcta conserva la estructura y elimina sólo el valor:

```
postgres://postgres:[REDACTED — credential rotated 2026-08-15 after repository exposure]@db.ctaxtgujyyprgynmnvtq.supabase.co
```

## 3. El gate

```bash
pnpm secrets:scan
```

Corre en CI **antes que lint, typecheck y test**, y lee el árbol de trabajo, de
modo que detecta una credencial sin importar qué commit la introdujo.

Dos propiedades importan más que la cobertura:

1. **Nunca imprime un secreto.** Un scanner que muestra la línea infractora
   «para que el fallo sea accionable» copia el secreto a los logs de CI, al
   check del PR y al scrollback de la terminal: difunde justo aquello que fue
   contratado para contener. Éste imprime archivo, línea, tipo, un prefijo
   SHA-256 de 12 caracteres y la forma (longitud y clases de caracteres). El
   prefijo basta para demostrar «este valor es el mismo que aquél» y es
   insuficiente para reconstruirlo.
2. **Analiza estructura, no subcadenas.** Un `grep -E "127.0.0.1|localhost"`
   acepta `localhost.attacker.example` — la clase de bug que
   [`ci-assert-local-targets.ts`](../../scripts/ci-assert-local-targets.ts) fue
   escrito para eliminar. El DSN se parte en usuario, contraseña y host, y el
   veredicto se toma sobre el host ya parseado.

### Fixtures

Este repositorio contiene DSNs a propósito: las suites de `db/safety/` le dan de
comer destinos hostiles. Un gate incapaz de distinguir `db.x.supabase.co` de
`db.ctaxtgujyyprgynmnvtq.supabase.co` es un gate que se apaga en una semana.

Un fixture se reconoce **por su host**, mediante reglas que un destino real no
puede satisfacer por accidente:

- loopback (`127.0.0.1`, `localhost`, `::1`);
- nombres reservados por RFC 2606 / 6761 (`*.example.com`, `*.test`, `*.invalid`);
- una plantilla sin expandir (`${LOCAL_DB_PORT}`);
- un ref listado en `SYNTHETIC_SUPABASE_REFS`;
- una etiqueta única sin punto (`h`), típica de los tests de formateo de errores.

**Un host no reconocido es un hallazgo, no un aprobado.** El host del 6 de julio
tampoco era reconocido por nada del repositorio en aquel momento; un gate que
falle abierto ante lo desconocido no habría dicho nada.

Para el literal que es fixture pero cuya forma no lo delata —una clave falsa que
se le pasa al redactor, donde no hay host sobre el que razonar— existe una
anotación en línea, **con motivo obligatorio**:

```ts
// secret-scan-ok: synthetic key, this suite feeds it to the redactor on purpose
const secret = 'sb_secret_…'
```

Cubre la línea en que está y la inmediatamente siguiente, y nada más. El motivo
es obligatorio porque un marcador desnudo se añade con la misma ligereza con que
se lee por encima: obligar a escribir la frase es la única parte de esto con la
que un revisor puede realmente estar en desacuerdo.

### El guardián del guardián

Una allowlist está siempre a una edición descuidada de nombrar algo real, y
falla en silencio: añadir las veinte letras equivocadas volvería invisible la
próxima fuga del ref de Producción. Por eso `assertAllowlistIsSynthetic()` se
ejecuta en cada corrida y **aborta el scan** si algún elemento de
`SYNTHETIC_SUPABASE_REFS` colisiona con `KNOWN_PRODUCTION_IDENTIFIERS` o con
`KNOWN_STAGING_PROJECT_REF`, o si `isSyntheticHost()` llegara a aceptar un host
de producción conocido.

## 4. El incidente de 2026-08-15

**Qué pasó.** El informe de auditoría commiteado en `782ac5f` (2026-07-06) citaba
el contenido de `.env` textualmente, con lo que la contraseña PostgreSQL del rol
`postgres` del proyecto de Producción quedó dentro del repositorio. `a0fdfcd`
redactó la clave de Gemini del mismo documento pero **no** el DSN. La contraseña
permaneció seis semanas, presente en 595 de los 787 commits. Nada en el
repositorio estaba vigilando, así que nada objetó.

**Disposición.**

| Paso | Estado |
| --- | --- |
| Contraseña rotada en Supabase por el operador | Hecho, 2026-08-15 |
| `DATABASE_URL` actualizada en Vercel (Production + Preview), mismo Session Pooler | Hecho, 2026-08-15 |
| Redeploy de Production sobre el mismo commit `dd36a4e`, sin cambios de código | Hecho, `dpl_6oZzoHCyFWjofS7TApDmHefAcv8i`, READY |
| Smoke posterior: login, dashboard, proyectos, apertura de proyecto | PASS; 0 errores de runtime |
| Redacción del árbol (`docs/AUDIT_2026-07-06.md:89`) | Hecho, este commit |
| Gate de regresión (`pnpm secrets:scan` en CI) | Hecho, este commit |
| Reescritura de la historia de Git | **No realizada** — véase §5 |

**No se conserva ni se reconstruye el valor anterior.** Deliberadamente no se
ejecutó una prueba de autenticación negativa contra la contraseña vieja: hacerlo
exigiría volver a manipular el secreto, y el reset en Supabase ya acredita la
revocación. Se acepta la asimetría: la revocación está atestiguada por el
operador, no medida por este repositorio.

## 5. Decisión sobre la historia de Git

El literal sigue presente en los dos blobs históricos de
`docs/AUDIT_2026-07-06.md`. Se evaluaron las dos opciones.

### Opción A — redacción forward-only (**adoptada**)

Redactar el árbol actual, dejar la historia intacta, documentar la condición.

### Opción B — reescritura de la historia (`git filter-repo` / BFG)

Reescribir los 595 commits que contienen el documento.

### Por qué A

1. **La credencial ya está revocada.** Una reescritura no reduce riesgo residual
   sobre un valor que ya no autentica; sólo dificulta leer el registro de que
   alguna vez existió. El riesgo se cerró con la rotación, no con el borrado.
2. **Reescribir huerfanaría el commit que Producción está corriendo.** `dd36a4e`
   —el SHA desplegado en `dpl_6oZzoHCyFWjofS7TApDmHefAcv8i`, con los alias
   `uellix.com` y `www.uellix.com`— desciende de `782ac5f` y contiene el blob.
   Tras un rewrite ese SHA deja de existir en el repositorio, y se rompe el
   vínculo entre «qué está desplegado» y «qué hay en el repositorio». Éste es el
   argumento decisivo: convierte la reescritura en un riesgo *operativo*, no
   sólo contable.
3. **Invalidaría los anclajes de la evidencia gobernada.** La cadena T1–T10 y sus
   certificaciones anclan en SHAs concretos; varias exigen leer el `GIT_DIR` del
   snapshot. Runbooks, registros de auditoría y el registro de decisiones citan
   `8a17ae1`, `9cc5abf`, `a790906`, `5ab5f51`. Reescribir convierte seis semanas
   de evidencia en referencias colgantes — el daño exacto que la cadena existe
   para impedir.
4. **El coste de coordinación es real:** 65 ramas locales, todas necesitando
   force-push, más cualquier clon o worktree existente. Este árbol de trabajo es
   además un worktree enlazado de `uellix-antigravity`: comparten almacén de
   objetos, así que una reescritura los afecta a los dos a la vez.

### Premisa no verificada, y qué la cambiaría

Esta decisión supone que **`github.com/lorenzozanello/uellix-antigravity` es
privado**. No se comprobó desde aquí: el cierre del incidente se ejecutó sin
acceso remoto por diseño. Confírmelo el operador.

**Si el repositorio es —o alguna vez fue— público, revalúese la Opción B.** La
credencial seguiría revocada, así que la urgencia sería baja, pero la exposición
histórica pasa a ser indefinida (forks, mirrors, cachés de terceros) y el
borrado adquiere un valor que aquí no tiene. En ese caso la reescritura debe
planificarse como un ejercicio con nombre propio, con re-anclaje explícito de la
cadena de evidencia y un redeploy de Producción sobre un SHA nuevo — nunca como
un `filter-repo` a la carrera.

**Otros disparadores para revisar:** un requisito de auditoría externa que exija
ausencia histórica; o un hallazgo de que el valor filtrado se reutilizó en algún
otro sistema, en cuyo caso el problema no es este repositorio.

## 6. Si encuentra una credencial

1. **No la pegue en ningún sitio.** Ni en un issue, ni en un chat, ni en el
   mensaje del commit que la arregla.
2. **Rote primero, redacte después.** Redactar antes de rotar deja la credencial
   viva en la historia y elimina la única pista de qué había que rotar.
3. **Redacte conservando la estructura**, según §2.
4. **Registre la disposición** — qué se rotó, cuándo, quién — en el documento
   afectado y en esta página.
5. **Añada el caso al gate** si el scanner no lo detectó, con un test en
   `tests/scan-secrets.test.ts` que falle antes de la corrección.

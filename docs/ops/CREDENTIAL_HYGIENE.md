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
| Un personal access token `sbp_…` | Rotar y redactar. |
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
   escrito para eliminar. El DSN se parte en usuario, contraseña y host, y cada
   componente se juzga por lo que es.

### Qué decide y qué sólo describe

La primera versión de este gate decidía **por el host**: un DSN apuntando a
`db.x.supabase.co` pasaba con la contraseña que fuera. La revisión independiente
del 2026-08-15 lo cerró, porque tenía la polaridad invertida — dejaba que la
mitad **pública** de una credencial avalara la mitad **secreta**. Sanear el
hostname de un DSN filtrado conservando la contraseña es una edición de una
línea que ningún revisor cuestionaría, y ese gate la habría aplaudido. Se
midieron 18 sitios del árbol que vivían de esa exención.

Hoy **el veredicto lo toma el componente credencial**. Una contraseña, un token
o una clave se ignoran sólo cuando:

- **(a)** el valor se delata a sí mismo como fixture — `[YOUR-PASSWORD]`, una
  plantilla sin expandir `${...}`, o un cuerpo que lleva un marcador como
  `not-a-real`, `placeholder`, `example`, `fake`, `synthetic`, `dummy`; o
- **(b)** la línea lleva una anotación `secret-scan-ok: <motivo>` explícita.

El host se sigue parseando y `isSyntheticHost()` sigue existiendo, pero **sólo
para etiquetar** el hallazgo (`host cannot resolve`) y acelerar el triaje. Nunca
para excusarlo. Un host no reconocido tampoco es un aprobado: el host del 6 de
julio no era reconocido por nada del repositorio en aquel momento.

La diferencia práctica, para quien escribe un fixture: **cambie la credencial,
no el hostname.**

```ts
// SE REPORTA — la contraseña tiene aspecto de credencial emitida, aunque el
// host sea loopback y no pueda resolver.
'postgresql://uellix_app:<16 caracteres de alta entropía>@127.0.0.1:54322/postgres'

// NO SE REPORTA — la credencial se delata a sí misma, aunque el host sea el de
// Producción.
'postgresql://uellix_app:not-a-real-password@db.ctaxtgujyyprgynmnvtq.supabase.co:5432/postgres'
```

El valor de la primera línea va descrito y no escrito **a propósito**: esta
página está sujeta a su propia regla, y la primera redacción de este ejemplo
llevaba dieciséis caracteres de alta entropía de verdad. El gate la rechazó en
la suite antes de que llegara a existir un commit. Es la demostración más
barata de que la regla nueva funciona: atrapó a su propio autor.

Para el literal que es fixture pero **no puede** decirlo en su propio cuerpo
—un token cuyos bytes exactos son justo lo que la aserción comprueba— queda la
anotación en línea, **con motivo obligatorio**:

```ts
// secret-scan-ok: synthetic key, this suite feeds it to the redactor on purpose
const secret = 'sb_secret_…'
```

Cubre la línea en que está y la inmediatamente siguiente, y nada más. El motivo
es obligatorio porque un marcador desnudo se añade con la misma ligereza con que
se lee por encima: obligar a escribir la frase es la única parte de esto con la
que un revisor puede realmente estar en desacuerdo.

**Ya no hay exenciones por archivo.** `scripts/scan-secrets.ts` y
`tests/scan-secrets.test.ts` estaban exentos y dejaron de estarlo: un interruptor
que cubre un archivo entero es exactamente lo que la anotación existe para
evitar, y eximir la suite del propio gate es cómo un gate deja de notar que sus
fixtures derivaron hacia formas reales. Sólo queda fuera `pnpm-lock.yaml`, cuyos
hashes de integridad son cadenas base64 sobre las que ningún detector debería
razonar.

### Lo que este gate sigue sin ver

Un gate que no publica sus límites se lee como si no tuviera ninguno. Estos
están medidos y siguen abiertos:

- **Asignación desnuda.** `POSTGRES_PASSWORD=<valor>` sin DSN alrededor no
  coincide con ningún detector. Es, además, la forma exacta del incidente de
  julio (`.env` citado textualmente), y sólo se atrapó allí porque la línea
  citada era un DSN completo.
- **Un byte NUL exime el archivo entero.** `scanText` descarta cualquier blob
  que contenga un NUL para no ahogarse en binarios.
- **Un DSN partido en dos líneas** no se reensambla: el barrido es por línea.

Ninguna es una regresión de esta iteración; las tres preceden al gate y se
registran aquí para que la próxima revisión empiece donde ésta terminó.

### El guardián del guardián

Una allowlist está siempre a una edición descuidada de nombrar algo real, y
falla en silencio. `assertAllowlistIsSynthetic()` se ejecuta en cada corrida y
**aborta el scan** si algún elemento de `SYNTHETIC_SUPABASE_REFS` colisiona con
`KNOWN_PRODUCTION_IDENTIFIERS` o con `KNOWN_STAGING_PROJECT_REF`, o si
`isSyntheticHost()` llegara a aceptar un host de producción conocido.

Pesa menos que antes —la allowlist ya no excusa nada— pero se conserva, y se
conserva fatal, por dos razones: un hallazgo etiquetado «este host no resuelve»
mientras apunta a Producción desorientaría el triaje que la etiqueta existe para
acelerar; y si una edición futura vuelve a conectar el hostname al veredicto, el
cable trampa ya está puesto.

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

### La premisa era falsa: el repositorio es PÚBLICO

La primera redacción de esta sección suponía que
`github.com/lorenzozanello/uellix-antigravity` era privado, no lo comprobó, y
dejó escrito que si alguna vez fuera público debía revaluarse la Opción B.

**Ese disparador se activó.** El operador confirmó el 2026-08-15 que la
visibilidad del repositorio es **PÚBLICA**, y lo ha sido durante la ventana de
exposición. La revaluación exigida por la propia condición **se ejecutó**, y su
resultado se registra aquí.

**`HISTORY_REWRITE_RECOMMENDED` sigue siendo `false`.** Lo que cambia no es la
decisión, sino la clasificación de la exposición:

1. **Hay que presumir la credencial cosechada.** En un repositorio público, un
   secreto presente seis semanas y en 595 commits debe darse por recolectado por
   crawlers y mirrors de terceros. No se afirma que ocurriera; se asume que pudo
   ocurrir, que es la única postura defendible sin telemetría del atacante.
2. **La contención efectiva fue la rotación, no el borrado.** El valor está
   revocado desde el 2026-08-15. Una reescritura no recupera confidencialidad ya
   perdida; sobre un secreto que ya no autentica, su beneficio incremental de
   seguridad es esencialmente nulo.
3. **Una reescritura no puede limpiar clones, forks ni cachés de terceros.** No
   automáticamente y, en el caso de las referencias cacheadas de GitHub, no sin
   abrir un ticket de soporte. El borrado sería parcial por construcción,
   mientras que el coste sería total.
4. **El SHA que Producción está corriendo está dentro del radio de la
   reescritura.** `dd36a4e` desciende de `782ac5f` y contiene el blob; tras un
   rewrite dejaría de existir, rompiendo el vínculo entre «qué está desplegado» y
   «qué hay en el repositorio». Esto sigue siendo el argumento decisivo, y es
   operativo, no contable.
5. **Los anclajes de la evidencia gobernada siguen intactos por diseño.** La
   cadena T1–T10 y sus certificaciones anclan SHAs concretos y varias releen el
   `GIT_DIR` del snapshot.

**Clasificación resultante:**

| Dimensión | Estado |
| --- | --- |
| Incidente de acceso con credencial | CERRADO (rotación + redeploy + smoke) |
| Árbol actual del repositorio | LIMPIO, verificado por `pnpm secrets:scan` |
| Presencia histórica del literal | **ACCEPTED_RESIDUAL_RISK**, documentada aquí |
| Visibilidad del repositorio | PÚBLICA |
| Reescritura de la historia | NO recomendada, NO realizada |

**Qué haría revisar esto de nuevo:** que se descubra que el valor filtrado se
reutilizó en algún otro sistema —en cuyo caso el problema no es este
repositorio, y lo urgente es ese otro sistema—; o un requisito de auditoría
externa que exija ausencia histórica demostrable. En ese caso la reescritura
debe planificarse como un ejercicio con nombre propio, con re-anclaje explícito
de la cadena de evidencia y un redeploy de Producción sobre un SHA nuevo — nunca
como un `filter-repo` a la carrera.

**Higiene pendiente, no bloqueante:** las ramas publicadas cuyo *árbol actual*
—no sólo su historia— aún contiene el literal pre-redacción sanan al rebasar,
mergear o podar contra este commit. Es limpieza, no contención: la contención ya
la hizo la rotación.

## 6. GH013: el rechazo de GitHub Push Protection (2026-08-15)

**Qué pasó.** El push de `codex/stella-staging` fue rechazado con
`GH013 / GITHUB PUSH PROTECTION`. **Ninguna referencia remota se actualizó.**
GitHub clasificó varios literales de `tests/hosted/target-identity.test.ts` como
*Supabase Personal Access Token*, y los detectó tanto en el tip como en commits
históricos (`7ae6a5e`, `7e1730a`).

**Qué demostró.** Que un control remoto atrapó una clase que el gate local no
tenía. Eso es la polaridad equivocada para un gate cuyo trabajo es fallar
*antes* del push: la primera noticia de un token con forma real no puede llegar
del servidor.

**Auditoría de los literales señalados** — sin reproducir ninguno:

| Huella (SHA-256:12) | Sitios | Forma | Veredicto |
| --- | --- | --- | --- |
| `8246ef07a213` | `tests/hosted/target-identity.test.ts`, 8 blobs históricos | `sbp_` + 40 hex | **Sintético.** Su cuerpo es la secuencia hex ascendente `0123456789abcdef` repetida; entropía 3,97 b/carácter. Ningún emisor produce eso. |
| `2f54b13e0163` | `tests/hosted/checkpoint-b0.test.ts`, 1 blob | `sbp_` + 32 hex | **Sintético**, misma construcción. |

Un barrido independiente sobre **todos** los blobs de la historia no encontró
ningún otro literal con prefijo `sbp_`. **Ninguno es una credencial viva**, y
ninguno fue emitido jamás por Supabase. Ambos estaban en el árbol actual además
de en la historia.

**Qué se hizo.**

1. Se añadió el detector `SUPABASE_PERSONAL_ACCESS_TOKEN` al gate local, con un
   umbral *más* agresivo que el de GitHub —20 caracteres de token en lugar de
   exactamente 40 hex— para que una copia truncada, recapitalizada o partida por
   separadores siga siendo un hallazgo. Sin exención por directorio: `tests/` no
   está exento, y `tests/hosted/target-identity.test.ts` tampoco.
2. Se retiraron del **tip** los fixtures con forma de PAT, sustituidos por
   valores que se delatan (`sbp_notARealPersonalAccessToken00`), que los
   validadores y el redactor siguen reconociendo como credencial-shaped.
3. La suite del gate construye su fixture con forma de PAT **en tiempo de
   ejecución**, de modo que ningún blob de este repositorio vuelve a contener el
   literal que provocó el rechazo.

**Las detecciones históricas no se resuelven reescribiendo la historia.** Son
material de fixture, sintético y confirmado como tal arriba. La vía prevista es,
en este orden: retirar las formas PAT del tip (hecho); confirmar de forma
independiente que las detecciones históricas son sintéticas (hecho); y sólo si
hiciera falta para desbloquear el push, usar el bypass de Push Protection con el
motivo **«used in tests»**, que es exactamente lo que son. Nunca un rebase
interactivo ni un `filter-repo`, por las razones de §5.

## 7. Si encuentra una credencial

1. **No la pegue en ningún sitio.** Ni en un issue, ni en un chat, ni en el
   mensaje del commit que la arregla.
2. **Rote primero, redacte después.** Redactar antes de rotar deja la credencial
   viva en la historia y elimina la única pista de qué había que rotar.
3. **Redacte conservando la estructura**, según §2.
4. **Registre la disposición** — qué se rotó, cuándo, quién — en el documento
   afectado y en esta página.
5. **Añada el caso al gate** si el scanner no lo detectó, con un test en
   `tests/scan-secrets.test.ts` que falle antes de la corrección.

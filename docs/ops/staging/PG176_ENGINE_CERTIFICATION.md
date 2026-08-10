# Certificación de motor PG 17.6 — cadena Stella gobernada

**Commit 5.** Resultado: **FAIL**. La cadena gobernada `T1..T9` **no** es
aplicable sobre PostgreSQL 17.6 con la topología de roles de Supabase
gestionado, y el motor lo demostró en `T1`.

Este documento registra qué se midió, con qué, y qué decisiones quedan abiertas.
No propone remediaciones: cada hallazgo es una decisión de autoridad, no un
parche.

Reproducir:

```bash
pnpm certify:pg176
```

Artefactos: `artifacts/pg176-certification/latest.json` (certificación) y
`artifacts/pg176-certification/diagnostic.json` (diagnóstico — **no** es
evidencia de certificación).

---

## 1. El entorno, y qué NO prueba

| | |
|---|---|
| Imagen | `public.ecr.aws/supabase/postgres:17.6.1.143` |
| `server_version` | `17.6` |
| `server_version_num` | `170006` |
| `createrole_self_grant` | `''` (vacío) |
| Instalador | `postgres` — `rolsuper = false`, `CREATEROLE`, `CREATEDB`, `BYPASSRLS` |
| Red | `--network none` |
| Montajes | ninguno; todo el SQL entra por `stdin` de `docker exec` |
| Contenedores al terminar | 0 |
| Imágenes snapshot al terminar | 0 |
| Escrituras remotas | **0** |

**Superficie fiel** (no simulada) — es lo que da valor a este entorno frente al
ensayo local existente, que crea el esquema `auth` y por tanto lo posee:

- esquema `auth`, propiedad de `supabase_admin`;
- `auth.users`, propiedad de `supabase_auth_admin`;
- `auth.uid()`, provisto por la imagen;
- `postgres` tiene `USAGE` sobre `auth` **sin** poder crear en él — la asimetría
  exacta de RR-09;
- `supabase_admin` es el único superusuario y **nunca** aplica un paquete.

**Simulado** (declarado, no descubierto después):

- `storage.objects` y `storage.foldername(text)` — los crea el **servicio**
  Storage en un proyecto real, no la imagen. Aquí se crean para `postgres`, así
  que toda pregunta de privilegio sobre ellos se responde trivial y
  erróneamente. Ningún resultado sobre políticas de storage es evidencia.
- El bucket `uellix-evidence` no existe. Ninguna medición depende de él.
- Fila del centinela `uellix_bootstrap.staging_sentinel` — `stella_hosted_0001`
  crea la tabla y deliberadamente **no** inserta la fila («un bootstrap que
  acuñara su propio centinela sería un bootstrap que se certifica a sí mismo»).
  El arnés hace de operador, y **primero mide la negativa**: sin la fila, `T1`
  es rechazado.
- Contraseña de `uellix_migrator` — el paquete lo crea `WITH LOGIN` sin
  credencial, que pertenece al gestor de secretos del operador.

## 2. Preparación

| Fase | Resultado |
|---|---|
| Baseline (50 unidades del manifiesto) | **50/50 aplicadas** |
| `stella_hosted_0001_managed_role_bootstrap` | **PASS** |
| Centinela de staging | escrito, tras medir el rechazo previo |
| PRECHAIN (9 paquetes por testigos de catálogo) | **CLEAN — 9/9 `ABSENT`** |

Hechos de clase C medidos en este motor, no inferidos del manifiesto:

| Hecho | Valor |
|---|---|
| `postgres` puede `CREATE` en `auth` | **no** |
| `postgres` puede `CREATE` en `storage` | **no** |
| `postgres` tiene `TRIGGER` sobre `auth.users` | **sí** |
| propietario de `auth.users` | `supabase_auth_admin` |
| propietario del esquema `auth` | `supabase_admin` |
| `postgres` es superusuario | **no** |

`CREATE TRIGGER` exige el privilegio `TRIGGER` sobre la tabla, no su propiedad:
por eso la unidad 40 (clase C) aplica aquí pese a que `auth.users` no es
nuestra.

## 3. Los hallazgos

### E-01 — `uellix_owner` no posee lo que la cadena asume que posee (BLOQUEANTE)

La cadena concede privilegios sobre objetos de `public` **desde ventanas de
propietario**, es decir ejecutando como `uellix_owner`. En local funciona porque
`stella_0004_role_separation.sql` transfiere las 38 tablas y 8 funciones a
`uellix_owner` (líneas 456-502). En hosted **no puede**: `stella_hosted_0001`
hace una transferencia **estrecha** — sólo `public.stella_interactions` — y
explica por qué: mover las funciones auxiliares de RLS a un rol que no puede
recibir `USAGE` sobre el esquema `auth` rompería todas las políticas del
producto (RR-09).

Medido, en tres rondas, cada una un privilegio distinto sobre una clase de
objeto distinta, y ninguno mencionado en la sentencia que falla:

| Línea de `T1` | Error | Privilegio que falta |
|---|---|---|
| 278 | `permission denied for function current_user_org_ids` | `EXECUTE ... WITH GRANT OPTION` |
| 398 | `permission denied for table organizations` | `REFERENCES` (una FK lo exige sobre el **destino**) |
| 682 | `permission denied for function public.uellix_forbid_mutation` | `EXECUTE` (función de trigger) |

Objetos implicados: `public.current_user_org_ids()`,
`public.current_user_is_super_admin()`, `public.uellix_auth_uid()`,
`public.organizations`, `public.projects`, `public.evidence_items`,
`public.uellix_forbid_mutation()`.

No es un defecto de una sentencia: es la distancia entre dos modelos de
propiedad, y cerrarla es una decisión sobre RR-09.

### E-02 — la cadena gobernada no tiene instalador válido (BLOQUEANTE)

Se probaron **las dos** identidades posibles, sobre el mismo estado. Fallan en
sentencias distintas por razones opuestas:

| Identidad | Falla en | Motivo |
|---|---|---|
| `postgres` | `T1` línea 278 | tiene `CREATEROLE`, así que `assert_hosted_capabilities` pasa; la cadena avanza hasta E-01 y, superado E-01, hasta la línea 1000: `permission denied to set role "uellix_cap_grounding"` — la concesión nombró a `uellix_migrator` y la sesión no lo es |
| `uellix_migrator` | `T1` línea 216 | **es** el rol que nombran todas las elevaciones (`GOVERNED_INSTALLER`), pero `stella_hosted_0001` lo crea `NOCREATEROLE`, y `assert_hosted_capabilities` (C1) exige `CREATEROLE` porque cada paquete crea su rol de capacidad |

`GOVERNED_INSTALLER` del generador y el contrato de capacidades del bootstrap
discrepan sobre quién es el instalador. Ninguna sesión satisface ambos.

Existe un camino — `postgres` puede ampliarse a sí mismo (`GRANT
uellix_migrator TO postgres WITH INHERIT TRUE, SET TRUE`), que es exactamente
RR-02 — pero **que la remediación esté disponible no es un argumento de que sea
correcta**: vuelve a unir las dos identidades que el modelo separó a propósito.

### E-03 — todo rechazo de `assert_hosted_capabilities` se enmascara (MEDIO)

`db/prepared/stella_hosted_0001_managed_role_bootstrap.sql` línea 512 declara
`v_missing text[]` y las líneas 520-567 hacen `v_missing := v_missing ||
'literal'`. Con un literal de tipo desconocido PostgreSQL resuelve `anyarray ||
anyarray` antes que `anyarray || anyelement`, y el resultado es:

```
ERROR: malformed array literal: "CREATEROLE"
DETAIL: Array value must start with "{" or dimension information.
```

El operador nunca ve qué capacidad falta. Medido dos veces en esta sesión: una
con el centinela ausente y otra con `CREATEROLE` ausente. **La rama feliz no
está afectada**; sólo el diagnóstico. Cierre sugerido: `|| 'literal'::text`.

### E-04 — la postcondición «cero miembros» es insatisfacible en gestionado (BLOQUEANTE)

Con E-01 y E-02 parcheados en el entorno, `T1` llega a su propia verificación
final y la falla:

```
grounding_0002 FAILED verification: uellix_cap_grounding has 1 member(s).
It must have none, or SET ROLE reaches the write path
```

Causa medida: cuando un rol **no superusuario** con `CREATEROLE` crea otro rol,
PostgreSQL 16+ le auto-concede la pertenencia `WITH ADMIN OPTION` (RR-02). Con
`createrole_self_grant = ''` esa fila lleva `inherit_option = f` y
`set_option = f`.

Es decir: **la propiedad de seguridad que la postcondición protege se cumple**
—nadie alcanza el rol por `SET ROLE`— pero **la prueba que usa (contar
miembros) no**. La postcondición mide lo que no debía medir.

## 4. Lo que sí quedó certificado

| Sección | Resultado |
|---|---|
| Identidad del motor (17.6 / 170006 / `createrole_self_grant` vacío) | PASS |
| Baseline 50/50 + bootstrap | PASS |
| PRECHAIN limpio, 9/9 `ABSENT` | PASS |
| Entrada gobernada: 9 rutas explícitas, 9 digests fijados, sin glob ni resolución por basename | ENFORCED |
| Rechazo por digest movido (§21) | `CERT_DIGEST_MISMATCH`, antes de tocar el servidor |
| Rechazo de los bytes **no gobernados** `.hosted.sql` (§22) | `CERT_DIGEST_MISMATCH` |
| Rechazo de una **ruta** fuera de `db/prepared/hosted/governed/` (§22) | `CERT_PATH_NOT_GOVERNED` |
| Rechazo de un paquete desconocido (sin fallback) | `CERT_UNKNOWN_PACKAGE` |
| Atomicidad de paquete, puntos alcanzables (F9, F10) | PASS — rollback total |
| Contrato forward-only sobre estado atestiguado | ENFORCED |
| Contenedores / imágenes / redes al terminar | 0 / 0 / 0 |

### Inyecciones de fallo

Ocho de los diez puntos son **posteriores** al primer bloqueante, así que en la
corrida de certificación no se alcanzan. Se reportan `NOT_REACHED` en lugar de
contarse como aprobados: un paquete que falla por otra razón no es evidencia
sobre el punto que se quería probar.

| | Certificación | Diagnóstico (E-01 + E-02 parcheados) |
|---|---|---|
| F1 tras abrir la pertenencia temporal | NOT_REACHED | **alcanzado**, rollback total |
| F2 tras `SET ROLE uellix_owner` | NOT_REACHED | **alcanzado**, rollback total |
| F3 tras el `GRANT CREATE ON SCHEMA` temporal | NOT_REACHED | **alcanzado**, rollback total |
| F4 tras el primer `ALTER FUNCTION ... OWNER TO` | NOT_REACHED | **alcanzado**, rollback total |
| F5 a mitad de segmento de capacidad | NOT_REACHED | **alcanzado**, rollback total |
| F6 tras `RESET ROLE`, **antes** de revocar la pertenencia | NOT_REACHED | **alcanzado**, rollback total |
| F7 dentro de la alternancia W47 | SKIPPED (la cadena nunca llegó a T7) | SKIPPED |
| F8 dentro de W46.S1 antes del segundo traspaso | SKIPPED | SKIPPED |
| F9 tras la reescritura gestionada `ALTER ROLE` | **alcanzado**, rollback total | **alcanzado**, rollback total |
| F10 tras DDL canónico ordinario | **alcanzado**, rollback total | **alcanzado**, rollback total |

«Rollback total» significa, medido en el catálogo después de cada fallo: 0
pertenencias temporales sobrevivientes, 0 `CREATE` de esquema residual,
propiedad de funciones idéntica al estado previo, filas de pertenencia del
proveedor intactas, y el paquete de vuelta al estado que tenía antes.

F6 es el punto estrecho que un aplicado **no** transaccional filtraría: la
pertenencia sigue abierta y los traspasos ya están hechos.

## 5. Lo que no se pudo medir

- Los 27 `ALTER FUNCTION ... OWNER TO` en el motor: la cadena nunca los ejecutó
  hasta commit.
- Limpieza de las 11 pertenencias de traspaso al cierre de paquete.
- Residual de `CREATE` temporal tras `T9`.
- Topología de roles persistente tras `T9`.
- Los tres propietarios canónicos de F-01.
- SD Gate v2 y el inventario RLS/políticas tras la cadena.
- Recuperación de salida ambigua contra un paquete realmente instalado.

Todo ello queda pendiente de una corrida posterior a la remediación.

## 6. Backlog de endurecimiento diferido

De la revisión independiente del Commit 4, clasificados HARDENING y **no**
implementados aquí por instrucción explícita. La certificación no reveló que
ninguno sea funcionalmente necesario:

- **F-C4-03**, **F-C4-04**, **F-C4-05**, **F-C4-06**, **F-C4-07**.

Cerrados en código en este commit: **F-C4-01** y **F-C4-02**
(`db/hosted/authority/generated-output-validator.ts`), con mutaciones que fallan
sin el arreglo en `tests/hosted/authority/generated-output-binding.test.ts`.

Nuevo, hallado por el motor y **no** cerrado aquí: **E-03**.

## 7. Estado

```
PG176_ENGINE                  = FAIL
GOVERNED_T1_T9_ENGINE         = INCOMPLETE (0/9)
GOVERNED_ARTIFACT_RUNNER      = ENFORCED
UNGOVERNED_ARTIFACT_EXECUTION = REFUSED
PINNED_GOVERNED_INPUT         = ENFORCED
PACKAGE_FAILURE_ATOMICITY     = PASS (en los puntos alcanzables)
FORWARD_ONLY_ENGINE_CONTRACT  = ENFORCED
SAFE_TO_WRITE_STAGING         = false
T1_RETRY_AUTHORIZED           = false
```

El siguiente commit es de **remediación**, no de certificación. E-01, E-02 y
E-04 son decisiones de autoridad; hasta que se tomen, volver a certificar
medirá lo mismo.

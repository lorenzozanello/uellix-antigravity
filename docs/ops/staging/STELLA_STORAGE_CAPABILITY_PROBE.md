# STELLA — Sonda de capacidad del canal gestionado sobre `storage.objects`

> Train 5C2, continuación. **Ninguna escritura remota se ha realizado.** Este
> documento prepara una frontera humana; no la autoriza ni la ejecuta.

---

## 0. La corrección que abre esta unidad

El informe anterior afirmó dos cosas incompatibles:

| Afirmación | Veredicto de la auditoría |
|---|---|
| «PSQL `transaction_read_only` = UNCONFIRMED, sigue bloqueando» | **correcta** |
| «Baseline apply gate: 17 criterios, 1 bloqueando» | **falsa** |

`hosted-storage-apply-identity-probed` **es** un criterio real del apply gate y
refuta con `UNCONFIRMED` en su primera rama, antes de mirar nada más. El «1» salía
de `satisfying()` — una **fixture de test** que describe un proyecto hipotético
donde `transactionReadOnly: true`, `canSetRole: true`, `ownsStorageObjects: true` y
`evidenceBucketExists: true`. Todas contradicen la evidencia registrada.

El fondo del problema: **nada en el repositorio evaluaba el gate contra la
evidencia medida.** Mientras dos objetos distintos puedan responder la misma
pregunta, un informe y un gate pueden divergir; el criterio no se tocó — se añadió
el objeto que faltaba.

- `db/hosted/measured-evidence.ts` construye los inputs **leyendo**
  `artifacts/class-c-probes/*.json`, no transcribiéndolos a TypeScript.
- `pnpm apply:status` imprime el veredicto vivo; `apply:status:write` lo graba en
  `artifacts/hosted-apply-status.json`; `apply:status:verify` regenera y compara.
- Un test exige que los ids y el conteo publicados sean **exactamente** los que el
  gate computa. Un número que un documento pueda afirmar y nada pueda comprobar es
  un número que acabará equivocándose en la dirección que favorece a quien escribe.

### 0.1 Y la primera versión del arreglo también fabricaba

La revisión adversarial ejecutó el loader contra artefactos mutilados y encontró
que **yo estaba inventando exactamente los campos que el gate verifica**:

| Fabricación | Efecto medido por el revisor |
|---|---|
| `obs.can_set_role ?? false` | borrando los tres privilegios del artefacto, `hosted-storage-set-role-ready` seguía **satisfied** citando «MEMBER=false, USAGE=false, SET=false» — un veredicto que cita tres mediciones que ya no existían |
| `query` de `applyIdentity` hardcodeada en el loader | el criterio que exige la query era **infalsificable**: dos líneas de JSON y quedaba satisfecho citando provenance inventada |
| `recordedQuery` componiendo las cadenas canónicas | el comentario decía «citar nuestras propias cadenas haría pasar el check por construcción», y la función lo hacía cuatro líneas más abajo |
| `connectionHost = db.${projectRef}.supabase.co` | la rama de discrepancia de `target-identity-corroborated` era **inalcanzable por construcción**: renombrando el proyecto en ambos artefactos seguía diciendo «corroborated by its own host» |
| `measuredBy ?? 'operator'` | `attested()` rechaza una provenance vacía; el loader la sustituía antes de que el gate la viera |

Corregido: `?? null` en todos los casos, `null` refuta la atestación completa, y
nada se compone. **Esto destapó un hueco de evidencia que nadie había visto:**
`artifacts/class-c-probes/2026-08-07-apply-identity.json` **no registra las
queries** que produjeron sus números, ni el host de conexión. El gate refuta una
atestación sin query — así que ahora refuta, y esa refutación es una afirmación
verdadera sobre la evidencia.

### 0.2 Un criterio que no podía pasar nunca

`class-c-probes-affirmative` exigía `true` a las **ocho** sondas, incluidas
`ownsStorageObjects` —medida `false` y **permanentemente** `false`— y las tres
que la propia lista etiqueta «diagnostic only». Y `checkPrivileges` en el runner
rechazaba las 50 unidades ante cualquier `false`, es decir **para siempre**, por
la condición que la división PARTE A / PARTE B se construyó para sobrevivir.

Ahora cada sonda declara qué significa un `false` (`CLASS_C_REQUIREMENT`):

| Clase | Un `false` significa |
|---|---|
| `apply-required` | el canal psql no puede proceder. **Refuta** |
| `branch-selector` | **selecciona** una adaptación; se cruza contra el path elegido |
| `runtime-prerequisite` | hace falta antes del runtime, no del apply. Tiene su propio criterio y su B0 |
| `diagnostic` | se registra porque la **combinación** informa. Nunca exigido |

No es relajar para reducir blockers: los blockers **subieron de 7 a 9**.

**Veredicto vivo, y es de donde debe citarse cualquier cifra:**

```
18 criterios · 9 satisfechos · 9 BLOQUEANDO
  - checkpoint-a0-pass
  - target-identity-corroborated                ← el artefacto no registra el host
  - class-c-probes-affirmative                  ← el artefacto no registra las queries
  - hosted-storage-apply-identity-probed        ← ídem, y transaction_read_only UNCONFIRMED
  - hosted-storage-set-role-ready
  - hosted-evidence-bucket-provisioning-ready
  - hosted-storage-management-channel-verified
  - zero-production-data
  - feature-flags-false
applyAuthorized = false
```

---

## 1. Por qué la policy canónica es la sonda equivocada

La continuación anterior proponía `select_evidence` como primer intento por
Dashboard. **Es un error de diseño**, y el operador lo detectó: la unidad 41 PARTE
A **no está aplicada**, así que `public.can_read_evidence_object` no existe en el
destino. Un fallo tendría al menos tres causas candidatas:

- ownership/capability del canal;
- `42883` porque el helper no existe;
- alguna otra dependencia (bucket, roles).

Y el objetivo de la sonda es responder **exactamente una** pregunta. Un negativo
ambiguo es peor que ninguna sonda: parecería una medición y autorizaría una
conclusión que la evidencia no sostiene.

---

## 2. La policy temporal

```sql
CREATE POLICY "uellix_tmp_capability_probe_20260807"
ON storage.objects
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (false);
```

| Propiedad | Valor | Por qué |
|---|---|---|
| Nombre | `uellix_tmp_capability_probe_20260807` | inequívocamente temporal, nuestro y fechado; **no** termina en `_evidence` para que nadie lo confunda con la superficie canónica |
| Comando | `SELECT` únicamente | |
| Roles | `authenticated` | el mismo que ya usan las canónicas; no ensancha nada |
| `USING` | `false` | no depende de nada |
| `WITH CHECK` | ausente | una policy SELECT no tiene |
| Helpers | **ninguno** | sin `can_*_evidence_object`, sin `auth.uid()`, sin `bucket_id`, sin `public.` |

### 2.1 Monotonía de seguridad

Las policies **PERMISSIVE se combinan con OR**. Añadir una policy permissive a una
tabla sólo puede **añadir** filas visibles, nunca quitarlas, y `USING (false)` no
añade ninguna: para toda fila, `false` no aporta nada a la disyunción. La sonda es
**monótona en seguridad** — su existencia no puede ampliar el acceso en ninguna
medida.

> ### ⚠️ `AS PERMISSIVE` va explícito, y no es pedantería
>
> Una policy **RESTRICTIVE** con `USING (false)` se combina con AND contra lo que
> las permissive admitan, así que sólo puede **quitar** acceso. Las mismas ocho
> palabras, la dirección opuesta.
>
> El revisor acotó correctamente la primera redacción de este párrafo, que decía
> «niega todo acceso»: **hoy no niega nada**, porque no hay ninguna policy
> permissive sobre `storage.objects` que podar. Pero en cuanto existan las tres
> canónicas lo niega todo — y una sonda cuyo efecto depende de **cuándo** se
> ejecute no es la sonda monótona que se diseñó. Se deja la corrección visible en
> lugar de reescribirla en silencio.
>
> El paso 8 del guion lo dice y la postcondición compara `pg_policies.permissive`
> por igualdad: el guion es defensa en profundidad, no la única comprobación.

---

## 3. Precondición (read-only, no ejecutada por el agente)

```sql
-- READ ONLY. Ejecutar dentro de BEGIN READ ONLY; … ROLLBACK;
SELECT
  current_user,
  session_user,
  current_setting('transaction_read_only')                          AS read_only,
  to_regclass('storage.objects') IS NOT NULL                        AS table_exists,
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'storage.objects'::regclass) AS rls_enabled,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects')        AS existing_policy_count,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname = 'uellix_tmp_capability_probe_20260807')     AS probe_already_present;
```

`evaluateCapabilityPrecondition()` refuta si:

- el project ref no tiene forma de 20 minúsculas, **o está en la denylist de
  producción** (comprobada contra la constante, no contra un booleano que le pasen);
- el entorno declarado no es `staging`;
- `storage.objects` no existe, o **no se midió**;
- RLS no está activo, o **no se midió** — una policy sobre una tabla sin RLS es
  inerte, y una sonda inerte no prueba nada sobre enforcement;
- ya existe una policy con ese nombre → un `CREATE` que falla con `42710`
  (`duplicate_object`) se leería como «el canal no puede crear policies», que es la
  conclusión **contraria**;
- **no se tomó el inventario previo** (conteo + nombres) — sin un «antes», borrar la
  sonda *y algo más* es indistinguible de borrar sólo la sonda;
- las policies canónicas ya están presentes: la sonda es para un proyecto donde
  **no** lo están.

---

## 4. Guion del operador (no autorizado todavía)

0. Precondición read-only. **Anotar `existing_policy_count` y los nombres.**
1. Confirmar que el selector de proyecto muestra **staging**. Esto es una escritura.
2. Dashboard → Storage → Policies → tabla **OBJECTS** → New policy → *full customization*.
3. Nombre: `uellix_tmp_capability_probe_20260807`
4. Operación permitida: **SELECT** únicamente.
5. Roles: **authenticated** únicamente.
6. Definición (`USING`): `false`
7. `WITH CHECK`: **vacío**.
8. Confirmar que el formulario dice **PERMISSIVE**, no RESTRICTIVE.
9. Guardar. Registrar **sólo**: éxito/fallo, texto de error saneado, timestamp,
   project ref y nombre de policy. **Nunca** una clave, un token o una cadena de
   conexión.
10. Postcondición read-only, guardando la fila completa.
11. **Cleanup**: borrar la policy por el mismo canal Dashboard.
12. Postcondición de cleanup: la sonda ausente **y** todas las policies del paso 0
    todavía presentes.
13. **PARAR.** No crear las policies canónicas en la misma sesión: necesitan la
    PARTE A, que no está aplicada.

---

## 5. Postcondición — igualdad, no existencia

```sql
SELECT schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check
  FROM pg_policies
 WHERE schemaname = 'storage' AND tablename = 'objects'
 ORDER BY policyname;
```

`verifyCapabilityProbeSurface()` compara por **igualdad normalizada**:

| Columna | Esperado |
|---|---|
| `schemaname` | `storage` |
| `tablename` | `objects` |
| `policyname` | `uellix_tmp_capability_probe_20260807` |
| `permissive` | `PERMISSIVE` |
| `roles` | `{authenticated}` |
| `cmd` | `SELECT` |
| `qual` | `false` |
| `with_check` | `NULL` |

Sin `EXISTS(policyname)`. Sin coincidencia por subcadena — un nombre próximo
(`…_x`) falla, y una policy con el nombre correcto y `USING (true)` falla, que es
exactamente el fallo que este repositorio ya encontró en B0-16 y no tiene excusa
para repetir en un archivo escrito después.

---

## 6. Cleanup

La sonda se borra **por el mismo canal soportado**. La verificación no es «la sonda
ya no está»:

- la sonda debe estar **ausente**;
- **toda** policy registrada en el paso 0 debe seguir presente;
- no debe haber aparecido ninguna policy nueva.

Un `DROP` que se llevara por delante una policy preexistente también deja la sonda
ausente, y una comprobación que sólo preguntara por la ausencia lo llamaría éxito.

Si `CREATE` funciona pero el borrado no puede demostrarse:

**`BLOCKED_MANAGEMENT_CHANNEL_CLEANUP`** — un canal que puede crear una policy y no
puede quitarla deja el proyecto cargando permanentemente el artefacto de una
medición.

---

## 7. Interpretación

### Si `CREATE` falla por ownership/permission

```
MANAGEMENT_PLANE_PATH = REJECTED
```

Todas las lecturas alternativas quedan cerradas: el predicado no referencia helper,
bucket ni función, así que `42883` y «falta el bucket» no están disponibles como
explicación.

**No reintentar** con `service_role`, `supabase_privileged_role`, `authenticator`,
`ALTER OWNER`, `GRANT`, `SET ROLE` ni `BYPASSRLS`. Escalar a soporte de Supabase con
el registro.

### Si `CREATE` funciona

```
MANAGEMENT_PLANE_PATH = CAPABILITY_DEMONSTRATED_PENDING_CLEANUP
canonicalPoliciesProven = false
```

Esto prueba **capacidad del canal desplegado** y nada más. Las tres policies Uellix
llaman helpers que crea la PARTE A, filtran por un bucket que todavía no existe, y
no se han intentado. **Capacidad no es corrección**, y este registro no puede
citarse jamás como evidencia de que la superficie de storage está instalada.

`MANAGED_BOUNDARY_DESIGNED` puede entonces avanzar hacia *capability verified*,
sujeto a postcondición y cleanup.

---

## 8. Estado

| Elemento | Valor |
|---|---|
| Sonda | **preparada, NO ejecutada** |
| Escrituras remotas | 0 |
| `MANAGEMENT_PLANE_PATH` | `UNRESOLVED_REQUIRES_HOSTED_EVIDENCE` |
| `applyAuthorized` | `false` (9 bloqueando — ver §0) |
| `baselineApplied` | `false` |
| `evidenceBucketExists` | `false` |

**Acción de operador requerida, tres y en cualquier orden:**

1. Mini-sonda psql read-only por la identidad Session Pooler, para cerrar
   `transaction_read_only = UNCONFIRMED`:
   ```
   BEGIN READ ONLY;
   SELECT current_setting('transaction_read_only');
   ROLLBACK;
   ```
2. **Completar los artefactos de sonda**: `2026-08-07-apply-identity.json` debe
   registrar `queries` (el SQL que se ejecutó) y `connectionHost`. Sin eso el
   gate no puede distinguir una medición de un número tecleado, y refuta — que es
   lo correcto. **No los rellena el agente**: son evidencia del operador.
3. La sonda de capacidad de §4, **con autorización explícita**, seguida de su
   postcondición y su cleanup.

---

## 9. Riesgos conocidos del canal, no verificables desde aquí

| Riesgo | Mitigación ya construida |
|---|---|
| Algunas builds de Studio **sufijan** el nombre generado (`"<nombre> <uid>_0"`). El Save reportaría éxito y la postcondición diría «absent» | `reconcileCapabilityRecord` refuta la combinación «record SUCCEEDED + policy ausente» y nombra el sufijado como causa; el cleanup detecta «policies inesperadas» |
| El formulario puede no ofrecer selector RESTRICTIVE, con lo que el paso 8 no tendría nada que confirmar | la postcondición compara `pg_policies.permissive` por igualdad; el paso es defensa en profundidad, no la única |
| La UI puede fallar por timeout **después** de que el servidor confirme el CREATE | `reconcileCapabilityRecord` refuta «record FAILED + policy presente» y prohíbe expresamente concluir `REJECTED` de ese registro |
| Un cleanup que hiciera drop+recreate de una policy preexistente con otro predicado | el cleanup compara **filas completas**, no nombres |

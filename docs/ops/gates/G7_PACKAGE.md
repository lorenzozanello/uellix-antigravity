# G7 Package — Revisión Legal de Términos/Privacidad para Stella

> Gate externo G7 (`docs/ops/STELLA_FABLE_EXTERNAL_GATES.md`). Tipo: **Legal**.
> Workstream de origen: WS7. Dueño humano: **Lorenzo Zanello**, quien encarga
> la revisión a un asesor legal externo — este paquete no sustituye asesoría
> legal profesional, es el checklist que estructura esa revisión.
>
> **Creado en la reconciliación documental 2026-07-31** a partir de la
> auditoría independiente `STELLA_MOONSHOT_INDEPENDENT_VERIFICATION`, que
> encontró los borradores de WS7 completos pero sin el checklist que
> `EXTERNAL_GATES.md` define como el entregable offline de este gate.

## 1. Alcance legal

Este gate cubre exclusivamente los términos que Stella (la capa de IA de
Uellix) introduce sobre la base legal existente del producto. **No** vuelve a
revisar cláusulas de Uellix no relacionadas con Stella — esas ya están fuera
del alcance de esta campaña.

Cubre:

- Términos de Servicio: sección de IA/Stella.
- Política de Privacidad: procesamiento por Stella, base legal, categorías
  de datos, proveedor subprocesador (Google Gemini).
- Política de retención de `stella_interactions` / `audit_logs` /
  `stella_suggestion_decisions` (DP-04, hoy borrador).
- Lenguaje de "no certificación automática" que aparece en los prompts de
  Stella y debe ser consistente con lo que el usuario final lee en Términos.

No cubre: DPA formal con Google (si Uellix no tiene uno vigente, es un
prerrequisito de G7, no parte de él — ver Precondiciones).

## 2. Documentos a revisar

| Documento | Ruta | Estado a la fecha de este paquete |
|---|---|---|
| Términos de Servicio (sección Stella) | `app/(public)/terms/page.tsx` | Borrador EN reescrito por WS7, Stella-aware |
| Política de Privacidad (sección Stella) | `app/(public)/privacy/page.tsx` | Borrador EN reescrito por WS7, Stella-aware |
| Política de retención (DP-04) | `docs/ops/STELLA_RETENTION_POLICY.md` | **DRAFT explícito** — 3 opciones sin decidir, requiere decisión de Lorenzo antes o durante esta revisión |
| Runbook de incidentes (referencia, no objeto de revisión legal) | `docs/ops/runbooks/STELLA_INCIDENTS.md` | Informativo — contexto del incidente de rotación de key 2026-07-10 |
| Contratos de rol / esquemas de salida (contexto técnico) | `docs/20_STELLA_ROLE_CONTRACTS.md` | Referencia para validar que el lenguaje de "nunca certifica" es consistente entre prompt, schema y Términos |

## 3. Puntos que el asesor legal externo debe validar

### 3.1 Términos de uso

- [ ] La descripción de Stella como "capa de IA" no genera expectativas de
      exactitud o de reemplazo del juicio humano que el producto no puede
      cumplir.
- [ ] Queda explícito que las sugerencias de Stella requieren revisión y
      aceptación humana antes de tener efecto (ningún flujo escribe sin
      confirmación — invariante verificado en código por WS2, ver
      `components/stella/StellaContextualAdvisorField.tsx`).
- [ ] Limitación de responsabilidad cubre salidas generadas por IA
      específicamente (no solo el uso general de la plataforma).

### 3.2 Privacidad y base legal

- [ ] Base legal para el procesamiento de datos del proyecto por Stella
      (consentimiento explícito al activar la función vs. interés legítimo).
- [ ] Categorías de datos que llegan al prompt: narrativas, resúmenes de
      teoría de cambio, metadatos de evidencia — **nunca** PII directa sin
      redactar (verificado en código: `lib/stella/security/redact-pii.ts`
      corre sobre todos los caminos de texto libre antes del prompt).
- [ ] Poblaciones sensibles: el detector (`lib/stella/security/sensitive-populations.ts`)
      añade un aviso, no bloquea ni cambia el consentimiento requerido —
      confirmar si esto es suficiente o si el asesor recomienda fricción
      adicional (checkbox de consentimiento reforzado) para proyectos que
      trabajan con esas poblaciones.

### 3.3 Subprocesador (Google Gemini)

- [ ] DPA vigente con Google Cloud/AI Studio para el uso de Gemini como
      subprocesador — **prerrequisito**, ver §4.
- [ ] Política de privacidad lista a Google como subprocesador con el
      alcance correcto (qué datos recibe, por cuánto tiempo, con qué
      finalidad).
- [ ] Confirmar la región/residencia de datos de la API de Gemini usada y
      si es compatible con los compromisos de residencia que Uellix ya
      hizo a sus clientes (si los hay).

### 3.4 Retención y eliminación

- [ ] Decidir entre las 3 opciones DRAFT de `STELLA_RETENTION_POLICY.md`
      (partición por fecha / pseudonimización G2-gated / no retener
      `response_json` desde el origen) — **esta decisión bloquea la
      redacción final** de la sección de retención en Privacidad.
- [ ] Mecánica de borrado por solicitud del titular (derecho de supresión):
      confirmar que el diseño append-only (trigger `uellix_forbid_mutation`,
      preparado en `db/prepared/stella_0002_*.sql`, pendiente de G2) es
      compatible con la opción de retención elegida — un borrado físico
      posterior a G2 requeriría un mecanismo aparte (ver §4 de
      `STELLA_RETENTION_POLICY.md`).

### 3.5 Afirmación de no certificación automática

- [ ] El lenguaje "Stella no certifica, no aprueba, no valida, no da el
      visto bueno" que aparece en los 7 prompts de advisor y en los 3 roles
      de reviewer (`requires_human_review` hardcodeado `true` en el schema
      Zod, no un default) debe reflejarse con la misma fuerza en Términos —
      confirmar que no hay una brecha entre lo que el producto promete
      técnicamente y lo que el usuario lee.
- [ ] Confirmar que ningún flujo de negocio (reportes, publicación) permite
      inferir que una salida de Stella equivale a una aprobación o
      certificación metodológica.

## 4. Precondiciones (todas binarias)

- [ ] DPA con Google Cloud/AI Studio vigente y disponible para que el asesor
      lo revise (o confirmación explícita de que Uellix opera bajo los
      términos estándar de la API sin DPA separado — el asesor decide si
      eso es suficiente).
- [ ] Decisión DP-04 (opción de retención) tomada por Lorenzo, o el asesor
      acepta revisar con las 3 opciones abiertas y condicionar su aprobación
      a la que se elija.
- [ ] Borradores de Términos y Privacidad (`app/(public)/terms/page.tsx`,
      `app/(public)/privacy/page.tsx`) en su versión final de campaña —
      confirmado: son los mismos que pasaron `pnpm build` en el checkpoint
      `15af6bb`.

## 5. Criterios de éxito (binario)

G7 **pasa** cuando:

| # | Criterio |
|---|----------|
| L1 | El asesor legal completó los 5 sub-checklists de §3 con un veredicto explícito por punto (OK / requiere cambio / no aplica) |
| L2 | Todo punto marcado "requiere cambio" tiene una redacción de reemplazo aprobada por el asesor, aplicada a los borradores |
| L3 | DP-04 (retención) quedó decidida y reflejada consistentemente en `STELLA_RETENTION_POLICY.md` y en la sección de Privacidad |
| L4 | El asesor confirma por escrito (email o documento firmado) que los Términos/Privacidad revisados son aptos para producción bajo la jurisdicción aplicable |

## 6. Criterios de aborto

No proceder a publicar los Términos/Privacidad revisados si:

- El DPA con Google no existe y el asesor determina que es un bloqueador
  (no un punto opcional) para la jurisdicción aplicable.
- Cualquier punto de §3 queda como "requiere cambio" sin una redacción de
  reemplazo aprobada — no se publica con pendientes legales abiertos.
- El asesor identifica una promesa del producto (en código, prompts o UI)
  que contradice el lenguaje legal y esa contradicción no se resuelve en
  ninguno de los dos lados.

En cualquiera de estos casos: el gate queda ABIERTO, se documenta el motivo
en este archivo (nueva fila en §7 evidencia) y no se avanza a G4 (rollout)
ni a G10 (piloto).

## 7. Evidencia requerida

| Evidencia | Formato | Dónde se archiva |
|---|---|---|
| Checklist completo de §3, con veredicto por punto | Documento del asesor o anotación en este archivo | `docs/ops/gates/G7_PACKAGE.md` (este archivo, sección de sign-off) o adjunto referenciado |
| Confirmación escrita de aptitud legal (§5, L4) | Email o documento firmado | Archivado por Lorenzo fuera del repo (puede contener info del asesor/estudio legal — no commitear) |
| Diff final de Términos/Privacidad post-revisión | `git diff` sobre `app/(public)/terms/page.tsx` y `app/(public)/privacy/page.tsx` | Commit propio, revisado como cualquier otro cambio de código |

## 8. Rollback documental

Si tras publicar una versión revisada se detecta un problema legal:

1. Revertir el commit de Términos/Privacidad a la versión anterior
   (`git revert`, nunca editar in-place un documento legal ya publicado).
2. Notificar a los usuarios activos si el cambio revertido afecta
   compromisos ya comunicados (decisión de Lorenzo, no automática).
3. Re-abrir este gate (G7) con el punto que falló documentado en §6.

No hay rollback de datos: este gate no toca esquema, RLS ni infraestructura.

## 9. Aprobación humana requerida

Este gate **no puede completarse por ningún agente**. Requiere:

- Un asesor legal externo (fuera del equipo de ingeniería) para el veredicto
  técnico-legal de §3.
- Aprobación explícita de Lorenzo para publicar los documentos revisados.

## 10. Sign-off

| Rol | Nombre | Decisión (APPROVE / REJECT / PENDIENTE) | Fecha |
|-----|--------|-----------------------------------------|-------|
| Asesor legal externo | ______ | PENDIENTE | ______ |
| Dueño humano | Lorenzo Zanello | PENDIENTE | ______ |

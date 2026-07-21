# Protocolo de prueba — Auditoría funcional Uellix

## Entorno verificado (2026-07-16)

| Campo | Valor |
|---|---|
| Repositorio | `uellix-antigravity` — github.com/lorenzozanello/uellix-antigravity |
| Rama | `fix/p1a-security-validation` |
| Commit | `b97c8f0` — *feat(calc): update multi-funder calculations, FX flows and reporting UI* |
| Proyecto Vercel | `prj_3NplDjQAEU6nvFoRZEdnNOAT3ThJ` (`lorenzozanello-5040s-projects`) |
| Preview (5 h) | `uellix-antigravity-ib82wth9t-...vercel.app` → **302 a Vercel SSO** |
| Producción | `uellix.com` → 308 → `www.uellix.com` (200) |
| Navegador | Claude Browser (interno) — alcanza prod; **sin sesión** (`document.cookie` vacío) |
| Viewport | 1280×720 |
| Organización | The Balance Corp (prevista) |
| Rol | org_admin (previsto) |
| Sesión confirmada | **NO** — ver `00_EXECUTIVE_SUMMARY.md`, Bloqueo 1 |

**Objetivo de entorno para la corrida:** producción (`www.uellix.com`) vía extensión de
Chrome con sesión de `lorenzo@thebalancecorp.org`. Se descarta Preview pese a la
preferencia del prompt, porque añade una barrera de Vercel SSO sin aportar cobertura
adicional relevante frente a producción.

## Decisiones de la corrida (Lorenzo, 2026-07-16)

1. Autenticación mediante **extensión de Chrome** con sesión ya iniciada. El agente no
   introduce contraseñas.
2. **Outcome 1 se carga sin proxy** (dato ausente en la especificación). Se audita con los
   Outcomes 2, 3 y 4 valuables.
3. **Rango 2,7:1–3,2:1 → NO APLICABLE.** Criterio sustituto: desviación < 2% frente al
   control independiente **1,051:1** (r = 3,5%).
4. Tasa de descuento de la corrida: **3,5%**.
5. Outcome 3: cantidad = **220,8** (480 × Δ46%).

## Fixtures generados y verificados

`audit-fixtures/agua-segura/` — reproducibles con `node generate.mjs` (PRNG con semilla
fija: re-ejecutar produce ficheros idénticos, lo que estabiliza los hashes de evidencia).

| Archivo | Bytes | Validación |
|---|---|---|
| `linea-base.csv` | 4.945 | 120 hogares, cabecera + banner |
| `encuesta-final.csv` | 4.947 | 120 hogares, cabecera + banner |
| `asistencia.csv` | 717 | 25 líderes, 22 completan |
| `testimonios.txt` | 1.108 | 4 testimonios |
| `inversiones.xlsx` | ~1.9 K | OOXML validado con `System.IO.Compression`: `sheet1.xml` devuelve la hoja correcta y contiene el total 235.000.000 |
| `informe-continuidad.pdf` | 2.321 | `%PDF-1.4`, `startxref`→`xref` correcto, 5 objetos, offsets verificados |
| `acta-entrega.pdf` | 2.166 | idem |

Todos llevan el banner *DATOS SINTÉTICOS — EXCLUSIVAMENTE PARA AUDITORÍA FUNCIONAL DE UELLIX*.

## Hallazgo previo por lectura de código (pendiente de confirmar en la app)

**`text/csv` NO está en la lista blanca de MIME de evidencias**
(`lib/pipeline/evidence.ts:22-33`). Tipos aceptados: PDF, JPEG, PNG, WebP, GIF, TXT, DOC,
DOCX, XLS, XLSX. Límite: 25 MB (`MAX_EVIDENCE_FILE_SIZE_BYTES`).

El protocolo exige cargar tres CSV. Puede que la carga funcione igualmente porque Windows
suele reportar `.csv` como `application/vnd.ms-excel` (sí permitido) — es decir, dependería
del sistema operativo del cliente. **A confirmar en la corrida.** Si se confirma, es
candidato a P2: el CSV es el formato natural de una línea base y su aceptación no debería
depender del SO.

## Casos que la lectura del motor ya marca como prioritarios

De `lib/pipeline/sroi-calculation.ts` (modo lectura):

- **`clamp()` en líneas 686-690:** los porcentajes se **saturan** a [0, 100] en lugar de
  rechazarse. La prueba negativa de ">100%" debe verificar si la **UI** valida antes; si no,
  un 150% se guardaría silenciosamente como 100%. Candidato a P1 (dato incorrecto sin aviso).
- **Línea 684 (`quantity ≤ 0 || proxy ≤ 0 → continue`):** las líneas inválidas se **omiten
  en silencio**, sin error. Relevante para números negativos y para el Outcome 1 sin proxy
  (comportamiento esperado en esta corrida — verificar que el reporte lo declare y no lo
  oculte).
- **`durationYears` acotado a [1, 50]** (línea 690) — mismo patrón de saturación.

## Recorrido y pruebas negativas

Sin cambios respecto a la especificación del prompt (27 pasos; pruebas negativas por
módulo). No se ejecutó ninguno: la corrida está bloqueada en el paso 1.

## Limitaciones declaradas

- **Una sola cuenta** → no se valida aislamiento multirol ni colaboración entre usuarios.
- **Una sola organización** → no se valida aislamiento multi-tenant (RLS entre orgs).
- La prueba de "sesión expirada" depende de poder forzar la expiración sin invalidar la
  sesión de trabajo del usuario; se evaluará su viabilidad en la corrida.

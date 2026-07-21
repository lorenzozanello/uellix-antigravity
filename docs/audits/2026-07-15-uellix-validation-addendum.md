# Addendum de Validación Técnica - Uellix
Fecha: 15 de julio de 2026

## 1. Estado del Repositorio
- **Rama actual**: `feature/sprint-0-foundation`
- **Estado**: Limpio (up-to-date), con excepción del directorio untracked `docs/audits/`.
- **Último commit**: `7ae51e6 fix(investment-form): replace per-keystroke auto-save con botón de guardado explícito`

## 2. Comandos de Validación Presentes
| Comando | Script Exacto | Qué Valida | Modifica Archivos | Req. Entorno | Req. BD | Req. Remoto | Duración Est. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `pnpm lint` | `eslint` | Sintaxis y convenciones JS/TS | No | No | No | No | ~10s |
| `pnpm typecheck`| `tsc --noEmit` | Tipos TypeScript | No | No | No | No | ~15s |
| `pnpm test` | `vitest run` | Pruebas lógicas y servicios | No | Parcial | No (Mocks) | No | ~20s |
| `pnpm build` | `next build` | Compilación Next.js estática | Sí (`.next/`) | Sí | Sí | Posible | ~60s |

## 3. Resultados de la Línea Base Segura
- **`pnpm lint`**: **Falló** (Código 1). 39 errores y 43 warnings. La mayoría son por uso de `Unexpected any` en `lib/pipeline/` y `tests/`.
- **`pnpm typecheck`**: **Falló** (Código 2). Errores severos TS2769 en `tests/integration/rls.test.ts` derivados de incompatibilidad de tipos entre los mocks del schema y las queries Drizzle (ej. Tipo `Decimal` vs `string`).
- **`pnpm test`**: Ejecutado pero falló la suite por los errores de tipado e importación de la base de datos en los tests de integración.
  - **Tests Unitarios**: Pasaron (ej. `advisor.test.ts`, `stella-quota.test.ts`).
  - **Tests de Integración (`rls.test.ts`)**: *No ejecutado por falta de entorno aislado*.
  - *Requisito para integración segura*: Provisionar una instancia efímera de PostgreSQL (ej. PGlite en memoria o Testcontainers) y pasar la variable `DATABASE_URL` exclusiva a Vitest.

## 4. Rectificación del Hallazgo `'use server'`
Análisis de `OutcomeAllocationWrapper.tsx`:
- **Ruta**: `app/components/allocation-form/OutcomeAllocationWrapper.tsx`
- **Línea**: 2
- **Tipo de archivo**: Componente React.
- **Exportaciones**: `OutcomeAllocationWrapper` (React Function Component).
- **Diagnóstico Next.js**: **Crítico (Vulnerabilidad de Exposición)**. En Next.js App Router, usar `'use server'` a nivel de archivo convierte *todas* sus exportaciones en Server Actions (endpoints POST públicos `/_next/action`).
- **Riesgo Real**: Aunque el componente está pensado para renderizar UI en el servidor (Server Component por defecto), al tener esta directiva, Next.js lo registra como una función invocable por el cliente. Si un atacante hace un POST a su Action ID, Next.js intentará ejecutar el componente como una mutación, lo cual fallará devolviendo un error (ya que espera argumentos formales, no Props de React), pero aumenta innecesariamente la superficie de ataque y rompe el modelo mental de React.
- **¿Es alcanzable desde un Client Component?**: Si un Client Component lo importa e intenta renderizarlo `<OutcomeAllocationWrapper />`, Next.js arrojará un error de compilación/ejecución. Solo funciona actualmente porque se importa desde un Server Component padre.
- **Corrección potencial**: Eliminar la línea 2. Todo componente en `app/` es de servidor por defecto.

*(Otras instancias encontradas en `actions.ts` son legítimas. Algunas instancias inline en `calculation/page.tsx` son antipatrones arquitectónicos, pero funcionales).*

## 5. Versión y Seguridad de Next.js
- **Versión Declarada**: `16.2.9` (con React `19.2.4`).
- No existen dependencias obsoletas flagrantes en el `package.json`, pero la ausencia de un paso de auditoría en CI (`pnpm audit`) impide garantizar cero vulnerabilidades transitivas al momento del build.

## 6. Estado Real de RLS (Row Level Security)
- **Implementación estática**: Cobertura robusta mediante `organization_id` en todas las tablas sensibles. Existen funciones `SECURITY DEFINER` para aislar lectura de roles.
- **Verificación**: Existe `tests/integration/rls.test.ts` cuyo propósito es demostrar que un usuario de la "Organización A" no puede ver proyectos de la "Organización B".
- **Estado Actual**: **Incomprobable técnicamente** en este momento. El test de integración falla en compilación de tipos (`typecheck`) por el ORM, y no se ejecuta por falta de BD aislada en el pipeline.
- **Riesgo Potencial**: Medio. Existe un falso sentido de seguridad hasta que `rls.test.ts` pase exitosamente contra una BD real.

## 7. Estado Real de los Tests SROI
Inventario general (40 archivos en total):
- **Unitarios puros**: Fórmulas, calculadoras y parseo (ej. `confidence-score`).
- **Tests con mocks (Drizzle)**: La mayoría (ej. `sroi-calculation.service.test.ts`). Aquí se inyectan respuestas de base de datos simuladas.
- **Hallazgo Crítico**: El motor de cálculo SROI usa SQL complejo (agrupaciones, sumas). Al estar evaluado *solo con mocks*, **NO ESTÁ FUNCIONALMENTE VALIDADO**. Si el join de Drizzle está mal escrito, el mock lo enmascara devolviendo datos perfectos, resultando en un falso positivo grave de QA.

## 8. Revisión de Reorganización de Componentes
- **Inventario `app/components/`**: Formularios SROI complejos (`allocation-form`, `fx-sub-form`, `investment-form`).
- **Inventario `components/`**: UI global (`ui/`, `layout/`, `report/`).
- **Riesgo de Reorganización**: Alto acoplamiento. Mover los formularios romperá múltiples imports locales y tests existentes (`allocation-form.test.tsx`).
- **Beneficio**: Exclusivamente orden estético.
- **Decisión**: Clasificado como **P3** (Baja prioridad). No debe bloquear el desarrollo.

## 9. Porcentajes de Avance Rectificados
Se actualiza la matriz basándose en pruebas ejecutables:

| Módulo | Implementado Estático | Verificado Técnico | Nivel de Confianza |
| --- | --- | --- | --- |
| **Backend (DB, Drizzle)** | 95% | 40% (Fallo en Types) | **Medio-Bajo** |
| **Seguridad (Auth, RLS)** | 90% | No verificable | **Bajo** (Hasta correr CI DB) |
| **Lógica SROI (Mocks)** | 85% | 85% | **Medio** (Mocks engañosos) |
| **Interfaz UI/UX** | 60% | 0% (Faltan E2E) | **Bajo** |

---

## 10. Primer Bloque Recomendado para Implementación
**Bloque: Estabilización de la Línea Base y CI/CD (P0)**

No es seguro construir nuevas vistas UI ni calcular el SROI financiero hasta que los cimientos técnicos aprueben los checks.

**Criterios de Aceptación del Primer Bloque:**
1. Eliminar la directiva `'use server'` de `OutcomeAllocationWrapper.tsx` y revisar antipatrones.
2. `pnpm typecheck` debe finalizar con código de salida `0` (reparar desajustes de Drizzle en tests).
3. `pnpm lint` debe finalizar con código de salida `0` (resolver explícitamente los `any`).
4. Aislar `rls.test.ts` de la suite principal (`vitest.config.ts`), permitiendo que `pnpm test` corra de forma segura y exitosa en un entorno local sin BD remota.

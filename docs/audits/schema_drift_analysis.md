# Reporte de Auditoría: Deriva de Esquema (Schema Drift)

**Fecha:** 15 de julio de 2026
**Auditor:** Responsable de Remediación Técnica (Antigravity)

---

## 1. Consultas de Verificación Read-Only para Supabase

Para comprobar el estado real de la base de datos remota sin modificar datos, ejecute las siguientes consultas SQL:

### A. Verificar existencia de columnas obsoletas
```sql
-- Verifica si 'total_value' sigue existiendo físicamente en la tabla de ejecuciones
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sroi_calculation_runs' AND column_name = 'total_value';

-- Verifica si 'net_value' sigue existiendo físicamente en la tabla de ítems de línea
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'sroi_calculation_line_items' AND column_name = 'net_value';
```

### B. Verificar registros con valores nulos en columnas que deberían ser NOT NULL
```sql
-- Cuenta ejecuciones de cálculo donde 'calculated_by' es NULL
SELECT COUNT(*) AS null_calculated_by_count
FROM sroi_calculation_runs
WHERE calculated_by IS NULL;

-- Cuenta ejecuciones de cálculo donde 'calculated_at' es NULL
SELECT COUNT(*) AS null_calculated_at_count
FROM sroi_calculation_runs
WHERE calculated_at IS NULL;
```

---

## 2. Búsqueda de Usos en el Código Fuente

Se realizó una búsqueda global mediante indexación de expresiones regulares en los directorios clave del proyecto (`app/`, `lib/`, `components/`):

*   **`total_value`**: **0 coincidencias** en el código fuente productivo. Solo aparece en migraciones históricas de Drizzle.
*   **`net_value`**: **0 coincidencias** en el código fuente productivo. Solo aparece en migraciones históricas de Drizzle.

**Conclusión:** Ambas columnas están completamente huérfanas en el código TypeScript y no se utilizan en la lógica de negocio ni en la renderización de reportes.

---

## 3. Borrador de Migración y Plan de Rollback

Dado que `db/schema.ts` ya no declara `total_value` ni `net_value`, pero sí declara `calculated_by` y `calculated_at` como `notNull()`, se propone la siguiente migración para alinear la base de datos remota.

### A. Migración de Aplicación (UP)
```sql
-- 1. Eliminar columnas obsoletas de manera segura
ALTER TABLE sroi_calculation_runs DROP COLUMN IF EXISTS total_value;
ALTER TABLE sroi_calculation_line_items DROP COLUMN IF EXISTS net_value;

-- 2. Backfill de datos históricos nulos para evitar fallos de restricción NOT NULL
UPDATE sroi_calculation_runs
SET calculated_by = created_by
WHERE calculated_by IS NULL;

UPDATE sroi_calculation_runs
SET calculated_at = created_at
WHERE calculated_at IS NULL;

-- 3. Aplicar restricción NOT NULL de forma segura
ALTER TABLE sroi_calculation_runs ALTER COLUMN calculated_by SET NOT NULL;
ALTER TABLE sroi_calculation_runs ALTER COLUMN calculated_at SET NOT NULL;
```

### B. Plan de Reversión (DOWN / Rollback)
```sql
-- 1. Restaurar columnas eliminadas con sus tipos de datos correspondientes
ALTER TABLE sroi_calculation_runs ADD COLUMN total_value numeric(20, 4);
ALTER TABLE sroi_calculation_line_items ADD COLUMN net_value numeric(20, 4);

-- 2. Eliminar restricción NOT NULL si es necesario revertir el esquema
ALTER TABLE sroi_calculation_runs ALTER COLUMN calculated_by DROP NOT NULL;
ALTER TABLE sroi_calculation_runs ALTER COLUMN calculated_at DROP NOT NULL;
```

---

## 4. Análisis de Riesgos de Pérdida de Información

1.  **Pérdida de datos físicos (`DROP COLUMN`):** Al ejecutar `DROP COLUMN` sobre `total_value` y `net_value`, cualquier dato almacenado históricamente en esas columnas se eliminará de forma irreversible. Dado que estas columnas no se usan ni se pueblan actualmente (se usa `snapshot_json` y cálculo en memoria de resultados SROI), el impacto en el negocio es nulo, pero la pérdida física ocurre.
2.  **Riesgo de bloqueo de despliegue (Constraint set NOT NULL):** Si se aplica `SET NOT NULL` a `calculated_by` y `calculated_at` sin realizar la fase intermedia de *backfill* descrita en el paso 2 de la migración UP, PostgreSQL rechazará la migración y provocará un fallo en el pipeline de despliegue si existen registros antiguos en base de datos.

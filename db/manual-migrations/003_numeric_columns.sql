-- Backlog #2 — money / quantity / ratio columns: varchar -> numeric.
--
-- Paired with the decimal-arithmetic engine rewrite (lib/pipeline/sroi-calculation.ts
-- now computes with decimal.js and persists exact decimal strings) and the
-- schema.ts change (these columns are now numeric()). This is the DB half.
--
-- Precheck (already run 2026-07-xx): 0 non-castable values across all columns.
-- Rerun before applying to any other environment — see below.
-- Reversible: numeric -> varchar via `ALTER COLUMN col TYPE varchar(255) USING col::text`.

-- ── PRECHECK: every value must be castable to numeric (must return 0 rows) ───
SELECT 'project_investments.amount' AS col, id, amount::text AS val
  FROM project_investments WHERE amount !~ '^-?[0-9]+(\.[0-9]+)?$'
UNION ALL
SELECT 'financial_proxies.value', id, value::text
  FROM financial_proxies WHERE value IS NOT NULL AND value !~ '^-?[0-9]+(\.[0-9]+)?$'
UNION ALL
SELECT 'sroi_assignment_inputs.quantity', id, quantity::text
  FROM sroi_assignment_inputs WHERE quantity !~ '^-?[0-9]+(\.[0-9]+)?$'
UNION ALL
SELECT 'sroi_calculation_runs.sroi_ratio', id, sroi_ratio::text
  FROM sroi_calculation_runs WHERE sroi_ratio IS NOT NULL AND sroi_ratio !~ '^-?[0-9]+(\.[0-9]+)?$';

-- ── APPLY (transactional; rolls back entirely on any error) ─────────────────
BEGIN;

-- The old CHECK constraints cast text->numeric (cast(nullif(col,'')...)); that
-- expression is invalid once the column itself is numeric, so drop first.
ALTER TABLE project_investments    DROP CONSTRAINT IF EXISTS project_investments_amount_check;
ALTER TABLE sroi_assignment_inputs DROP CONSTRAINT IF EXISTS sroi_assignment_inputs_quantity_check;

ALTER TABLE project_investments    ALTER COLUMN amount   TYPE numeric(20,4) USING nullif(amount, '')::numeric;
ALTER TABLE financial_proxies      ALTER COLUMN value    TYPE numeric(20,4) USING nullif(value, '')::numeric;
ALTER TABLE sroi_assignment_inputs ALTER COLUMN quantity TYPE numeric(20,4) USING nullif(quantity, '')::numeric;

ALTER TABLE sroi_calculation_runs
  ALTER COLUMN total_investment   TYPE numeric(20,4) USING nullif(total_investment, '')::numeric,
  ALTER COLUMN gross_social_value TYPE numeric(20,4) USING nullif(gross_social_value, '')::numeric,
  ALTER COLUMN net_social_value   TYPE numeric(20,4) USING nullif(net_social_value, '')::numeric,
  ALTER COLUMN sroi_ratio         TYPE numeric(20,6) USING nullif(sroi_ratio, '')::numeric;

ALTER TABLE sroi_calculation_line_items
  ALTER COLUMN quantity       TYPE numeric(20,4) USING nullif(quantity, '')::numeric,
  ALTER COLUMN proxy_value    TYPE numeric(20,4) USING nullif(proxy_value, '')::numeric,
  ALTER COLUMN gross_value    TYPE numeric(20,4) USING nullif(gross_value, '')::numeric,
  ALTER COLUMN adjusted_value TYPE numeric(20,4) USING nullif(adjusted_value, '')::numeric;

-- Re-add the range guards natively on the numeric columns.
ALTER TABLE project_investments    ADD CONSTRAINT project_investments_amount_check    CHECK (amount > 0);
ALTER TABLE sroi_assignment_inputs ADD CONSTRAINT sroi_assignment_inputs_quantity_check CHECK (quantity > 0);

COMMIT;

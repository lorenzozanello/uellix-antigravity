# Multi-Funder Investment, In-Kind Contributions & USD Normalization — Design

> This is Subproject A of a three-part initiative (A: this doc, B: NPV across investment timeframes, C: proxy database by project typology/socioeconomic context). B and C are separate specs, brainstormed and planned independently after A ships.

## Goal

Today, `project_investments` is a single row per project (upsert semantics): one amount, one currency, no concept of who funded it or whether it was cash or in-kind. This blocks two things Lorenzo needs:

1. Projects funded by multiple funders, some contributing cash and some contributing in-kind resources (volunteer time, donated goods/space), each wanting to know their own SROI ratio.
2. A calculation that always resolves to a single common currency (USD) regardless of what currency each contribution or proxy was originally denominated in, using the historical exchange rate (TRM) on the date of the contribution.

## Non-goals (deferred to later subprojects or follow-ups)

- NPV / temporal discounting across multi-year investment schedules — Subproject B.
- Building out the proxy catalog by project typology / socioeconomic context taxonomy — Subproject C.
- Live-rendered data tables in the PDF export for the funder breakdown (the new report section is narrative text, same pattern as `calculation_results` today). A future enhancement could render the raw breakdown as a table without further calculation-engine changes, since the data already lives in `snapshotJson`.

## Data model

### New table: `funders`

Per-organization catalog of funding entities, created inline ("select existing or create new") from the investment form — no separate management page for MVP.

```
funders
  id                uuid PK
  organization_id   uuid FK -> organizations.id, NOT NULL
  name              varchar(255) NOT NULL
  funder_type       varchar(50) NOT NULL   -- check IN ('public','private','foundation','multilateral','individual','other')
  created_by        uuid FK -> users.id, NOT NULL
  created_at        timestamp default now()
  updated_at        timestamp default now()
```

No approval workflow (unlike `financial_proxies`) — any org member with analyst role or above can create a funder. Not shared across organizations.

### Extend `project_investments`

Moves from single-row-per-project (upsert) to a list (multiple active rows per project), matching the existing `sroi_assignment_inputs` / `sroi_filter_sets` active/archived pattern.

New columns:

```
funder_id                uuid FK -> funders.id, NOT NULL
contribution_type        varchar(20) NOT NULL default 'cash'   -- check IN ('cash','in_kind')
in_kind_valuation_notes  text   -- check: NOT NULL when contribution_type = 'in_kind'
amount_usd               numeric   -- frozen at save time, see FX section below
fx_rate_id               uuid FK -> fx_rates.id, nullable       -- null when currency is already USD
```

`amount` / `currency` remain as originally entered — never overwritten, for audit trail.

Application code changes from "upsert the one row" to "insert new row / list active rows / archive a row" (`status: 'active' | 'archived'`, already exists on the table).

### New table: `outcome_funder_allocations`

Many-to-many attribution of funders to outcomes, with a percentage split. Managed in the Calculation step, in a new subsection below Investment.

```
outcome_funder_allocations
  id                uuid PK
  outcome_id        uuid FK -> outcomes.id, NOT NULL
  funder_id         uuid FK -> funders.id, NOT NULL
  organization_id   uuid FK -> organizations.id, NOT NULL
  allocation_pct    numeric NOT NULL   -- check: > 0 AND <= 100
  status            varchar(20) NOT NULL default 'active'   -- check IN ('active','archived')
  created_by        uuid FK -> users.id, NOT NULL
  created_at        timestamp default now()
  updated_at        timestamp default now()
```

Application-level validation (not a DB constraint, since it requires summing across rows): the sum of `allocation_pct` for a given `outcome_id`'s active allocations must not exceed 100%. It is allowed to be less than 100% — the unallocated remainder counts toward the project's total ratio but not toward any individual funder's ratio ("unattributed value").

Linking is at the **outcome** level, not the individual proxy-assignment level — if an outcome has multiple proxy assignments, they all inherit the same funder attribution automatically.

### New table: `fx_rates`

Reusable, cached lookup of historical exchange rates to USD.

```
fx_rates
  id                uuid PK
  currency          varchar(10) NOT NULL     -- source currency, e.g. 'COP'
  rate_date         date NOT NULL             -- the specific date this rate applies to
  rate_to_usd       numeric NOT NULL          -- units of `currency` per 1 USD (e.g. COP: 4150 means 4150 COP = 1 USD)
  source            text NOT NULL             -- citation, e.g. "Banco de la República (TRM oficial)" or a manual citation
  source_type       varchar(20) NOT NULL      -- check IN ('auto_fetched','manual')
  organization_id   uuid FK -> organizations.id, nullable   -- NULL for auto-fetched COP rates (shared/global, cached once); NOT NULL for manual entries of other currencies (org-scoped, so one org's typo can't corrupt another org's calculation)
  created_by        uuid FK -> users.id, nullable   -- null for system/auto-fetched rows
  created_at        timestamp default now()
```

Conversion formula: `amount_usd = amount / rate_to_usd`.

**COP auto-fetch:** during implementation, the implementer must identify and verify a live, publicly accessible historical TRM data source (e.g. the open TRM dataset on datos.gov.co, or Banco de la República's published data) before building against it — no endpoint is assumed correct without a live check. If the auto-fetch fails for a given date (source down, or no TRM published that day — weekends/holidays), the UI falls back to manual entry. The system never approximates or fabricates a rate.

**All other currencies:** always manual entry — user supplies `rate_to_usd` and a source citation, both required.

### Extend `financial_proxies`

Same FX pattern as investments, so the calculation's two sides (investment vs. social value) can both resolve to USD.

```
value_usd    numeric
fx_rate_id   uuid FK -> fx_rates.id, nullable
```

Date used for the FX lookup: **December 31 of the proxy's `reference_year`** (proxies only carry a year, not an exact date).

The existing `approved_proxy_check` constraint (which requires `value`, `currency`, `unit`, `reference_year` before `review_status = 'approved'`) is extended to also require `value_usd IS NOT NULL`.

### Extend `sroi_reports`

```
include_funder_breakdown   boolean NOT NULL default false
```

Chosen via a checkbox at report-draft creation time ("Incluir desglose financiero por financiador"). Immutable after creation, same as other report-anchoring decisions.

### Extend report section catalog (`lib/reports/report-sections.ts`)

New section type `funder_breakdown`, added to the `group-calculation` group after `calculation_results`:

```ts
funder_breakdown: {
  label: 'Desglose financiero por financiador',
  helper: 'Ratio SROI individual por financiador, valor social atribuido y valor sin atribuir. Vinculado a la corrida de cálculo inmutable.',
}
```

This section is only generated for a report when `include_funder_breakdown = true`. Report-section generation (currently a fixed `SECTION_ORDER` applied to every report) becomes conditional: reports without the flag get the current fixed list unchanged; reports with the flag get that list plus `funder_breakdown` inserted in its group position.

Like `calculation_results`, this is a narrative text section — the user writes it or asks Stella Composer to draft it. `lib/stella/context/build-composer-context.ts` is extended to include the per-funder breakdown data (from the calculation run's `snapshotJson`) when this section type is requested, the same way it already surfaces evidence/proxy references.

## Calculation engine changes (`lib/pipeline/sroi-calculation.ts`)

1. `loadCalculationData` loads **all active** `project_investments` rows for the project (not one), each already carrying `amount_usd`.
2. `totalInvestmentUsd` = sum of `amount_usd` across all active investment rows. Readiness blocks with `"Falta conversión a USD para N aporte(s)"` if any active row has `amount_usd IS NULL`.
3. Line-item calculation uses `proxy.value_usd` instead of `proxy.value`. Readiness blocks with `"Falta conversión a USD para N proxy(ies)"` if any assigned proxy lacks `value_usd`.
4. The existing "mixed currency" guard is removed — everything is normalized to USD before the ratio math, so original currencies no longer need to match each other.
5. **Overall project ratio** (unchanged formula, now always in USD): `netSocialValueUsd / totalInvestmentUsd`.
6. **Per-funder ratio** (new):
   - Group line items by `outcome_id`, sum `adjusted_value` (in USD) per outcome → `outcomeNsvUsd` map.
   - For each funder: sum `outcomeNsvUsd[outcomeId] * (allocation_pct / 100)` across every active `outcome_funder_allocations` row for that funder → `funderAttributedNsvUsd`.
   - Funder's own investment: sum of `amount_usd` across that funder's active `project_investments` rows → `funderInvestmentUsd`.
   - Funder's SROI ratio = `funderAttributedNsvUsd / funderInvestmentUsd` (0 if the funder has no attributed outcomes yet — a legitimate, non-error state).
7. **Unattributed value** = `netSocialValueUsd - sum(all funders' attributedNsvUsd)`. Surfaced in the snapshot and in the funder-breakdown report section, not treated as an error.
8. `snapshotJson` gains: `fundersBreakdown: [{ funderId, funderName, funderType, investmentUsd, attributedNsvUsd, sroiRatio }]`, `unattributedNsvUsd`, and per-contribution/per-proxy FX audit trail (`rateToUsd`, `rateDate`, `source`) for full transparency in the report.

## Readiness (`getSroiCalculationReadiness`)

- `hasInvestment` → becomes "at least one active investment row with `amount > 0`".
- New blocking reasons: missing USD conversion on investments, missing USD conversion on proxies, an outcome's active allocations summing over 100% (shouldn't be persistable in the first place per the application-level check on write, but readiness re-validates defensively).

## UI changes

- **Investment section** (Calculation step): single form → list, same visual pattern as "Agregar grupo de interés" (Stakeholders step). Each row: funder (select-or-create combobox, listing every funder in the organization, not just this project — a funder is expected to recur across multiple projects), contribution type (cash/in-kind), amount + currency, USD equivalent, edit/archive actions. Choosing a non-USD currency reveals the FX sub-form (auto-fetch attempt for COP with a manual-override affordance always visible; manual-only for every other currency). Choosing "in-kind" reveals the required valuation-notes field.
- **Funder↔outcome attribution** (Calculation step, new subsection below Investment): list of the project's outcomes; each shows its current funder allocations (name + %) and a form to add one, with the remaining available percentage shown.
- **Proxy admin form** (`/admin/proxies`): gains the same FX sub-form, using Dec 31 of the proxy's reference year as the lookup date. The approval action is blocked until `value_usd` is present, same as it's already blocked without `value`/`currency`/`unit`/`reference_year`.
- **Calculation results card**: adds a per-funder breakdown table (investment, attributed value, individual ratio) below the existing overall-ratio summary, plus an "unattributed value" line when applicable, plus the FX rates/sources used (for audit transparency).
- **Report draft creation form**: new checkbox "Incluir desglose financiero por financiador".

## Migration & backward compatibility

- `funders`: new table, no backfill needed.
- `project_investments`: existing rows get `funder_id` backfilled to a per-organization placeholder funder ("Financiador no especificado", `funder_type = 'other'`, auto-created during migration) and `contribution_type = 'cash'` (nothing in-kind existed before this feature). For rows already in USD: `amount_usd = amount`, `fx_rate_id = NULL`. For rows in a non-USD currency (if any exist): `amount_usd` and `fx_rate_id` stay `NULL` — no retroactive fabrication of a historical rate — and that project's readiness will surface the new "missing USD conversion" blocker until a human supplies it.
- `financial_proxies`: same treatment for existing non-USD rows — `value_usd` stays `NULL`, surfaced as a calculation blocker if that proxy is used in an active assignment. `review_status` is not silently changed for already-approved proxies (the DB constraint only applies going forward to new approval transitions; a migration-time backfill does not retroactively revoke approval).
- `outcome_funder_allocations`: new table, empty after migration (no historical attribution data exists to infer from) — every existing project shows 100% "unattributed" per outcome until a human assigns attribution, which does not block calculation (attribution is optional; only the per-funder ratios are affected, not the overall project ratio).

## Testing

Following the project's established patterns:

- Cross-org isolation tests for `funders`, `outcome_funder_allocations`, `fx_rates` (an org must never read/write another org's rows).
- Calculation engine unit tests: USD summation across multiple funders/currencies, per-funder ratio math (including the zero-attribution case), unattributed-value math, allocation-percentage-over-100 rejection, in-kind-requires-valuation-notes constraint, approved-proxy-requires-value-usd constraint, readiness blocking on missing FX conversion.
- FX auto-fetch: unit tests against a mocked HTTP client (never call the real external source in tests), plus a manual-entry-fallback test for when auto-fetch fails.
- Report generation: a report created with `include_funder_breakdown = false` does not include the `funder_breakdown` section; one created with `true` does.

## Open implementation risk to flag in the plan

The exact COP TRM data source (endpoint, response shape, rate limits, availability window) is unverified as of this spec — the first implementation task must include a live spike to confirm a working, free, publicly accessible source before the auto-fetch code is built against it. If no reliable free source can be confirmed, the plan should fall back to manual-only entry for all currencies including COP, and this spec's "hybrid" approach becomes "manual for everything" without further design changes needed (the `fx_rates` table and UI already support manual entry for any currency).

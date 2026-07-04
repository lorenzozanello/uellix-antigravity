# Manual migrations — pipeline integrity hardening

These SQL scripts back the DB-level items of the pipeline integrity audit. They
are **NOT** in the Drizzle journal (`db/migrations/`) on purpose: the Drizzle
snapshot currently has known drift that blocks `db:generate`, and these changes
(constraints, triggers, a column-type conversion on live financial data) are too
sensitive to apply blindly through `db:migrate`.

**Apply them by hand** (psql or the Supabase SQL editor), in order, each only
after running the `-- PRECHECK` query at the top and confirming it returns no
blocking rows. Once the Drizzle drift is resolved, fold the equivalent DDL into
`schema.ts` + a generated migration so the model and the DB agree again.

| Script | Backlog item | Risk | Auto-applied? |
|--------|--------------|------|---------------|
| `001_unique_constraints.sql` | #7 dup assignments / version race | Low (additive) — fails if dups already exist | No |
| `002_append_only.sql` | #4 append-only audit / runs | Medium — blocks UPDATE/DELETE forever | No |
| `003_numeric_columns.sql` | #2 varchar → numeric money | **High — irreversible on live data** | No — needs explicit sign-off |

Item #2 additionally needs an application-layer decision (decimal arithmetic in
the SROI engine, likely a new dependency) before it delivers full value —
`postgres`/Drizzle return `numeric` as a JS string, so the column change alone
fixes storage precision but not the float math in `runDeterministicCalc`.

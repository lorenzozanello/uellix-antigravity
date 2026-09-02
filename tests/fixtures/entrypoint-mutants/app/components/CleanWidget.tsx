// NEGATIVE CONTROL — a pure presentational component: props in, JSX out.
// Cannot reach the database, so it is never even a checked module.
import type { FixtureRow } from '../../db/client'

export function CleanWidget({ rows }: { rows: FixtureRow[] }) {
  if (rows.length === 0) return <p>sin datos</p>
  return <ul>{rows.map((row) => <li key={row.id}>{row.id}</li>)}</ul>
}

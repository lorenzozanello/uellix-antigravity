// FORM 1 — the exact shape OutcomeAllocationWrapper shipped with: an async
// server component that queries during streaming render, outside any identity
// context, and silently disappears when RLS returns zero rows.
import { listThings } from '../../lib/service'

export async function LeakyWidget() {
  const rows = await listThings()
  if (rows.length === 0) return null
  return <ul>{rows.map((row) => <li key={row.id}>{row.id}</li>)}</ul>
}

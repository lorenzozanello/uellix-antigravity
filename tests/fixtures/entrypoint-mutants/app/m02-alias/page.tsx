// FORM 2 — aliased import: the dangerous symbol never appears under its own
// name in this file.
import { listThings as fetchRows } from '../../lib/service'

export default async function Page() {
  const rows = await fetchRows()
  return <p>{rows.length}</p>
}

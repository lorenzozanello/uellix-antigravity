// FORM 5 — transitive local helper: the render path calls loadAll(), which is
// defined in this file and is where the tainted call actually lives.
import { listThings } from '../../lib/service'

async function loadAll() {
  return listThings()
}

export default async function Page() {
  const rows = await loadAll()
  return <p>{rows.length}</p>
}

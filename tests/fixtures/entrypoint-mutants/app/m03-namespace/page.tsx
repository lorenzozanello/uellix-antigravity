// FORM 3 — namespace import: `svc.listThings()` matches no per-symbol regex.
import * as svc from '../../lib/service'

export default async function Page() {
  const rows = await svc.listThings()
  return <p>{rows.length}</p>
}

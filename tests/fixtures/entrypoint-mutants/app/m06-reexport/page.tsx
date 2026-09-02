// FORM 6 — re-export barrel: this page never names lib/service.
import { listThings } from '../../lib/barrel'

export default async function Page() {
  const rows = await listThings()
  return <p>{rows.length}</p>
}

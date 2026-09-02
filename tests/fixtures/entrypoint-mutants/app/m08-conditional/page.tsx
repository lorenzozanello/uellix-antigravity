// FORM 8 — conditional wrapper: one branch is guarded, the other is not.
import { runWithOrganizationAccess } from '../../lib/session'
import { listThings } from '../../lib/service'

export default async function Page({ guarded }: { guarded?: boolean }) {
  if (guarded) {
    const rows = await runWithOrganizationAccess(() => listThings())
    return <p>{rows.length}</p>
  }
  const rows = await listThings()
  return <p>{rows.length}</p>
}

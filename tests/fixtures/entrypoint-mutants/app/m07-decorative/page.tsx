// FORM 7 — decorative wrapper: the opener IS called, so any "does the file
// mention an opener" check passes. The database work runs outside it.
import { runWithOrganizationAccess } from '../../lib/session'
import { listThings } from '../../lib/service'

export default async function Page() {
  await runWithOrganizationAccess(async () => {
    /* nothing — decoration */
  })
  const rows = await listThings()
  return <p>{rows.length}</p>
}

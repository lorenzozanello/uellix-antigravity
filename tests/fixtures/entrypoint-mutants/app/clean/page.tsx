// NEGATIVE CONTROL — the correct shape: every database usage sits inside the
// opener's callback, and the child component receives data as props. The
// scanner must report NOTHING for this page.
import { runWithOrganizationAccess } from '../../lib/session'
import { listThings } from '../../lib/service'
import { CleanWidget } from '../components/CleanWidget'

export default async function Page() {
  const rows = await runWithOrganizationAccess(async () => listThings())
  return <CleanWidget rows={rows} />
}

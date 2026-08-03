// FORM 1 (usage side): the page renders a database-reaching server component.
// No call expression anywhere — the query happens inside the JSX child.
import { LeakyWidget } from '../components/LeakyWidget'

export default async function Page() {
  return (
    <main>
      <LeakyWidget />
    </main>
  )
}

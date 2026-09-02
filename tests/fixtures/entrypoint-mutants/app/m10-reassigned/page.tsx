// FORM 10 — reassignment: `database.` matches no `\bdb\s*\.` regex.
import { db } from '../../db/client'

export default async function Page() {
  const database = db
  const rows = await database.select()
  return <p>{rows.length}</p>
}

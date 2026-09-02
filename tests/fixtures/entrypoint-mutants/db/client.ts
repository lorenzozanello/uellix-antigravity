// Fixture database client. Mirrors the real db/client.ts SHAPE (a `db` export
// plus a driver import) without ever connecting: the scanner only parses.
import postgres from 'postgres'

export type FixtureRow = { id: string }

export const db = {
  select: async (): Promise<FixtureRow[]> => [],
  sql: null as unknown as ReturnType<typeof postgres>,
}

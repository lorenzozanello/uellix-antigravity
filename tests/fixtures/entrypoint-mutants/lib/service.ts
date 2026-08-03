// Fixture service: reaches the database client, opens no context — exactly
// like a real lib/** service that relies on its caller's identity context.
import { db, type FixtureRow } from '../db/client'

export async function listThings(): Promise<FixtureRow[]> {
  return db.select()
}

export async function countThings(): Promise<number> {
  return (await db.select()).length
}

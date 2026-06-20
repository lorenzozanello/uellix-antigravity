import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

const connectionString = process.env.DATABASE_URL!

// Disable prepare as it is not supported for "Transaction" pool mode in Supabase
const client = postgres(connectionString, { prepare: false })
export const db = drizzle(client, { schema })

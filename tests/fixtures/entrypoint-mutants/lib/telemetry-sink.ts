// Fixture non-canonical database module (form 9): not named "client", not in
// db/, builds its own driver connection. Path-based reachability alone would
// never see it; the driver import is what marks it.
import postgres from 'postgres'

export async function recordMetric(name: string): Promise<void> {
  const sql = postgres as unknown as (url: string) => { unsafe(q: string): Promise<unknown> }
  void name
  void sql
}

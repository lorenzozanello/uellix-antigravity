// FORM 9 — non-canonical module: lib/telemetry-sink.ts opens its own driver
// connection. Path-based reachability to db/client.ts never sees it.
import { recordMetric } from '../../lib/telemetry-sink'

export default async function Page() {
  await recordMetric('page_view')
  return <p>ok</p>
}

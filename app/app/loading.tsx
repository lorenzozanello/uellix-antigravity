// app/app/loading.tsx
// RE-U1 U1-F06: every page under app/app/** is an async Server Component with
// zero loading.tsx anywhere in the tree, so a slow query (evidence, a
// calculation run, portfolio aggregation) silently retained the previous
// page instead of giving feedback. One boundary here — the segment root for
// the whole authenticated workspace — covers dashboard, projects, portfolios,
// trust-center and organization/** without per-route duplication, reusing the
// existing LoadingState primitive instead of introducing a new one.

import { LoadingState } from '@/components/states/LoadingState'

export default function AppLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <LoadingState />
    </div>
  )
}

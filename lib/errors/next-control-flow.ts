// lib/errors/next-control-flow.ts
//
// `redirect()` and `notFound()` do not return — they THROW. Next.js catches the
// thrown value at the framework boundary and turns it into a navigation.
//
// Any `catch` between the call and that boundary intercepts it. A server action
// that wraps its work in `try { … } catch (err) { return { error: err.message } }`
// therefore turns an expired session into a toast reading `NEXT_REDIRECT` on a
// page that will never navigate. The same applies to `notFound()`, to
// `forbidden()`/`unauthorized()`, and to the promise React throws for Suspense.
//
// `unstable_rethrow` is Next's own predicate for "this is framework control
// flow, not an application error". It is re-exported through this module rather
// than imported directly at ~6 call sites so that the day its name settles —
// it is `unstable_` for a reason — there is one import to change.

import { unstable_rethrow } from 'next/navigation'

/**
 * Call FIRST in any `catch` that swallows or transforms errors.
 *
 * Re-throws framework control flow and returns normally for anything else, so
 * the surrounding handler keeps its own behaviour for real failures.
 */
export function rethrowNextControlFlow(error: unknown): void {
  unstable_rethrow(error)
}

// app/not-found.tsx
//
// RE-U1 U1-F16 — SAFE_NOW explanation surface only.
//
// notFound() is called from both public routes (app/(public)/verify/[hash])
// and authenticated ones (report/[reportId], report/[reportId]/print,
// pipeline/calculation/runs/[runId]). Before this file, none of them had a
// governed not-found.tsx anywhere in the tree, so every one of those calls
// fell through to Next.js's unbranded default 404 — measured most visibly on
// the public report-verification page, the single most trust-sensitive
// surface in the product.
//
// This is deliberately the ROOT boundary (app/not-found.tsx), not a
// public-segment or authenticated-segment one: it's the smallest file that
// covers every notFound() call above, because Next.js walks up to the
// nearest not-found.tsx and none of the segments in between define their
// own. It renders inside app/layout.tsx only (fonts/html/body — no
// Sidebar/TopBar, no marketing Navbar), which is exactly right here: this
// page must not assume an authenticated session OR a public visitor, so it
// carries no session-dependent chrome and no claim about which case it is.
//
// What this file explicitly does NOT do, per RE-U0 F1 and the RE-U1-M
// coordinator disposition: it does not touch getPublicVerifiedReport, RLS,
// report disclosure logic or report versions, and closing U1-F16 here means
// only "the explanation is now governed and branded" — NOT "public
// verification works." That remains WAIT_FOR_LATER_FIB. The copy below is
// worded to avoid asserting that a report/run ever existed, and makes no
// certification claim.

import Link from 'next/link'
import { FileQuestion } from 'lucide-react'

export const metadata = {
  title: 'Contenido no disponible',
  robots: { index: false, follow: false },
}

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-16 text-center font-manrope">
      <FileQuestion className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">
        Contenido no disponible
      </h1>
      <p className="mt-3 max-w-md text-sm text-muted-foreground">
        El enlace no es válido, el contenido ya no está disponible, o no tenés acceso a él.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
      >
        Ir al inicio de Uellix
      </Link>
    </div>
  )
}

'use client'

import { Printer } from 'lucide-react'

/**
 * Triggers the browser's native print dialog, from which the user can
 * "Save as PDF". Dependency-free PDF export — no server-side PDF renderer.
 * Hidden in the actual print output via the `print:hidden` utility.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors print:hidden"
    >
      <Printer className="h-4 w-4" aria-hidden="true" />
      Imprimir / Guardar PDF
    </button>
  )
}

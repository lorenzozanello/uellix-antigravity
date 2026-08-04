'use client'
// components/stella/StellaEvidencePanel.tsx
// PRODUCT TRAIN 1 -- renders a claim's citations. Purely presentational: the
// panel never scrolls/highlights anything itself. When the caller supplies
// onNavigate, chips become buttons and the caller (the page, which knows the
// DOM layout) decides what "navigate to this source" means.

import { cn } from '@/lib/utils'
import type { EvidenceReference } from './grounding-model'

export interface StellaEvidencePanelProps {
  references: readonly EvidenceReference[]
  /** Shown when references is empty. Defaults to a neutral Spanish message. */
  emptyLabel?: string
  /** When provided, each chip becomes a button that calls this with the clicked reference. */
  onNavigate?: (reference: EvidenceReference) => void
  className?: string
}

export function StellaEvidencePanel({ references, emptyLabel, onNavigate, className }: StellaEvidencePanelProps) {
  if (references.length === 0) {
    return (
      <p data-testid="stella-evidence-panel-empty" className={cn('text-xs text-muted-foreground italic', className)}>
        {emptyLabel ?? 'Stella no citó ninguna fuente para esta afirmación.'}
      </p>
    )
  }

  const chipClass =
    'inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground'

  return (
    <ul aria-label="Fuentes" className={cn('flex flex-wrap gap-1', className)}>
      {references.map((reference, i) => (
        <li key={`${reference.sourceField}-${i}`}>
          {onNavigate ? (
            <button
              type="button"
              title={reference.sourceField}
              className={cn(
                chipClass,
                'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
              onClick={() => onNavigate(reference)}
            >
              {reference.label}
            </button>
          ) : (
            <span title={reference.sourceField} className={chipClass}>
              {reference.label}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

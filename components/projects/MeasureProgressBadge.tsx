import Link from 'next/link'
import { ArrowRight, FolderMinus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { MeasureProgress } from '@/lib/projects/service'

interface MeasureProgressBadgeProps {
  projectId: string
  projectName: string
  progress: MeasureProgress
  /**
   * projects.portfolio_id IS NULL. Informational only (F-MEASURE-W3-2): it
   * renders a marker and nothing else — no filtering, no ordering, no CTA that
   * could mutate portfolio membership.
   */
  unassignedToPortfolio?: boolean
  /**
   * The dashboard cards are dense summaries and omit the next-action line; the
   * projects page shows it. Both read the same `progress` object either way.
   */
  showNextAction?: boolean
}

/**
 * Renders one project's Measure state, plus the next meaningful action.
 *
 * Purely presentational and role-blind: it is handed an already-derived
 * MeasureProgress and never consults a role, a capability or a readiness
 * surface. Every authorized viewer of a project sees the same badge for it.
 */
export function MeasureProgressBadge({
  projectId,
  projectName,
  progress,
  unassignedToPortfolio = false,
  showNextAction = true,
}: MeasureProgressBadgeProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={progress.variant}>{progress.label}</Badge>
        {unassignedToPortfolio && (
          <Badge variant="neutral" title="Este proyecto no pertenece a ningún portafolio">
            <FolderMinus className="h-3 w-3 shrink-0" aria-hidden="true" />
            Sin portafolio
          </Badge>
        )}
      </div>

      {showNextAction &&
        (progress.nextActionPath ? (
          <Link
            href={`/app/projects/${projectId}${progress.nextActionPath}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-label={`${progress.nextActionLabel} — ${projectName}`}
          >
            {progress.nextActionLabel}
            <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          </Link>
        ) : (
          // `bloqueado` has no navigable next step: the project is paused or has
          // a pending deletion request, and resolving either is a lifecycle
          // decision made elsewhere. Say so instead of offering a dead link.
          <p className="text-xs text-muted-foreground">{progress.nextActionLabel}</p>
        ))}
    </div>
  )
}

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Segments that are purely structural — collapsed in the breadcrumb trail
const SKIP_SEGMENTS = new Set(['app', 'runs'])

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  projects: 'SROI Projects',
  pipeline: 'Pipeline',
  narrative: 'Narrative',
  stakeholders: 'Stakeholders',
  outcomes: 'Outcomes',
  indicators: 'Indicators',
  evidence: 'Evidence',
  proxies: 'Proxy Intelligence',
  calculation: 'SROI Calculation',
  compare: 'Compare Runs',
  report: 'Reports',
  'trust-center': 'Trust Center',
  portfolios: 'Portfolios',
  new: 'New',
  onboarding: 'Onboarding',
}

/** Returns a human label for a UUID segment, based on the preceding segment. */
function labelForDynamicSegment(prevSegment: string | undefined): string {
  switch (prevSegment) {
    case 'projects': return 'Project'
    case 'runs': return 'Run Detail'
    case 'report': return 'Report'
    default: return 'Detail'
  }
}

interface BreadcrumbItem {
  label: string
  href: string
  isCurrent: boolean
}

function buildBreadcrumbs(pathname: string): BreadcrumbItem[] {
  const parts = pathname.split('/').filter(Boolean)
  const items: BreadcrumbItem[] = []
  let accumulated = ''
  let prevSegment: string | undefined

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i]
    accumulated += '/' + segment

    if (SKIP_SEGMENTS.has(segment)) {
      prevSegment = segment
      continue
    }

    const isLast = i === parts.length - 1
    let label: string

    if (UUID_RE.test(segment)) {
      label = labelForDynamicSegment(prevSegment)
    } else {
      label = SEGMENT_LABELS[segment] ?? segment
    }

    items.push({ label, href: accumulated, isCurrent: isLast })
    prevSegment = segment
  }

  return items
}

export function Breadcrumbs() {
  const pathname = usePathname()
  const items = buildBreadcrumbs(pathname ?? '')

  if (items.length <= 1) return null

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
        {items.map((item, idx) => (
          <li key={item.href} className="flex items-center gap-1">
            {idx > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            )}
            {item.isCurrent ? (
              <span
                aria-current="page"
                className="font-medium text-foreground truncate max-w-[180px]"
              >
                {item.label}
              </span>
            ) : (
              <Link
                href={item.href}
                className="hover:text-foreground transition-colors truncate max-w-[180px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                {item.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

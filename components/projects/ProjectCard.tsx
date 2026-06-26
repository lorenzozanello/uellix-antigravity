import Link from 'next/link'
import { ArrowRight, Calendar, MapPin } from 'lucide-react'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

type ProjectStatus = 'draft' | 'active' | 'completed' | 'archived'

const STATUS_CONFIG: Record<ProjectStatus, { variant: 'neutral' | 'teal' | 'success'; label: string }> = {
  draft: { variant: 'neutral', label: 'Draft' },
  active: { variant: 'teal', label: 'Active' },
  completed: { variant: 'success', label: 'Completed' },
  archived: { variant: 'neutral', label: 'Archived' },
}

interface ProjectCardProps {
  id: string
  name: string
  description?: string | null
  status: string
  territory?: string | null
  country?: string | null
  startDate?: Date | string | null
}

export function ProjectCard({ id, name, description, status, territory, country, startDate }: ProjectCardProps) {
  const config = STATUS_CONFIG[status as ProjectStatus] ?? { variant: 'neutral' as const, label: status }
  const locationLabel = [territory, country].filter(Boolean).join(' · ')
  const dateLabel = startDate
    ? new Date(startDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
    : null

  return (
    <Card className="flex flex-col hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base leading-snug line-clamp-2">{name}</CardTitle>
          <Badge variant={config.variant} className="shrink-0">
            {config.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-1.5 pb-3">
        {description && (
          <p className="text-sm text-muted-foreground line-clamp-2">{description}</p>
        )}
        {locationLabel && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" aria-hidden="true" />
            {locationLabel}
          </p>
        )}
        {dateLabel && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3 shrink-0" aria-hidden="true" />
            Started {dateLabel}
          </p>
        )}
      </CardContent>

      <CardFooter className="gap-3 border-t border-border pt-3">
        <Link
          href={`/app/projects/${id}`}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          Details
        </Link>
        <Link
          href={`/app/projects/${id}/pipeline`}
          className="ml-auto flex items-center gap-1 text-sm font-medium text-teal-700 hover:text-teal-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          aria-label={`Open SROI pipeline for ${name}`}
        >
          Open Pipeline
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </CardFooter>
    </Card>
  )
}

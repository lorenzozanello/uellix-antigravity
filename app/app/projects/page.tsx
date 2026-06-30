import Link from 'next/link'
import { Plus, FolderKanban } from 'lucide-react'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { listProjectsForCurrentOrganization } from '@/lib/projects/service'
import { ProjectCard } from '@/components/projects/ProjectCard'
import { EmptyState } from '@/components/states/EmptyState'

export default async function ProjectsPage() {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) return <p>Unauthenticated. Please log in.</p>

  const projects = await listProjectsForCurrentOrganization()

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(
    ctx.membership.role
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">SROI Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {projects.length} project{projects.length !== 1 ? 's' : ''} in {ctx.organization.name}
          </p>
        </div>
        {canCreate && (
          <Link
            href="/app/projects/new"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            New Project
          </Link>
        )}
      </div>

      {/* Content */}
      {projects.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            icon={<FolderKanban className="h-6 w-6 text-neutral-500" />}
            title="No SROI projects yet"
            description="Each project walks your team through the full SROI pipeline — from theory of change to a defensible impact ratio."
          />
          {canCreate && (
            <div className="flex justify-center">
              <Link
                href="/app/projects/new"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Create First Project
              </Link>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              id={project.id}
              name={project.name}
              description={project.description}
              status={project.status}
              territory={project.territory}
              country={project.country}
              startDate={project.startDate}
            />
          ))}
          {canCreate && (
            <Link
              href="/app/projects/new"
              className="flex min-h-[160px] items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm font-medium text-muted-foreground hover:border-[#B85200]/40 hover:text-[#B85200] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Create new SROI project"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New Project
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

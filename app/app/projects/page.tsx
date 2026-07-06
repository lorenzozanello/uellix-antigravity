import Link from 'next/link'
import { Plus, FolderKanban } from 'lucide-react'
import { getCurrentOrganizationContext } from '@/lib/auth/session'
import { listProjectsForCurrentOrganization } from '@/lib/projects/service'
import { ProjectCard } from '@/components/projects/ProjectCard'
import { EmptyState } from '@/components/states/EmptyState'

export default async function ProjectsPage() {
  const ctx = await getCurrentOrganizationContext()
  if (!ctx) return <p>No autenticado. Por favor inicia sesión.</p>

  const projects = await listProjectsForCurrentOrganization()

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(
    ctx.membership.role
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Proyectos SROI</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {projects.length} proyecto{projects.length !== 1 ? 's' : ''} en {ctx.organization.name}
          </p>
        </div>
        {canCreate && (
          <Link
            href="/app/projects/new"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Nuevo proyecto
          </Link>
        )}
      </div>

      {/* Content */}
      {projects.length === 0 ? (
        <div className="space-y-4">
          <EmptyState
            icon={<FolderKanban className="h-6 w-6 text-neutral-500" />}
            title="Aún no hay proyectos SROI"
            description="Cada proyecto guía a tu equipo por el pipeline SROI completo — desde la teoría del cambio hasta un ratio de impacto defendible."
          />
          {canCreate && (
            <div className="flex justify-center">
              <Link
                href="/app/projects/new"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Crear primer proyecto
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
              userRole={ctx.membership.role}
            />
          ))}
          {canCreate && (
            <Link
              href="/app/projects/new"
              className="flex min-h-[160px] items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm font-medium text-muted-foreground hover:border-[#B85200]/40 hover:text-[#B85200] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Crear nuevo proyecto SROI"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nuevo proyecto
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

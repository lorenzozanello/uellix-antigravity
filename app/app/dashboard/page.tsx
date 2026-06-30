import Link from 'next/link'
import { FolderKanban, ShieldCheck, ArrowRight, Plus } from 'lucide-react'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { ROLE_LABELS } from '@/lib/auth/roles'
import { listProjectsForCurrentOrganization } from '@/lib/projects/service'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/states/EmptyState'

const STATUS_BADGE: Record<string, { variant: 'neutral' | 'accent' | 'success'; label: string }> = {
  draft: { variant: 'neutral', label: 'Draft' },
  active: { variant: 'accent', label: 'Active' },
  completed: { variant: 'success', label: 'Completed' },
  archived: { variant: 'neutral', label: 'Archived' },
}

export default async function DashboardPage() {
  const { organization, membership } = await requireOrganizationAccess()
  const projects = await listProjectsForCurrentOrganization()

  const roleLabel = ROLE_LABELS[membership.role] ?? membership.role
  const activeProjects = projects.filter((p) => p.status === 'active')
  const recentProjects = projects.slice(0, 6)

  const canCreate = ['super_admin', 'organization_admin', 'impact_manager', 'analyst'].includes(
    membership.role
  )

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {organization.name}
          <span aria-hidden="true"> · </span>
          <span className="capitalize">{roleLabel}</span>
        </p>
      </div>

      {/* KPI metrics */}
      <section aria-labelledby="overview-heading">
        <h2
          id="overview-heading"
          className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Overview
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {/* Active projects */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Active Projects</p>
                  <p className="mt-1 text-3xl font-bold tracking-tight text-foreground">
                    {activeProjects.length}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {projects.length} total
                  </p>
                </div>
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#FF6A00]/10 text-[#FF6A00]"
                  aria-hidden="true"
                >
                  <FolderKanban className="h-5 w-5" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Role context */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted-foreground">Your Role</p>
                  <p className="mt-1 text-xl font-bold tracking-tight text-foreground capitalize truncate">
                    {roleLabel}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground truncate">
                    {organization.name}
                  </p>
                </div>
                <Badge variant="accent" className="shrink-0 mt-0.5">
                  {membership.role}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {/* Trust Center quick access */}
          <Card>
            <CardContent className="p-6">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Trust Center</p>
                  <p className="mt-1 text-sm text-muted-foreground leading-snug">
                    Audit documentation &amp; evidence repository
                  </p>
                </div>
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                  aria-hidden="true"
                >
                  <ShieldCheck className="h-5 w-5" />
                </div>
              </div>
              <Link
                href="/app/trust-center"
                className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                Open Trust Center
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* SROI Projects list */}
      <section aria-labelledby="projects-heading">
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="projects-heading"
            className="text-xs font-semibold uppercase tracking-widest text-muted-foreground"
          >
            SROI Projects
          </h2>
          {projects.length > 0 && (
            <Link
              href="/app/projects"
              className="text-sm font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              View all →
            </Link>
          )}
        </div>

        {projects.length === 0 ? (
          <div className="space-y-4">
            <EmptyState
              icon={<FolderKanban className="h-6 w-6 text-neutral-500" />}
              title="No SROI projects yet"
              description="Create your first project to start building audit-ready social impact evidence."
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {recentProjects.map((project) => {
              const badge = STATUS_BADGE[project.status] ?? { variant: 'neutral' as const, label: project.status }
              return (
                <Card key={project.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <p className="font-medium text-sm leading-snug line-clamp-2 text-foreground">
                        {project.name}
                      </p>
                      <Badge variant={badge.variant} className="shrink-0 text-xs">
                        {badge.label}
                      </Badge>
                    </div>
                    <Link
                      href={`/app/projects/${project.id}/pipeline`}
                      className="mt-3 flex items-center gap-1 text-xs font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                      aria-label={`Open pipeline for ${project.name}`}
                    >
                      Open Pipeline
                      <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </CardContent>
                </Card>
              )
            })}
            {canCreate && (
              <Link
                href="/app/projects/new"
                className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-sm font-medium text-muted-foreground hover:border-[#B85200]/40 hover:text-[#B85200] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Create new SROI project"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                New Project
              </Link>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

import React from 'react'
import { db } from '@/db/client'
import { projects } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { listEvidenceForOrganizationWithProject } from '@/lib/pipeline/evidence'
import Link from 'next/link'
import { Filter, ShieldCheck } from 'lucide-react'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/states/EmptyState'

const EVIDENCE_STATUS: Record<
  string,
  { variant: 'neutral' | 'warning' | 'info' | 'success' | 'danger'; label: string }
> = {
  draft: { variant: 'neutral', label: 'Draft' },
  under_review: { variant: 'info', label: 'Under Review' },
  approved: { variant: 'success', label: 'Approved' },
  rejected: { variant: 'danger', label: 'Rejected' },
  archived: { variant: 'neutral', label: 'Archived' },
}

const EVIDENCE_TYPE: Record<
  string,
  { variant: 'neutral' | 'info' | 'teal'; label: string }
> = {
  file: { variant: 'neutral', label: 'File' },
  url: { variant: 'info', label: 'URL' },
  text: { variant: 'neutral', label: 'Text' },
}

export default async function TrustCenterPage({
  searchParams,
}: {
  searchParams: { status?: string; type?: string; projectId?: string }
}) {
  const { organization } = await requireOrganizationAccess()

  const orgProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, organization.id))

  const evidences = await listEvidenceForOrganizationWithProject()

  const statusFilter = searchParams.status || ''
  const typeFilter = searchParams.type || ''
  const projectFilter = searchParams.projectId || ''

  const filteredEvidences = evidences.filter((ev) => {
    if (statusFilter && ev.status !== statusFilter) return false
    if (typeFilter && ev.type !== typeFilter) return false
    if (projectFilter && ev.projectId !== projectFilter) return false
    return true
  })

  const activeFilterCount = [statusFilter, typeFilter, projectFilter].filter(Boolean).length

  return (
    <div className="space-y-6 max-w-7xl">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-600"
          aria-hidden="true"
        >
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Trust Center</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Audit-ready evidence repository for{' '}
            <span className="font-medium text-foreground">{organization.name}</span>. Each
            evidence item carries a SHA-256 content hash and requires human review before use
            in external reporting.
          </p>
        </div>
      </div>

      {/* Methodology notice */}
      <div
        role="note"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        <span className="font-medium text-foreground">Audit notice: </span>
        Evidence registered here does not constitute automatic certification or audit clearance.
        Each item provides a{' '}
        <span className="font-medium text-foreground">traceable evidence foundation</span> for
        methodological review and requires human validation before external use.
      </div>

      {/* Filters */}
      <form
        method="GET"
        action="/app/trust-center"
        className="rounded-lg border border-border bg-muted/30 p-4"
        aria-label="Filter evidence"
      >
        <div className="mb-3 flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Filters
          </span>
          {activeFilterCount > 0 && (
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-teal-600 text-[10px] font-bold text-white"
              aria-label={`${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} active`}
            >
              {activeFilterCount}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="projectId" className="block text-xs font-medium text-foreground">
              Project
            </label>
            <Select
              id="projectId"
              name="projectId"
              defaultValue={projectFilter}
              className="mt-1"
            >
              <option value="">All projects</option>
              {orgProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label htmlFor="status" className="block text-xs font-medium text-foreground">
              Review status
            </label>
            <Select
              id="status"
              name="status"
              defaultValue={statusFilter}
              className="mt-1"
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="under_review">Under Review</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="archived">Archived</option>
            </Select>
          </div>

          <div>
            <label htmlFor="type" className="block text-xs font-medium text-foreground">
              Evidence type
            </label>
            <Select
              id="type"
              name="type"
              defaultValue={typeFilter}
              className="mt-1"
            >
              <option value="">All types</option>
              <option value="file">File</option>
              <option value="url">URL</option>
              <option value="text">Text / Statement</option>
            </Select>
          </div>

          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="inline-flex items-center rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
            >
              Apply
            </button>
            <Link
              href="/app/trust-center"
              className="inline-flex items-center rounded-md border border-border bg-background px-4 py-1.5 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Clear
            </Link>
          </div>
        </div>
      </form>

      {/* Result count */}
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {filteredEvidences.length === evidences.length
          ? `${evidences.length} evidence item${evidences.length !== 1 ? 's' : ''}`
          : `${filteredEvidences.length} of ${evidences.length} evidence items`}
        {activeFilterCount > 0 ? ' matching current filters' : ''}
      </p>

      {/* Evidence table */}
      {filteredEvidences.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck className="h-6 w-6 text-neutral-500" />}
          title="No evidence found"
          description={
            activeFilterCount > 0
              ? 'No items match the selected filters. Adjust or clear filters to see all evidence.'
              : 'No traceable evidence has been registered for this organization yet.'
          }
        />
      ) : (
        <section aria-labelledby="evidence-table-heading">
          <h2 id="evidence-table-heading" className="sr-only">
            Evidence items
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Project</TableHead>
                <TableHead>Evidence Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>SHA-256 Hash</TableHead>
                <TableHead>Review Status</TableHead>
                <TableHead>Registered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredEvidences.map((ev) => {
                const statusConfig =
                  EVIDENCE_STATUS[ev.status] ?? {
                    variant: 'neutral' as const,
                    label: ev.status,
                  }
                const typeConfig =
                  EVIDENCE_TYPE[ev.type] ?? { variant: 'neutral' as const, label: ev.type }
                return (
                  <TableRow key={ev.id}>
                    <TableCell className="font-medium text-foreground max-w-[140px]">
                      <span className="line-clamp-1">{ev.projectName}</span>
                    </TableCell>
                    <TableCell className="max-w-[200px]">
                      <span className="line-clamp-2 text-sm">{ev.title}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={typeConfig.variant}>{typeConfig.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {ev.contentHash ? (
                        <code
                          className="font-mono text-xs text-muted-foreground"
                          title={ev.contentHash}
                          aria-label={`SHA-256 hash: ${ev.contentHash.slice(0, 12)} (truncated)`}
                        >
                          {ev.contentHash.slice(0, 12)}…
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground/60" aria-label="No hash">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(ev.createdAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  )
}

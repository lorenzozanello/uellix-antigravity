import Link from 'next/link'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ArrowLeft, ChevronRight, FileText, Plus } from 'lucide-react'
import { listProjectReports, getRunList } from '@/lib/pipeline/sroi-results'
import { createReportDraftFromRunAction } from './createReportDraftFromRun.action'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/states/EmptyState'

export const dynamic = 'force-dynamic'

const REPORT_STATUS: Record<
  string,
  { variant: 'neutral' | 'warning' | 'info' | 'success'; label: string }
> = {
  draft: { variant: 'warning', label: 'Draft' },
  under_review: { variant: 'info', label: 'Under Review' },
  locked: { variant: 'success', label: 'Locked' },
  archived: { variant: 'neutral', label: 'Archived' },
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export default async function ReportListPage({
  params,
}: {
  params: { projectId: string }
}) {
  const { projectId } = params

  const [reports, runs] = await Promise.all([
    listProjectReports(projectId),
    getRunList(projectId),
  ])

  const calculatedRuns = runs.filter((r) => r.status === 'calculated')
  const runById = new Map(runs.map((r) => [r.id, r]))

  async function handleCreateDraft(formData: FormData) {
    'use server'
    const runId = formData.get('runId') as string
    const title = formData.get('title') as string
    const result = await createReportDraftFromRunAction(projectId, runId, { title })
    revalidatePath(`/app/projects/${projectId}/report`)
    redirect(`/app/projects/${projectId}/report/${result.id}`)
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div>
        <Link
          href={`/app/projects/${projectId}/pipeline/calculation`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to Calculation
        </Link>
        <div className="mt-3 flex items-start gap-4">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#FF6A00]/10 text-[#FF6A00]"
            aria-hidden="true"
          >
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">SROI Reports</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Audit-ready report drafts linked to immutable SROI calculation runs.
              {reports.length > 0 && (
                <span className="ml-1">
                  {reports.length} report{reports.length !== 1 ? 's' : ''} on record.
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Methodology notice */}
      <div
        role="note"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        <span className="font-medium text-foreground">Methodology notice: </span>
        Each report is anchored to an immutable calculation run. Reports do not constitute
        automatic certification or audit clearance. They provide an{' '}
        <span className="font-medium text-foreground">audit-ready foundation</span> requiring
        human methodological review before external use.
      </div>

      {/* Create draft */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Create Report Draft</CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Select a completed calculation run to anchor this report to an immutable,
            audit-traceable SROI result.
          </p>
        </CardHeader>
        <CardContent>
          {calculatedRuns.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No completed calculation runs available. A run with status{' '}
                <Badge variant="success" className="inline-flex align-middle mx-0.5">
                  Calculated
                </Badge>{' '}
                is required before a report draft can be created.
              </p>
              <Link
                href={`/app/projects/${projectId}/pipeline/calculation`}
                className="inline-flex items-center gap-1 text-sm font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                Go to Calculation
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <form action={handleCreateDraft} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="runId" className="block text-sm font-medium text-foreground">
                    Reference calculation run
                  </label>
                  <Select id="runId" name="runId" required className="mt-1">
                    <option value="">— Select run —</option>
                    {calculatedRuns.map((r) => (
                      <option key={r.id} value={r.id}>
                        v{r.version}
                        {r.sroiRatio ? ` — SROI ${parseFloat(r.sroiRatio).toFixed(2)}:1` : ''}
                        {r.currency ? ` (${r.currency})` : ''}
                        {' · '}
                        {new Date(r.createdAt).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The run&apos;s SROI data will be immutably referenced throughout this report.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="report-title"
                    className="block text-sm font-medium text-foreground"
                  >
                    Report title
                  </label>
                  <input
                    id="report-title"
                    name="title"
                    type="text"
                    required
                    placeholder="e.g. SROI Impact Report 2024"
                    className={INPUT_CLASS}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Use a descriptive title that identifies the project period or geographic scope.
                  </p>
                </div>
              </div>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Create Draft Report
              </button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Reports table */}
      <section aria-labelledby="reports-table-heading">
        <h2
          id="reports-table-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Project Reports
        </h2>

        {reports.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-6 w-6 text-neutral-500" />}
            title="No reports yet"
            description="Create a draft from a completed calculation run above. Each report preserves a methodologically defensible, audit-traceable record."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => {
                const statusConfig =
                  REPORT_STATUS[report.status] ?? {
                    variant: 'neutral' as const,
                    label: report.status,
                  }
                const linkedRun = runById.get(report.calculationRunId)
                return (
                  <TableRow key={report.id}>
                    <TableCell className="font-medium text-foreground max-w-xs">
                      <span className="line-clamp-1">{report.title}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {linkedRun ? (
                        <span className="tabular-nums font-ibm-plex-mono">
                          v{linkedRun.version}
                          {linkedRun.sroiRatio
                            ? ` · ${parseFloat(linkedRun.sroiRatio).toFixed(2)}:1`
                            : ''}
                        </span>
                      ) : (
                        <span className="tabular-nums text-muted-foreground/60 font-ibm-plex-mono">
                          {report.calculationRunId.slice(0, 8)}…
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(report.createdAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/app/projects/${projectId}/report/${report.id}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                        aria-label={`Open report: ${report.title}`}
                      >
                        Open
                        <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  )
}

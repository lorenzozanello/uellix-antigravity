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
  draft: { variant: 'warning', label: 'Borrador' },
  under_review: { variant: 'info', label: 'En revisión' },
  locked: { variant: 'success', label: 'Bloqueado' },
  archived: { variant: 'neutral', label: 'Archivado' },
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export default async function ReportListPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params

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
          Volver a cálculo
        </Link>
        <div className="mt-3 flex items-start gap-4">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#FF6A00]/10 text-[#FF6A00]"
            aria-hidden="true"
          >
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Reportes SROI</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Borradores de reporte listos para auditoría, vinculados a corridas de cálculo SROI inmutables.
              {reports.length > 0 && (
                <span className="ml-1">
                  {reports.length} reporte{reports.length !== 1 ? 's' : ''} registrado{reports.length !== 1 ? 's' : ''}.
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
        <span className="font-medium text-foreground">Aviso metodológico: </span>
        Cada reporte está anclado a una corrida de cálculo inmutable. Los reportes no constituyen
        certificación automática ni aprobación de auditoría. Proveen una{' '}
        <span className="font-medium text-foreground">base lista para auditoría</span> que requiere
        revisión metodológica humana antes de su uso externo.
      </div>

      {/* Create draft */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Crear borrador de reporte</CardTitle>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Selecciona una corrida de cálculo completada para anclar este reporte a un resultado
            SROI inmutable y trazable para auditoría.
          </p>
        </CardHeader>
        <CardContent>
          {calculatedRuns.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No hay corridas de cálculo completadas disponibles. Se requiere una corrida con estado{' '}
                <Badge variant="success" className="inline-flex align-middle mx-0.5">
                  Calculado
                </Badge>{' '}
                antes de poder crear un borrador de reporte.
              </p>
              <Link
                href={`/app/projects/${projectId}/pipeline/calculation`}
                className="inline-flex items-center gap-1 text-sm font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                Ir a cálculo
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          ) : (
            <form action={handleCreateDraft} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="runId" className="block text-sm font-medium text-foreground">
                    Corrida de cálculo de referencia
                  </label>
                  <Select id="runId" name="runId" required className="mt-1">
                    <option value="">— Seleccionar corrida —</option>
                    {calculatedRuns.map((r) => (
                      <option key={r.id} value={r.id}>
                        v{r.version}
                        {r.sroiRatio ? ` — SROI ${parseFloat(r.sroiRatio).toFixed(2)}:1` : ''}
                        {r.currency ? ` (${r.currency})` : ''}
                        {' · '}
                        {new Date(r.createdAt).toLocaleDateString('es-MX', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Los datos SROI de la corrida se referenciarán de forma inmutable en todo el reporte.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="report-title"
                    className="block text-sm font-medium text-foreground"
                  >
                    Título del reporte
                  </label>
                  <input
                    id="report-title"
                    name="title"
                    type="text"
                    required
                    placeholder="ej. Reporte de Impacto SROI 2024"
                    className={INPUT_CLASS}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Usa un título descriptivo que identifique el período del proyecto o el alcance geográfico.
                  </p>
                </div>
              </div>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                Crear borrador de reporte
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
          Reportes del proyecto
        </h2>

        {reports.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-6 w-6 text-neutral-500" />}
            title="Aún no hay reportes"
            description="Crea un borrador a partir de una corrida de cálculo completada arriba. Cada reporte preserva un registro metodológicamente defendible y trazable para auditoría."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Corrida</TableHead>
                <TableHead>Creado</TableHead>
                <TableHead className="text-right">Acción</TableHead>
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
                      {new Date(report.createdAt).toLocaleDateString('es-MX', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/app/projects/${projectId}/report/${report.id}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                        aria-label={`Abrir reporte: ${report.title}`}
                      >
                        Abrir
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

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { AlertTriangle, ArrowLeft, CheckCircle2, Lock } from 'lucide-react'
import { getReportDraft } from '@/lib/pipeline/sroi-results'
import { updateReportSectionAction } from '../updateReportSection.action'
import { lockReportDraftAction } from '../lockReportDraft.action'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

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

const SECTION_META: Record<string, { label: string; helper: string }> = {
  executive_summary: {
    label: 'Resumen ejecutivo',
    helper:
      'Narrativa de alto nivel del proceso SROI y hallazgos clave. Escrita para una audiencia ejecutiva no técnica.',
  },
  project_context: {
    label: 'Contexto del proyecto',
    helper:
      'Descripción de la organización, la iniciativa, el alcance geográfico y el período de medición.',
  },
  theory_of_change: {
    label: 'Teoría del cambio',
    helper:
      'Modelo lógico que conecta actividades → productos → resultados. Documenta explícitamente los supuestos y las rutas causales.',
  },
  stakeholders: {
    label: 'Grupos de interés',
    helper:
      'Identificación de los grupos de interés incluidos o excluidos, con justificación de las decisiones de alcance.',
  },
  outcomes: {
    label: 'Resultados',
    helper:
      'Lista de resultados sociales medidos, incluyendo la justificación de materialidad de cada resultado incluido en el análisis.',
  },
  evidence_summary: {
    label: 'Resumen de evidencia',
    helper: 'Métodos de recolección de datos, fuentes, tamaños de muestra y limitaciones de calidad.',
  },
  proxy_methodology: {
    label: 'Metodología de proxies',
    helper:
      'Proxies financieros seleccionados (valores SVI, fuentes de SROI Network o investigación propia) con atribución completa.',
  },
  sroi_filters: {
    label: 'Filtros SROI',
    helper:
      'Supuestos metodológicos documentados de deadweight, atribución, desplazamiento y decaimiento por resultado.',
  },
  calculation_results: {
    label: 'Resultados del cálculo',
    helper:
      'Resumen del ratio SROI y las cifras de valor social, vinculadas a la corrida de cálculo inmutable. Incluye notas de sensibilidad si aplica.',
  },
  limitations: {
    label: 'Limitaciones',
    helper:
      'Limitaciones materiales en la calidad de los datos, exclusiones de alcance, supuestos causales no probados o vacíos de medición.',
  },
  review_notes: {
    label: 'Notas de revisión',
    helper:
      'Comentarios del revisor metodológico, elementos pendientes de verificación humana o notas de auditoría.',
  },
  appendix: {
    label: 'Apéndice',
    helper:
      'Tablas de datos de soporte, fuentes de datos, registros de consentimiento de grupos de interés o evidencia complementaria.',
  },
}

const SECTION_GROUPS = [
  {
    id: 'group-overview',
    label: 'Resumen',
    description: 'Narrativa ejecutiva y contexto del proyecto',
    types: ['executive_summary', 'project_context', 'theory_of_change'],
  },
  {
    id: 'group-evidence',
    label: 'Evidencia y datos',
    description: 'Grupos de interés, resultados, proxies y evidencia de origen',
    types: ['stakeholders', 'outcomes', 'evidence_summary', 'proxy_methodology'],
  },
  {
    id: 'group-calculation',
    label: 'Cálculo',
    description: 'Supuestos de filtros SROI y resultados finales',
    types: ['sroi_filters', 'calculation_results'],
  },
  {
    id: 'group-review',
    label: 'Revisión y apéndice',
    description: 'Limitaciones, notas del revisor y material de soporte',
    types: ['limitations', 'review_notes', 'appendix'],
  },
]

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y'

type ReportDraft = Awaited<ReturnType<typeof getReportDraft>>
type Section = ReportDraft['sections'][number]

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; reportId: string }>
}) {
  const { projectId, reportId } = await params

  let report: ReportDraft
  try {
    report = await getReportDraft(projectId, reportId)
  } catch {
    notFound()
  }

  const isLocked = report.status === 'locked'
  const statusConfig =
    REPORT_STATUS[report.status] ?? { variant: 'neutral' as const, label: report.status }

  async function handleUpdateSection(formData: FormData) {
    'use server'
    const sectionId = formData.get('sectionId') as string
    await updateReportSectionAction(projectId, reportId, sectionId, {
      title: formData.get('title') as string,
      content: (formData.get('content') as string) || undefined,
    })
    revalidatePath(`/app/projects/${projectId}/report/${reportId}`)
  }

  async function handleLock() {
    'use server'
    await lockReportDraftAction(projectId, reportId)
    revalidatePath(`/app/projects/${projectId}/report/${reportId}`)
  }

  const sectionByType = new Map<string, Section>(
    report.sections.map((s) => [s.sectionType, s])
  )

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div>
        <Link
          href={`/app/projects/${projectId}/report`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Volver a reportes
        </Link>
        <div className="mt-3 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{report.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
              <span className="text-xs text-muted-foreground">
                Corrida:{' '}
                <Link
                  href={`/app/projects/${projectId}/pipeline/calculation/runs/${report.calculationRunId}`}
                  className="tabular-nums font-ibm-plex-mono text-[#B85200] hover:text-[#B85200]/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {report.calculationRunId.slice(0, 8)}…
                </Link>
              </span>
              <span className="text-xs text-muted-foreground">
                Creado el{' '}
                {new Date(report.createdAt).toLocaleDateString('es-MX', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            </div>
          </div>

          {!isLocked && (
            <form action={handleLock}>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <Lock className="h-4 w-4" aria-hidden="true" />
                Bloquear reporte
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Locked banner */}
      {isLocked && (
        <div
          role="status"
          aria-live="polite"
          className="flex gap-3 rounded-lg border border-border bg-muted/40 p-4"
        >
          <CheckCircle2
            className="mt-0.5 h-4 w-4 shrink-0 text-green-700"
            aria-hidden="true"
          />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">
              Este reporte está bloqueado y preserva una versión lista para auditoría, para revisión metodológica.
            </p>
            <p className="text-muted-foreground text-xs">
              El bloqueo no constituye certificación automática. Se requiere revisión humana antes
              de su uso externo.
            </p>
            {report.lockedAt && (
              <p className="text-muted-foreground text-xs">
                Bloqueado el{' '}
                {new Date(report.lockedAt).toLocaleString('es-MX', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                .
              </p>
            )}
          </div>
        </div>
      )}

      {/* Lock warning (editable state) */}
      {!isLocked && (
        <div
          role="note"
          className="flex gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3"
        >
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Bloquear es irreversible.</span> Una vez
            bloqueado, este reporte no se puede editar. Preservará una versión defendible y trazable
            para auditoría, para revisión humana. Asegúrate de que todas las secciones estén completas antes de bloquear.
          </p>
        </div>
      )}

      {/* Optional summary */}
      {report.summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Resumen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-foreground leading-relaxed">{report.summary}</p>
          </CardContent>
        </Card>
      )}

      {/* Section group anchor nav */}
      <nav aria-label="Ir a grupo de secciones" className="flex flex-wrap gap-2">
        {SECTION_GROUPS.map((group) => (
          <a
            key={group.id}
            href={`#${group.id}`}
            className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {group.label}
          </a>
        ))}
      </nav>

      {/* Section groups */}
      <div className="space-y-10">
        {SECTION_GROUPS.map((group) => {
          const groupSections = group.types
            .map((type) => sectionByType.get(type))
            .filter((s): s is Section => Boolean(s))

          return (
            <section
              key={group.id}
              id={group.id}
              aria-labelledby={`${group.id}-heading`}
            >
              <div className="mb-4 border-b border-border pb-3">
                <h2
                  id={`${group.id}-heading`}
                  className="text-base font-semibold text-foreground"
                >
                  {group.label}
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">{group.description}</p>
              </div>

              <div className="space-y-4">
                {groupSections.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">
                    No hay secciones disponibles en este grupo.
                  </p>
                ) : (
                  groupSections.map((section) => {
                    const meta = SECTION_META[section.sectionType] ?? {
                      label: section.title,
                      helper: '',
                    }
                    const sectionHeadingId = `sh-${section.id}`
                    const titleInputId = `title-${section.id}`
                    const contentInputId = `content-${section.id}`

                    return (
                      <Card key={section.id}>
                        <CardHeader className="pb-0">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <span
                                className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono font-medium bg-muted text-muted-foreground border border-border mb-1"
                                aria-label={`Tipo de sección: ${section.sectionType}`}
                              >
                                {section.sectionType}
                              </span>
                              <h3
                                id={sectionHeadingId}
                                className="text-sm font-semibold text-foreground"
                              >
                                {meta.label}
                              </h3>
                            </div>
                            {isLocked && (
                              <Lock
                                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                aria-label="Sección de solo lectura"
                              />
                            )}
                          </div>
                          {meta.helper && (
                            <p className="mt-1 text-xs text-muted-foreground leading-snug">
                              {meta.helper}
                            </p>
                          )}
                        </CardHeader>

                        <CardContent className="pt-3">
                          {isLocked ? (
                            <div aria-labelledby={sectionHeadingId}>
                              {section.content ? (
                                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                                  {section.content}
                                </p>
                              ) : (
                                <p className="text-sm text-muted-foreground italic">
                                  No hay contenido registrado para esta sección.
                                </p>
                              )}
                            </div>
                          ) : (
                            <form
                              action={handleUpdateSection}
                              className="space-y-3"
                              aria-labelledby={sectionHeadingId}
                            >
                              <input type="hidden" name="sectionId" value={section.id} />
                              <div>
                                <label
                                  htmlFor={titleInputId}
                                  className="block text-xs font-medium text-foreground"
                                >
                                  Título de la sección
                                </label>
                                <input
                                  id={titleInputId}
                                  name="title"
                                  type="text"
                                  required
                                  defaultValue={section.title}
                                  className={INPUT_CLASS}
                                />
                              </div>
                              <div>
                                <label
                                  htmlFor={contentInputId}
                                  className="block text-xs font-medium text-foreground"
                                >
                                  Contenido
                                </label>
                                <textarea
                                  id={contentInputId}
                                  name="content"
                                  rows={5}
                                  defaultValue={section.content ?? ''}
                                  placeholder={
                                    meta.helper ||
                                    'Documentación metodológica para esta sección…'
                                  }
                                  className={TEXTAREA_CLASS}
                                />
                                {meta.helper && (
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {meta.helper}
                                  </p>
                                )}
                              </div>
                              <button
                                type="submit"
                                className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                              >
                                Guardar sección
                              </button>
                            </form>
                          )}
                        </CardContent>
                      </Card>
                    )
                  })
                )}
              </div>
            </section>
          )
        })}
      </div>

      {/* Metadata footer */}
      <section
        aria-labelledby="record-heading"
        className="rounded-lg border border-border bg-muted/30 p-4"
      >
        <h2
          id="record-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Registro
        </h2>
        <dl className="grid grid-cols-2 gap-3 text-xs md:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Creado</dt>
            <dd className="mt-0.5 font-medium text-foreground">
              {new Date(report.createdAt).toLocaleString('es-MX', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Última actualización</dt>
            <dd className="mt-0.5 font-medium text-foreground">
              {new Date(report.updatedAt).toLocaleString('es-MX', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </dd>
          </div>
          {isLocked && report.lockedAt && (
            <div>
              <dt className="text-muted-foreground">Bloqueado</dt>
              <dd className="mt-0.5 font-medium text-foreground">
                {new Date(report.lockedAt).toLocaleString('es-MX', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  )
}

import React from 'react'
import Stepper from '@/components/sroi/Stepper'
import { PipelineStepHeader } from '@/components/sroi/PipelineStepHeader'
import { StellaAdvisorPanel } from '@/components/stella'
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions'
import { fetchIndicators } from '@/app/app/projects/[projectId]/pipeline/indicators.actions'
import { createFileEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action'
import { createUrlEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createUrlEvidence.action'
import { createTextEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createTextEvidence.action'
import { canUploadEvidence, hasRole } from '@/lib/auth/permissions'
import {
  listEvidenceForProject,
  archiveEvidenceForProject,
  updateEvidenceReviewStatus,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
} from '@/lib/pipeline/evidence'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { revalidatePath } from 'next/cache'
import { FileText, Link2, AlignLeft, Archive } from 'lucide-react'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/states/EmptyState'

// Top-level Server Actions for the forms and buttons
export const fileAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const fileEntry = formData.get('file')
  if (!fileEntry || !(fileEntry instanceof File) || fileEntry.size === 0) {
    throw new Error('Archivo no provisto o vacío.')
  }
  // Reject oversized files using File.size (available without reading the
  // body) before ever buffering the content into memory.
  if (fileEntry.size > MAX_EVIDENCE_FILE_SIZE_BYTES) {
    throw new Error(
      `El archivo supera el límite de ${MAX_EVIDENCE_FILE_SIZE_BYTES / (1024 * 1024)} MB.`
    )
  }
  const buffer = Buffer.from(await fileEntry.arrayBuffer())
  const rawInput = {
    title: formData.get('title') as string,
    description: (formData.get('description') as string) || undefined,
    outcomeId: (formData.get('outcomeId') as string) || undefined,
    indicatorId: (formData.get('indicatorId') as string) || undefined,
    file: {
      name: fileEntry.name,
      mimeType: fileEntry.type,
      size: fileEntry.size,
      buffer,
    },
  }
  await createFileEvidenceAction(projectId, rawInput)
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

export const urlAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const rawInput = {
    title: formData.get('title') as string,
    description: (formData.get('description') as string) || undefined,
    outcomeId: (formData.get('outcomeId') as string) || undefined,
    indicatorId: (formData.get('indicatorId') as string) || undefined,
    url: formData.get('url') as string,
  }
  await createUrlEvidenceAction(projectId, rawInput)
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

export const textAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const rawInput = {
    title: formData.get('title') as string,
    description: (formData.get('description') as string) || undefined,
    outcomeId: (formData.get('outcomeId') as string) || undefined,
    indicatorId: (formData.get('indicatorId') as string) || undefined,
    text: formData.get('text') as string,
  }
  await createTextEvidenceAction(projectId, rawInput)
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

export const archiveAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const evidenceId = formData.get('evidenceId') as string
  await archiveEvidenceForProject(projectId, evidenceId)
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

export const updateStatusAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const evidenceId = formData.get('evidenceId') as string
  const status = formData.get('status') as string
  if (!status) return
  await updateEvidenceReviewStatus(projectId, evidenceId, { status })
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

const EVIDENCE_STATUS: Record<
  string,
  { variant: 'neutral' | 'warning' | 'info' | 'success' | 'danger'; label: string }
> = {
  draft: { variant: 'neutral', label: 'Borrador' },
  under_review: { variant: 'info', label: 'En revisión' },
  approved: { variant: 'success', label: 'Aprobado' },
  rejected: { variant: 'danger', label: 'Rechazado' },
  archived: { variant: 'neutral', label: 'Archivado' },
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y'
const FILE_INPUT_CLASS =
  'mt-1 block w-full text-sm text-foreground file:mr-3 file:rounded file:border file:border-border file:bg-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/80 focus:outline-none'

export default async function EvidencePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const { membership } = await requireOrganizationAccess()
  const canCreate = canUploadEvidence(membership.role)
  const canArchive = hasRole(membership.role, 'analyst')
  const canReview = hasRole(membership.role, 'impact_manager')

  const evidences = await listEvidenceForProject(projectId)
  const outcomes = await fetchOutcomes(projectId)
  const indicators = await fetchIndicators(projectId)

  return (
    <div className="space-y-6 max-w-5xl">
      <PipelineStepHeader
        step={5}
        title="Evidencia"
        description="Registra elementos de evidencia trazables vinculados a resultados e indicadores. Cada elemento recibe un hash SHA-256 inmutable para trazabilidad de auditoría."
        methodologyNote="La evidencia registrada aquí no constituye certificación automática. Todos los elementos requieren revisión humana antes de usarse en reportes SROI externos."
      />

      <Stepper />

      <StellaAdvisorPanel projectId={projectId} step="Evidencia" />

      {/* Evidence list */}
      <section aria-labelledby="evidence-list-heading">
        <h2
          id="evidence-list-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Evidencia registrada
        </h2>

        {evidences.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-6 w-6 text-neutral-500" />}
            title="No hay evidencia registrada"
            description="No se ha enviado evidencia para este proyecto. Usa los formularios de abajo para registrar evidencia de archivo, URL o texto."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Estado de revisión</TableHead>
                <TableHead>Hash SHA-256</TableHead>
                <TableHead>Registrado</TableHead>
                <TableHead>Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {evidences.map((ev) => {
                const statusConfig =
                  EVIDENCE_STATUS[ev.status] ?? {
                    variant: 'neutral' as const,
                    label: ev.status,
                  }
                const reviewSelectId = `review-${ev.id}`
                return (
                  <TableRow key={ev.id}>
                    <TableCell className="font-medium text-foreground max-w-[160px]">
                      <span className="line-clamp-1">{ev.title}</span>
                    </TableCell>
                    <TableCell>
                      <span
                        className="tabular-nums text-xs uppercase text-muted-foreground"
                        style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                      >
                        {ev.type}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {ev.contentHash ? (
                        <code
                          className="tabular-nums text-xs text-muted-foreground"
                          style={{ fontFamily: 'var(--font-ibm-plex-mono)' }}
                          title={ev.contentHash}
                          aria-label={`Hash SHA-256 (truncado): ${ev.contentHash.slice(0, 8)}`}
                        >
                          {ev.contentHash.slice(0, 8)}…
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(ev.createdAt).toLocaleDateString('es-MX', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        {canReview && ev.status !== 'archived' && (
                          <form action={updateStatusAction} className="inline-flex items-center gap-1">
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="evidenceId" value={ev.id} />
                            <label htmlFor={reviewSelectId} className="sr-only">
                              Actualizar estado de revisión
                            </label>
                            <Select
                              id={reviewSelectId}
                              name="status"
                              defaultValue=""
                              className="h-7 text-xs"
                            >
                              <option value="" disabled>
                                Revisar…
                              </option>
                              <option value="approved">Aprobar</option>
                              <option value="rejected">Rechazar</option>
                              <option value="under_review">En revisión</option>
                            </Select>
                            <button
                              type="submit"
                              className="inline-flex items-center rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Guardar
                            </button>
                          </form>
                        )}
                        {canArchive && ev.status !== 'archived' && (
                          <form action={archiveAction} className="inline-flex">
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="evidenceId" value={ev.id} />
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                              aria-label={`Archivar evidencia: ${ev.title}`}
                            >
                              <Archive className="h-3 w-3" aria-hidden="true" />
                              Archivar
                            </button>
                          </form>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </section>

      {/* Creation forms */}
      {canCreate && (
        <section aria-labelledby="add-evidence-heading">
          <h2
            id="add-evidence-heading"
            className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
          >
            Agregar evidencia
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* File form */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Subir archivo</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Sube un documento. Se calculará y almacenará un hash SHA-256 para verificación
                  de integridad.
                </p>
              </CardHeader>
              <CardContent>
                <form action={fileAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />

                  <div>
                    <label
                      htmlFor="file-outcome"
                      className="block text-xs font-medium text-foreground"
                    >
                      Vincular a resultado
                    </label>
                    <Select id="file-outcome" name="outcomeId" className="mt-1">
                      <option value="">Ninguno</option>
                      {outcomes?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.title}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="file-indicator"
                      className="block text-xs font-medium text-foreground"
                    >
                      Vincular a indicador
                    </label>
                    <Select id="file-indicator" name="indicatorId" className="mt-1">
                      <option value="">Ninguno</option>
                      {indicators?.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="file-title"
                      className="block text-xs font-medium text-foreground"
                    >
                      Título <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="file-title"
                      name="title"
                      type="text"
                      required
                      placeholder="Título descriptivo de la evidencia"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="file-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Descripción
                    </label>
                    <textarea
                      id="file-description"
                      name="description"
                      rows={2}
                      placeholder="Contexto metodológico opcional"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="file-file"
                      className="block text-xs font-medium text-foreground"
                    >
                      Archivo <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="file-file"
                      type="file"
                      name="file"
                      required
                      className={FILE_INPUT_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      El hash SHA-256 se calcula automáticamente al subir el archivo.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Subir archivo
                  </button>
                </form>
              </CardContent>
            </Card>

            {/* URL form */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Registrar URL</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Registra una URL externa como fuente de evidencia trazable. El contenido de la
                  URL no se descarga ni se almacena.
                </p>
              </CardHeader>
              <CardContent>
                <form action={urlAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />

                  <div>
                    <label
                      htmlFor="url-outcome"
                      className="block text-xs font-medium text-foreground"
                    >
                      Vincular a resultado
                    </label>
                    <Select id="url-outcome" name="outcomeId" className="mt-1">
                      <option value="">Ninguno</option>
                      {outcomes?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.title}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="url-indicator"
                      className="block text-xs font-medium text-foreground"
                    >
                      Vincular a indicador
                    </label>
                    <Select id="url-indicator" name="indicatorId" className="mt-1">
                      <option value="">Ninguno</option>
                      {indicators?.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="url-title"
                      className="block text-xs font-medium text-foreground"
                    >
                      Título <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="url-title"
                      name="title"
                      type="text"
                      required
                      placeholder="Título descriptivo de la evidencia"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="url-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Descripción
                    </label>
                    <textarea
                      id="url-description"
                      name="description"
                      rows={2}
                      placeholder="Contexto metodológico opcional"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="url-url"
                      className="block text-xs font-medium text-foreground"
                    >
                      URL <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="url-url"
                      type="url"
                      name="url"
                      required
                      placeholder="https://ejemplo.com/fuente"
                      className={INPUT_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      El contenido de la URL no se descarga. Solo se almacena la referencia.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Registrar URL
                  </button>
                </form>
              </CardContent>
            </Card>

            {/* Text form */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <AlignLeft className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Registrar declaración de texto</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Registra una declaración o afirmación de texto como evidencia. El contenido se
                  hashea para trazabilidad de auditoría inmutable.
                </p>
              </CardHeader>
              <CardContent>
                <form action={textAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={projectId} />

                  <div>
                    <label
                      htmlFor="text-outcome"
                      className="block text-xs font-medium text-foreground"
                    >
                      Vincular a resultado
                    </label>
                    <Select id="text-outcome" name="outcomeId" className="mt-1">
                      <option value="">Ninguno</option>
                      {outcomes?.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.title}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="text-indicator"
                      className="block text-xs font-medium text-foreground"
                    >
                      Vincular a indicador
                    </label>
                    <Select id="text-indicator" name="indicatorId" className="mt-1">
                      <option value="">Ninguno</option>
                      {indicators?.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <label
                      htmlFor="text-title"
                      className="block text-xs font-medium text-foreground"
                    >
                      Título <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="text-title"
                      name="title"
                      type="text"
                      required
                      placeholder="Título descriptivo de la evidencia"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="text-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Descripción
                    </label>
                    <textarea
                      id="text-description"
                      name="description"
                      rows={2}
                      placeholder="Contexto metodológico opcional"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="text-text"
                      className="block text-xs font-medium text-foreground"
                    >
                      Texto de la declaración <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <textarea
                      id="text-text"
                      name="text"
                      rows={3}
                      required
                      placeholder="Declaración metodológica o afirmación de datos…"
                      className={TEXTAREA_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Este texto se hasheará con SHA-256 para trazabilidad de auditoría.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Registrar declaración
                  </button>
                </form>
              </CardContent>
            </Card>
          </div>
        </section>
      )}
    </div>
  )
}

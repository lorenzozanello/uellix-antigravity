import React from 'react'
import Stepper from '@/components/sroi/Stepper'
import { PipelineStepHeader } from '@/components/sroi/PipelineStepHeader'
import { StellaContextualAdvisorPanel, StellaReviewerPanel } from '@/components/stella'
// Server-only config read (READ-ONLY module) — availability passed as prop (U5).
import { stellaConfig, stellaState } from '@/lib/stella/config'
import { MethodologyReviewPanel } from '@/components/methodology/MethodologyReviewPanel'
import { canReviewMethodology } from '@/lib/pipeline/methodology-review'
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions'
import { fetchIndicators } from '@/app/app/projects/[projectId]/pipeline/indicators.actions'
import { createFileEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action'
import { createUrlEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createUrlEvidence.action'
import { createTextEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createTextEvidence.action'
import { verifyEvidenceIntegrityAction } from '@/app/app/projects/[projectId]/pipeline/evidence/verifyEvidenceIntegrity.action'
import { indexEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/indexEvidence.action'
import { readProjectCorpusStateForProject } from '@/app/actions/grounding/evidence-corpus-state'
import { EvidenceIndexStatus } from '@/components/evidence/EvidenceIndexStatus'
import { archiveEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/archiveEvidence.action'
import { updateEvidenceReviewStatusAction } from '@/app/app/projects/[projectId]/pipeline/evidence/updateEvidenceReviewStatus.action'
import { classifyEvidenceSensitivityAction } from '@/app/app/projects/[projectId]/pipeline/evidence/classifyEvidenceSensitivity.action'
import { requestEvidenceErasureAction } from '@/app/app/projects/[projectId]/pipeline/evidence/requestEvidenceErasure.action'
import { canUploadEvidence, hasRole, canClassifyEvidenceSensitivity, canEraseEvidenceContent } from '@/lib/auth/permissions'
import {
  listEvidenceForProject,
  ALLOWED_EVIDENCE_MIME_TYPES,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
} from '@/lib/pipeline/evidence'
import { getLatestEvidenceVersionsByEvidenceIds } from '@/lib/pipeline/evidence-versions'
import { classifyGroundingFormat } from '@/lib/grounding/extract'
import { runWithOrganizationAccess } from '@/lib/auth/session'
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
  // Routed through the wrapped action rather than the service: these two inline
  // actions were the only evidence mutations that called `lib/pipeline/evidence`
  // directly, and would therefore have run with no identity context.
  await archiveEvidenceAction(projectId, evidenceId)
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

export const updateStatusAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const evidenceId = formData.get('evidenceId') as string
  const status = formData.get('status') as string
  if (!status) return
  await updateEvidenceReviewStatusAction(projectId, evidenceId, { status })
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

export const verifyIntegrityAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const evidenceId = formData.get('evidenceId') as string
  await verifyEvidenceIntegrityAction(projectId, evidenceId)
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

// R4 (R-B1-02, FIBIU-05) — governed human sensitivity classification. The
// service (lib/pipeline/evidence.ts:classifyEvidenceSensitivity) is the only
// write path and owns the fail-closed permission check; this action is pure
// FormData plumbing to it, exactly like updateStatusAction above.
export const classifySensitivityAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const evidenceId = formData.get('evidenceId') as string
  const sensitivityClassification = formData.get('sensitivityClassification') as string
  const rawTreatment = formData.get('treatment') as string
  if (!sensitivityClassification) return
  await classifyEvidenceSensitivityAction(projectId, evidenceId, {
    sensitivityClassification,
    treatment: rawTreatment || undefined,
  })
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

// R4 (R-B1-02, FIBIU-07) — governed, exceptional, irreversible content
// erasure. NOT a substitute for the ordinary evidence_items DELETE path
// (unchanged, stage-E deferred) — a distinct, explicitly-reasoned route that
// only sweeps the content this repository actually stores, never the row or
// its lineage. The service owns the permission check, the sweep, and the
// tombstone; this action is FormData plumbing to it.
export const requestErasureAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const evidenceId = formData.get('evidenceId') as string
  const erasureReason = formData.get('erasureReason') as string
  const rationale = formData.get('rationale') as string
  if (!erasureReason || !rationale) return
  await requestEvidenceErasureAction(projectId, evidenceId, { erasureReason, rationale })
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`)
}

/**
 * Index ONE evidence row on request — the manual half of G-01.
 *
 * The pair carried by the form is NOT trusted: `indexEvidenceAction` forwards
 * to `ingestProjectEvidenceForProject`, which re-resolves the session, the
 * organization and the evidence-management threshold, and then looks the row up
 * by (evidence id, project id, organization id) together. A forged pair returns
 * `unauthorized` — the same answer a row that does not exist gets.
 *
 * The outcome is deliberately not surfaced from here: the page re-reads the
 * corpus state after `revalidatePath`, so what the reviewer sees next is the
 * DURABLE result of the attempt rather than the message this call returned. A
 * transient banner and a durable read model that disagreed would be two answers
 * to one question.
 */
export const indexEvidenceFormAction = async (formData: FormData) => {
  'use server'
  const projectId = formData.get('projectId') as string
  const evidenceId = formData.get('evidenceId') as string
  if (!projectId || !evidenceId) return
  await indexEvidenceAction(projectId, evidenceId)
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

const SENSITIVITY_BADGE: Record<
  string,
  { variant: 'neutral' | 'warning' | 'info' | 'success' | 'danger'; label: string }
> = {
  non_sensitive: { variant: 'success', label: 'No sensible' },
  personal_data: { variant: 'warning', label: 'Datos personales' },
  identifiable_restricted: { variant: 'warning', label: 'Identificable restringido' },
  confidential_third_party: { variant: 'danger', label: 'Confidencial (tercero)' },
  special_category: { variant: 'danger', label: 'Categoría especial' },
}

const TREATMENT_LABEL: Record<string, string> = {
  not_required: 'No requerido',
  anonymized: 'Anonimizado',
  pseudonymized: 'Pseudonimizado',
  identifiable_restricted_access: 'Acceso restringido',
}

const ERASURE_REASON_OPTIONS: readonly [string, string][] = [
  ['privacy_or_data_subject_request', 'Solicitud de privacidad / titular de datos'],
  ['retention_policy', 'Política de retención'],
  ['unauthorized_or_erroneous_upload', 'Carga no autorizada o errónea'],
  ['confidentiality_or_access_violation', 'Violación de confidencialidad o acceso'],
  ['legal_or_contractual_requirement', 'Requisito legal o contractual'],
  ['other_governed_reason', 'Otro motivo gobernado'],
]

/**
 * The uploadable MIME types the grounding extractor actually parses.
 *
 * COMPUTED from the two authorities rather than written out: the upload
 * allowlist (`ALLOWED_EVIDENCE_MIME_TYPES`, a SEC-003 control) intersected with
 * the extractor's own table (`classifyGroundingFormat`). A hand-written list
 * here would be a third claim about formats, free to promise PDF the day
 * somebody reads the upload allowlist and forgets the extractor — which is the
 * exact confusion this line exists to remove.
 *
 * It is `text/plain` alone today. `text/csv` HAS an extractor and is not an
 * accepted upload type, so it cannot appear; that gap is real and is reported
 * as a finding rather than closed here, because widening a security allowlist
 * is not a UX change.
 */
const GROUNDING_INDEXABLE_UPLOAD_TYPES = ALLOWED_EVIDENCE_MIME_TYPES.filter((mimeType) => {
  const format = classifyGroundingFormat(mimeType)
  return format.kind === 'text' || format.kind === 'csv'
}).join(', ')

function confidenceBadgeVariant(score: number): 'danger' | 'warning' | 'success' {
  if (score < 40) return 'danger'
  if (score < 70) return 'warning'
  return 'success'
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y'
const FILE_INPUT_CLASS =
  'mt-1 block w-full text-sm text-foreground file:mr-3 file:rounded file:border file:border-border file:bg-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/80 focus:outline-none'

export default async function EvidencePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params
  const { membership, evidences, outcomes, indicators, latestVersionByEvidenceId } =
    await runWithOrganizationAccess(async ({ membership }) => {
      const evidences = await listEvidenceForProject(projectId)
      return {
        membership,
        evidences,
        outcomes: await fetchOutcomes(projectId),
        indicators: await fetchIndicators(projectId),
        // R4 (R-B1-02, FIBIU-05/07) — the current version's sensitivity
        // classification and erasure state, read the same way every other
        // governed exposure surface reads it
        // (getLatestEvidenceVersionsByEvidenceIds), never a second,
        // independent notion of "current". MUST stay inside this identity
        // context: as uellix_app, a query issued outside it returns zero
        // rows silently (tests/database-runtime-entrypoints.test.ts).
        latestVersionByEvidenceId: await getLatestEvidenceVersionsByEvidenceIds(
          evidences.map((ev) => ev.id)
        ),
      }
    })

  const canCreate = canUploadEvidence(membership.role)
  const canArchive = hasRole(membership.role, 'analyst')
  const canReview = hasRole(membership.role, 'impact_manager')
  const canClassifySensitivity = canClassifyEvidenceSensitivity(membership.role)
  const canErase = canEraseEvidenceContent(membership.role)

  // G-01. Read OUTSIDE the block above: the action authenticates and opens its
  // own identity context, exactly as it does when a form calls it. The
  // principal is memoised, so the second `requireOrganizationAccess()` issues
  // no query of its own.
  const corpus = await readProjectCorpusStateForProject(projectId)
  const corpusStates =
    corpus.status === 'ready'
      ? new Map(corpus.states.map((state) => [state.evidenceId, state]))
      : null
  // The column is rendered ONLY when the corpus was actually read. On `error`
  // it is withheld on purpose: a cell reading "pendiente de indexar" for every
  // row would tell a reviewer the index is empty when the truth is that nobody
  // could look at it.
  const showIndexColumn = corpusStates !== null

  // Mirror the corresponding server-action feature-flag gates (app/actions/stella/*).
  const stellaAdvisorEnabled =
    stellaConfig.isEnabled && stellaConfig.isAdvisorEnabled && stellaState.canUseStella
  const evidenceReviewerEnabled =
    stellaConfig.isEnabled && stellaConfig.isEvidenceReviewerEnabled && stellaState.canUseStella

  return (
    <div className="space-y-6 max-w-5xl">
      <PipelineStepHeader
        step={5}
        title="Evidencia"
        description="Registra elementos de evidencia trazables vinculados a resultados e indicadores. Cada elemento recibe un hash SHA-256 inmutable para trazabilidad de auditoría."
        methodologyNote="La evidencia registrada aquí no constituye certificación automática. Todos los elementos requieren revisión humana antes de usarse en reportes SROI externos."
      />

      <Stepper />

      {/* U3: evidence entries are records with file uploads — no single
          editable apply target, so apply offers copy-to-clipboard. */}
      <StellaContextualAdvisorPanel
        projectId={projectId}
        step="evidence"
        enabled={stellaAdvisorEnabled}
        title="Stella — Asesoría contextual (Evidencia)"
      />
      <StellaReviewerPanel
        projectId={projectId}
        role="evidence_reviewer"
        title="Revisor de Evidencia (Stella)"
        enabled={evidenceReviewerEnabled}
      />

      {canReviewMethodology(membership.role) && (
        <MethodologyReviewPanel
          projectId={projectId}
          step="evidence"
          title="Revisión metodológica — Evidencia"
        />
      )}

      {/* Evidence list */}
      <section aria-labelledby="evidence-list-heading">
        <h2
          id="evidence-list-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Evidencia registrada
        </h2>

        {/* G-01. Storage and grounding are different facts about the same row,
            so when the second cannot be shown the reason is stated rather than
            left as an absent column. Addressed to the people who could act on
            it; a reviewer with no upload rights cannot. */}
        {canCreate && corpus.status === 'disabled' && (
          <p className="mb-3 text-xs text-muted-foreground">
            La indexación para grounding no está habilitada en este despliegue. La evidencia se
            almacena y se conserva su hash, pero no alimenta respuestas fundamentadas.
          </p>
        )}
        {canCreate && corpus.status === 'error' && (
          <p className="mb-3 text-xs text-muted-foreground">
            No se pudo leer el estado del índice de grounding. La evidencia listada abajo está
            almacenada; su estado de indexación es desconocido en este momento.
          </p>
        )}

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
                <TableHead>Sensibilidad</TableHead>
                <TableHead>Confianza</TableHead>
                {showIndexColumn && <TableHead>Grounding</TableHead>}
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
                const version = latestVersionByEvidenceId.get(ev.id) ?? null
                const sensitivityConfig = version?.sensitivityClassification
                  ? SENSITIVITY_BADGE[version.sensitivityClassification] ?? {
                      variant: 'neutral' as const,
                      label: version.sensitivityClassification,
                    }
                  : null
                const isErased =
                  version?.erasureState === 'erasure_complete' || version?.erasureState === 'erasure_partial'
                const classifySelectId = `sensitivity-${ev.id}`
                const treatmentSelectId = `treatment-${ev.id}`
                const erasureReasonId = `erasure-reason-${ev.id}`
                const erasureRationaleId = `erasure-rationale-${ev.id}`
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
                      <div className="flex flex-col gap-1.5 min-w-[160px]">
                        {sensitivityConfig ? (
                          <div className="flex flex-col gap-0.5">
                            <Badge variant={sensitivityConfig.variant}>{sensitivityConfig.label}</Badge>
                            {version?.treatment && (
                              <span className="text-[10px] text-muted-foreground">
                                {TREATMENT_LABEL[version.treatment] ?? version.treatment}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground/60">Sin clasificar</span>
                        )}
                        {isErased && (
                          <Badge variant="danger">
                            {version?.erasureState === 'erasure_complete'
                              ? 'Contenido borrado'
                              : 'Borrado parcial'}
                          </Badge>
                        )}
                        {canClassifySensitivity && !isErased && (
                          <form
                            action={classifySensitivityAction}
                            className="flex flex-col gap-1"
                          >
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="evidenceId" value={ev.id} />
                            <label htmlFor={classifySelectId} className="sr-only">
                              Clasificar sensibilidad
                            </label>
                            <Select
                              id={classifySelectId}
                              name="sensitivityClassification"
                              defaultValue=""
                              required
                              className="h-7 text-xs"
                            >
                              <option value="" disabled>
                                Clasificar…
                              </option>
                              <option value="non_sensitive">No sensible</option>
                              <option value="personal_data">Datos personales</option>
                              <option value="identifiable_restricted">Identificable restringido</option>
                              <option value="confidential_third_party">Confidencial (tercero)</option>
                              <option value="special_category">Categoría especial</option>
                            </Select>
                            <label htmlFor={treatmentSelectId} className="sr-only">
                              Tratamiento (requerido si no es no-sensible)
                            </label>
                            <Select
                              id={treatmentSelectId}
                              name="treatment"
                              defaultValue=""
                              className="h-7 text-xs"
                            >
                              <option value="">Tratamiento (si aplica)…</option>
                              <option value="not_required">No requerido</option>
                              <option value="anonymized">Anonimizado</option>
                              <option value="pseudonymized">Pseudonimizado</option>
                              <option value="identifiable_restricted_access">Acceso restringido</option>
                            </Select>
                            <button
                              type="submit"
                              className="inline-flex items-center justify-center rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Guardar clasificación
                            </button>
                          </form>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {ev.confidenceScore === null ? (
                          <span className="text-xs text-muted-foreground/60">—</span>
                        ) : (
                          <Badge variant={confidenceBadgeVariant(ev.confidenceScore)}>{ev.confidenceScore}</Badge>
                        )}
                        {ev.type === 'file' && ev.integrityVerifiedAt && (
                          <span
                            className="text-[10px] text-muted-foreground"
                            aria-label={`Integridad ${ev.integrityVerified === false ? 'fallida' : 'verificada'} ${new Date(ev.integrityVerifiedAt).toLocaleDateString('es-MX', {
                              day: 'numeric',
                              month: 'short',
                            })}`}
                          >
                            <span aria-hidden="true">{ev.integrityVerified === false ? '✗' : '✓'}</span> verificado{' '}
                            {new Date(ev.integrityVerifiedAt).toLocaleDateString('es-MX', {
                              day: 'numeric',
                              month: 'short',
                            })}
                          </span>
                        )}
                        {ev.type === 'file' && canReview && ev.status !== 'archived' && (
                          <form action={verifyIntegrityAction}>
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="evidenceId" value={ev.id} />
                            <button
                              type="submit"
                              className="text-left text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                            >
                              Verificar integridad
                            </button>
                          </form>
                        )}
                      </div>
                    </TableCell>
                    {showIndexColumn && (
                      <TableCell>
                        {corpusStates?.get(ev.id) ? (
                          <EvidenceIndexStatus
                            state={corpusStates.get(ev.id)!}
                            projectId={projectId}
                            retryAction={indexEvidenceFormAction}
                            evidenceTitle={ev.title}
                          />
                        ) : (
                          // The read model derives one state per evidence row of
                          // the project, so a gap here means the two lists
                          // disagree. An em dash says "not known" instead of
                          // inventing a phase for a row nobody described.
                          <span className="text-xs text-muted-foreground/60">—</span>
                        )}
                      </TableCell>
                    )}
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
                        {canErase && !isErased && (
                          <form
                            action={requestErasureAction}
                            className="flex flex-col gap-1 rounded border border-danger/30 bg-danger/5 p-2 basis-full"
                          >
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="evidenceId" value={ev.id} />
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-danger">
                              Borrado gobernado de contenido (irreversible)
                            </span>
                            <p className="text-[10px] text-muted-foreground">
                              No es un DELETE ordinario: el registro y su linaje permanecen; solo el
                              contenido se borra y queda un tombstone permanente.
                            </p>
                            <label htmlFor={erasureReasonId} className="sr-only">
                              Motivo del borrado
                            </label>
                            <Select
                              id={erasureReasonId}
                              name="erasureReason"
                              defaultValue=""
                              required
                              className="h-7 text-xs"
                            >
                              <option value="" disabled>
                                Motivo…
                              </option>
                              {ERASURE_REASON_OPTIONS.map(([value, label]) => (
                                <option key={value} value={value}>
                                  {label}
                                </option>
                              ))}
                            </Select>
                            <label htmlFor={erasureRationaleId} className="sr-only">
                              Justificación
                            </label>
                            <textarea
                              id={erasureRationaleId}
                              name="rationale"
                              rows={2}
                              required
                              placeholder="Justificación (requerida)"
                              className={TEXTAREA_CLASS}
                            />
                            <button
                              type="submit"
                              className="inline-flex items-center justify-center rounded border border-danger bg-background px-2 py-1 text-xs font-semibold text-danger hover:bg-danger/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              Solicitar borrado de contenido
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
                {/* G-01. Said at the point of upload, because "stored" and
                    "indexable" diverge here and nowhere else — every accepted
                    type is stored; only these feed grounded answers. Derived
                    from the extractor's own table, so it cannot claim a format
                    the pipeline would skip. */}
                {corpus.status === 'ready' && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Se indexa para grounding:{' '}
                    <span className="text-foreground">{GROUNDING_INDEXABLE_UPLOAD_TYPES}</span>. El
                    resto se almacena como evidencia con su hash, pero no alimenta respuestas
                    fundamentadas.
                  </p>
                )}
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

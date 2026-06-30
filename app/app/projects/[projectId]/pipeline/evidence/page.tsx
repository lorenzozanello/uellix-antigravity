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
  draft: { variant: 'neutral', label: 'Draft' },
  under_review: { variant: 'info', label: 'Under Review' },
  approved: { variant: 'success', label: 'Approved' },
  rejected: { variant: 'danger', label: 'Rejected' },
  archived: { variant: 'neutral', label: 'Archived' },
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y'
const FILE_INPUT_CLASS =
  'mt-1 block w-full text-sm text-foreground file:mr-3 file:rounded file:border file:border-border file:bg-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/80 focus:outline-none'

export default async function EvidencePage({ params }: { params: { projectId: string } }) {
  const { membership } = await requireOrganizationAccess()
  const canCreate = canUploadEvidence(membership.role)
  const canArchive = hasRole(membership.role, 'analyst')
  const canReview = hasRole(membership.role, 'impact_manager')

  const evidences = await listEvidenceForProject(params.projectId)
  const outcomes = await fetchOutcomes(params.projectId)
  const indicators = await fetchIndicators(params.projectId)

  return (
    <div className="space-y-6 max-w-5xl">
      <PipelineStepHeader
        step={5}
        title="Evidence"
        description="Register traceable evidence items linked to outcomes and indicators. Each item receives an immutable SHA-256 hash for audit traceability."
        methodologyNote="Evidence registered here does not constitute automatic certification. All items require human review before use in external SROI reporting."
      />

      <Stepper />

      <StellaAdvisorPanel projectId={params.projectId} step="Evidence" />

      {/* Evidence list */}
      <section aria-labelledby="evidence-list-heading">
        <h2
          id="evidence-list-heading"
          className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Registered Evidence
        </h2>

        {evidences.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-6 w-6 text-neutral-500" />}
            title="No evidence registered"
            description="No evidence items have been submitted for this project. Use the forms below to register file, URL, or text evidence."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Review Status</TableHead>
                <TableHead>SHA-256 Hash</TableHead>
                <TableHead>Registered</TableHead>
                <TableHead>Actions</TableHead>
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
                          aria-label={`SHA-256 hash (truncated): ${ev.contentHash.slice(0, 8)}`}
                        >
                          {ev.contentHash.slice(0, 8)}…
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground/60">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(ev.createdAt).toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        {canReview && ev.status !== 'archived' && (
                          <form action={updateStatusAction} className="inline-flex items-center gap-1">
                            <input type="hidden" name="projectId" value={params.projectId} />
                            <input type="hidden" name="evidenceId" value={ev.id} />
                            <label htmlFor={reviewSelectId} className="sr-only">
                              Update review status
                            </label>
                            <Select
                              id={reviewSelectId}
                              name="status"
                              defaultValue=""
                              className="h-7 text-xs"
                            >
                              <option value="" disabled>
                                Review…
                              </option>
                              <option value="approved">Approve</option>
                              <option value="rejected">Reject</option>
                              <option value="under_review">Under Review</option>
                            </Select>
                            <button
                              type="submit"
                              className="inline-flex items-center rounded border border-border bg-background px-2 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              OK
                            </button>
                          </form>
                        )}
                        {canArchive && ev.status !== 'archived' && (
                          <form action={archiveAction} className="inline-flex">
                            <input type="hidden" name="projectId" value={params.projectId} />
                            <input type="hidden" name="evidenceId" value={ev.id} />
                            <button
                              type="submit"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                              aria-label={`Archive evidence: ${ev.title}`}
                            >
                              <Archive className="h-3 w-3" aria-hidden="true" />
                              Archive
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
            Add Evidence
          </h2>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* File form */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Upload File</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Upload a document. A SHA-256 hash will be computed and stored for integrity
                  verification.
                </p>
              </CardHeader>
              <CardContent>
                <form action={fileAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={params.projectId} />

                  <div>
                    <label
                      htmlFor="file-outcome"
                      className="block text-xs font-medium text-foreground"
                    >
                      Link to outcome
                    </label>
                    <Select id="file-outcome" name="outcomeId" className="mt-1">
                      <option value="">None</option>
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
                      Link to indicator
                    </label>
                    <Select id="file-indicator" name="indicatorId" className="mt-1">
                      <option value="">None</option>
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
                      Title <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="file-title"
                      name="title"
                      type="text"
                      required
                      placeholder="Descriptive evidence title"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="file-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Description
                    </label>
                    <textarea
                      id="file-description"
                      name="description"
                      rows={2}
                      placeholder="Optional methodological context"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="file-file"
                      className="block text-xs font-medium text-foreground"
                    >
                      File <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="file-file"
                      type="file"
                      name="file"
                      required
                      className={FILE_INPUT_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      SHA-256 hash computed automatically on upload.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Upload File
                  </button>
                </form>
              </CardContent>
            </Card>

            {/* URL form */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Link2 className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Register URL</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Register an external URL as a traceable evidence source. URL content is not
                  fetched or stored.
                </p>
              </CardHeader>
              <CardContent>
                <form action={urlAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={params.projectId} />

                  <div>
                    <label
                      htmlFor="url-outcome"
                      className="block text-xs font-medium text-foreground"
                    >
                      Link to outcome
                    </label>
                    <Select id="url-outcome" name="outcomeId" className="mt-1">
                      <option value="">None</option>
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
                      Link to indicator
                    </label>
                    <Select id="url-indicator" name="indicatorId" className="mt-1">
                      <option value="">None</option>
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
                      Title <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="url-title"
                      name="title"
                      type="text"
                      required
                      placeholder="Descriptive evidence title"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="url-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Description
                    </label>
                    <textarea
                      id="url-description"
                      name="description"
                      rows={2}
                      placeholder="Optional methodological context"
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
                      placeholder="https://example.com/source"
                      className={INPUT_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      URL content is not fetched. Only the reference is stored.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Register URL
                  </button>
                </form>
              </CardContent>
            </Card>

            {/* Text form */}
            <Card>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <AlignLeft className="h-4 w-4 text-[#FF6A00]" aria-hidden="true" />
                  <CardTitle className="text-sm">Register Text Statement</CardTitle>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Register a text statement or declaration as evidence. Content is hashed for
                  immutable audit traceability.
                </p>
              </CardHeader>
              <CardContent>
                <form action={textAction} className="space-y-3">
                  <input type="hidden" name="projectId" value={params.projectId} />

                  <div>
                    <label
                      htmlFor="text-outcome"
                      className="block text-xs font-medium text-foreground"
                    >
                      Link to outcome
                    </label>
                    <Select id="text-outcome" name="outcomeId" className="mt-1">
                      <option value="">None</option>
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
                      Link to indicator
                    </label>
                    <Select id="text-indicator" name="indicatorId" className="mt-1">
                      <option value="">None</option>
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
                      Title <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <input
                      id="text-title"
                      name="title"
                      type="text"
                      required
                      placeholder="Descriptive evidence title"
                      className={INPUT_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="text-description"
                      className="block text-xs font-medium text-foreground"
                    >
                      Description
                    </label>
                    <textarea
                      id="text-description"
                      name="description"
                      rows={2}
                      placeholder="Optional methodological context"
                      className={TEXTAREA_CLASS}
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="text-text"
                      className="block text-xs font-medium text-foreground"
                    >
                      Statement text <span className="text-danger" aria-hidden="true">*</span>
                    </label>
                    <textarea
                      id="text-text"
                      name="text"
                      rows={3}
                      required
                      placeholder="Methodological declaration or data statement…"
                      className={TEXTAREA_CLASS}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      This text will be SHA-256 hashed for audit traceability.
                    </p>
                  </div>

                  <button
                    type="submit"
                    className="w-full inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                  >
                    Register Statement
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

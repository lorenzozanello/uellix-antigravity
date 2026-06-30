import Stepper from '@/components/sroi/Stepper'
import { PipelineStepHeader } from '@/components/sroi/PipelineStepHeader'
import { calculateSroiRunAction } from './calculateSroiRun.action'
import { upsertProjectInvestmentAction } from './upsertProjectInvestment.action'
import { upsertSroiAssignmentInputAction } from './upsertSroiAssignmentInput.action'
import { upsertSroiFilterSetAction } from './upsertSroiFilterSet.action'
import Link from 'next/link'
import { BarChart2, GitCompare, FileText, CheckCircle2, AlertTriangle, Info, Calculator } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { EmptyState } from '@/components/states/EmptyState'
import { StellaValidatorPanel } from '@/components/stella'
import {
  listSroiCalculationRuns,
  getSroiCalculationReadiness,
  calculateSroiPreview,
} from '@/lib/pipeline/sroi-calculation'
import { requireOrganizationAccess } from '@/lib/auth/session'
import { db } from '@/db/client'
import {
  outcomeProxyAssignments,
  projectInvestments,
  sroiAssignmentInputs,
  sroiFilterSets,
  financialProxies,
  outcomes,
} from '@/db/schema'
import { eq, and } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

export const dynamic = 'force-dynamic'

const RUN_STATUS: Record<string, { variant: 'success' | 'warning' | 'danger' | 'neutral'; label: string }> = {
  calculated: { variant: 'success', label: 'Calculated' },
  pending:    { variant: 'warning', label: 'Pending' },
  failed:     { variant: 'danger',  label: 'Failed' },
}

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'

export default async function CalculationPage({ params }: { params: { projectId: string } }) {
  const ctx = await requireOrganizationAccess()
  const canEdit = ctx && ['organization_admin', 'impact_manager', 'analyst'].includes(ctx.membership.role)

  const readiness = await getSroiCalculationReadiness(params.projectId)
  const preview   = await calculateSroiPreview(params.projectId).catch(() => null)
  const runs      = await listSroiCalculationRuns(params.projectId)

  const investment = await db
    .select()
    .from(projectInvestments)
    .where(
      and(
        eq(projectInvestments.projectId, params.projectId),
        eq(projectInvestments.status, 'active')
      )
    )
    .limit(1)
    .then((rows) => rows[0] ?? null)

  const assignmentsData = await db
    .select({
      assignment: outcomeProxyAssignments,
      outcome: outcomes,
      proxy: financialProxies,
    })
    .from(outcomeProxyAssignments)
    .innerJoin(outcomes, eq(outcomes.id, outcomeProxyAssignments.outcomeId))
    .innerJoin(financialProxies, eq(financialProxies.id, outcomeProxyAssignments.proxyId))
    .where(
      and(
        eq(outcomeProxyAssignments.projectId, params.projectId),
        eq(outcomeProxyAssignments.organizationId, ctx.organization.id),
        eq(outcomeProxyAssignments.assignmentStatus, 'active')
      )
    )

  const inputs = await db
    .select()
    .from(sroiAssignmentInputs)
    .where(eq(sroiAssignmentInputs.organizationId, ctx.organization.id))

  const filterSets = await db
    .select()
    .from(sroiFilterSets)
    .where(eq(sroiFilterSets.organizationId, ctx.organization.id))

  const inputMap     = new Map(inputs.map((i) => [i.assignmentId, i]))
  const filterSetMap = new Map(filterSets.map((f) => [f.assignmentId, f]))

  // Lookup map for preview line items: assignmentId → display names
  const assignmentLookup = new Map(
    assignmentsData.map(({ assignment, outcome, proxy }) => [
      assignment.id,
      { outcomeName: outcome.title, proxyName: proxy.name },
    ])
  )

  // Server Actions — wiring unchanged
  async function handleUpsertInvestment(formData: FormData) {
    'use server'
    await upsertProjectInvestmentAction(formData)
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`)
  }

  async function handleUpsertAssignmentInput(formData: FormData) {
    'use server'
    await upsertSroiAssignmentInputAction(formData)
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`)
  }

  async function handleUpsertFilterSet(formData: FormData) {
    'use server'
    await upsertSroiFilterSetAction(formData)
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`)
  }

  async function handleCalculateRun(formData: FormData) {
    'use server'
    await calculateSroiRunAction(formData)
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`)
  }

  return (
    <div className="space-y-8 max-w-5xl">
      <PipelineStepHeader
        step={8}
        title="SROI Calculation"
        description="Configure investment, assign impact quantities and SROI filters, then generate a traceable calculation run."
        methodologyNote="Based on Social Value International SROI Standard Principles 3–7: value the things that matter, only include what is material, do not over-claim."
      />

      <Stepper />

      {/* Quick navigation */}
      <section aria-label="Related views" className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Link
          href={`/app/projects/${params.projectId}/pipeline`}
          className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <Card className="h-full hover:shadow-md transition-shadow group-focus-visible:ring-2 group-focus-visible:ring-ring">
            <CardContent className="p-5 flex gap-3 items-start">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#FF6A00]/10 text-[#FF6A00]" aria-hidden="true">
                <BarChart2 className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">Pipeline Steps</p>
                <p className="text-xs text-muted-foreground mt-0.5">View all SROI pipeline stages and current progress</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link
          href={`/app/projects/${params.projectId}/pipeline/calculation/compare`}
          className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <Card className="h-full hover:shadow-md transition-shadow">
            <CardContent className="p-5 flex gap-3 items-start">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
                <GitCompare className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">Compare Runs</p>
                <p className="text-xs text-muted-foreground mt-0.5">Analyse differences between two runs</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Link
          href={`/app/projects/${params.projectId}/report`}
          className="group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
        >
          <Card className="h-full hover:shadow-md transition-shadow">
            <CardContent className="p-5 flex gap-3 items-start">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
                <FileText className="h-4 w-4" />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">SROI Reports</p>
                <p className="text-xs text-muted-foreground mt-0.5">Manage report drafts linked to runs</p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </section>

      {/* Methodology notice */}
      <div className="flex gap-3 rounded-lg border border-border bg-muted/30 p-4" role="note">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            This panel performs a{' '}
            <strong className="font-semibold text-foreground">traceable methodological calculation</strong>{' '}
            of social return on investment (SROI).
          </p>
          <p>
            Results represent a{' '}
            <strong className="font-semibold text-foreground">preliminary SROI ratio</strong>{' '}
            that requires{' '}
            <strong className="font-semibold text-foreground">human review</strong>{' '}
            before final validation. This output does not constitute independent certification or audit.
          </p>
        </div>
      </div>

      {/* Readiness */}
      <Card>
        <CardHeader>
          <CardTitle>Calculation Readiness</CardTitle>
          <CardDescription>Minimum requirements to generate a valid SROI calculation run</CardDescription>
        </CardHeader>
        <CardContent>
          {readiness.canCalculate ? (
            <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-4">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-700" aria-hidden="true" />
              <div>
                <p className="font-semibold text-green-800">Ready to calculate</p>
                <p className="text-sm text-green-700 mt-0.5">
                  All minimum requirements are complete. You can now save a calculation run.
                </p>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-red-200 bg-red-50 p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-700" aria-hidden="true" />
                <p className="font-semibold text-red-800 text-sm">Requirements missing to enable calculation:</p>
              </div>
              <ul className="space-y-1 pl-6 list-disc">
                {readiness.blockingReasons.map((reason, idx) => (
                  <li key={idx} className="text-sm text-red-700">{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <StellaValidatorPanel projectId={params.projectId} step="Calculation" />

      {/* Investment */}
      <Card>
        <CardHeader>
          <CardTitle>Project Investment</CardTitle>
          <CardDescription>
            Total capital deployed in the intervention period. Used as the denominator in the SROI ratio.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {investment && (
            <div className="rounded-md border border-border bg-muted/30 p-4 text-sm space-y-1">
              <p>
                <span className="font-medium text-foreground">Current amount:</span>{' '}
                <span className="text-foreground">{investment.amount} {investment.currency}</span>
              </p>
              {investment.year && (
                <p>
                  <span className="font-medium text-foreground">Reference year:</span>{' '}
                  <span className="text-muted-foreground">{investment.year}</span>
                </p>
              )}
              {investment.description && (
                <p>
                  <span className="font-medium text-foreground">Notes:</span>{' '}
                  <span className="text-muted-foreground">{investment.description}</span>
                </p>
              )}
            </div>
          )}

          <form action={handleUpsertInvestment} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input type="hidden" name="projectId" value={params.projectId} />

            <div>
              <label htmlFor="inv-amount" className="block text-sm font-medium text-foreground">
                Investment Amount <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <input
                id="inv-amount"
                name="amount"
                type="text"
                required
                disabled={!canEdit}
                defaultValue={investment?.amount ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="inv-currency" className="block text-sm font-medium text-foreground">
                Currency <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <input
                id="inv-currency"
                name="currency"
                type="text"
                required
                disabled={!canEdit}
                defaultValue={investment?.currency ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="inv-year" className="block text-sm font-medium text-foreground">
                Reference Year
                <span className="ml-1 text-xs text-muted-foreground font-normal">(optional)</span>
              </label>
              <input
                id="inv-year"
                name="year"
                type="number"
                disabled={!canEdit}
                defaultValue={investment?.year ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="inv-description" className="block text-sm font-medium text-foreground">
                Notes
                <span className="ml-1 text-xs text-muted-foreground font-normal">(optional)</span>
              </label>
              <input
                id="inv-description"
                name="description"
                type="text"
                disabled={!canEdit}
                defaultValue={investment?.description ?? ''}
                className={INPUT_CLASS}
              />
            </div>

            {canEdit && (
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                >
                  Save Investment
                </button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>

      {/* Assignment Inputs & SROI Filters */}
      <section aria-labelledby="assignments-heading">
        <h2
          id="assignments-heading"
          className="mb-4 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Assignment Inputs &amp; SROI Filters
        </h2>

        {assignmentsData.length === 0 ? (
          <EmptyState
            title="No active proxy assignments"
            description="Assign financial proxies to outcomes in the Proxies step before configuring inputs and filters."
          />
        ) : (
          <div className="space-y-4">
            {assignmentsData.map(({ assignment, outcome, proxy }) => {
              const currentInput  = inputMap.get(assignment.id)
              const currentFilter = filterSetMap.get(assignment.id)

              return (
                <Card key={assignment.id}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base text-foreground">{outcome.title}</CardTitle>
                    <CardDescription>
                      Proxy: <strong className="text-foreground">{proxy.name}</strong>
                      {' '}— {proxy.value} {proxy.currency} / {proxy.unit}
                    </CardDescription>
                  </CardHeader>

                  <CardContent>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Quantities & Inputs */}
                      <form action={handleUpsertAssignmentInput} className="space-y-3">
                        <p className="text-sm font-semibold text-foreground">Quantities &amp; Inputs</p>
                        <input type="hidden" name="projectId" value={params.projectId} />
                        <input type="hidden" name="assignmentId" value={assignment.id} />

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label
                              htmlFor={`qty-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Quantity <span className="text-red-500" aria-hidden="true">*</span>
                            </label>
                            <input
                              id={`qty-${assignment.id}`}
                              name="quantity"
                              type="text"
                              required
                              disabled={!canEdit}
                              defaultValue={currentInput?.quantity ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`unit-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Unit <span className="text-red-500" aria-hidden="true">*</span>
                            </label>
                            <input
                              id={`unit-${assignment.id}`}
                              name="unit"
                              type="text"
                              required
                              disabled={!canEdit}
                              defaultValue={currentInput?.unit ?? proxy.unit ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`inp-year-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Year
                              <span className="ml-1 text-[10px] text-muted-foreground font-normal">(optional)</span>
                            </label>
                            <input
                              id={`inp-year-${assignment.id}`}
                              name="year"
                              type="number"
                              disabled={!canEdit}
                              defaultValue={currentInput?.year ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`inp-notes-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Notes
                              <span className="ml-1 text-[10px] text-muted-foreground font-normal">(optional)</span>
                            </label>
                            <input
                              id={`inp-notes-${assignment.id}`}
                              name="notes"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentInput?.notes ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                        </div>

                        {canEdit && (
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                          >
                            Save Inputs
                          </button>
                        )}
                      </form>

                      {/* SROI Filters */}
                      <form action={handleUpsertFilterSet} className="space-y-3">
                        <p className="text-sm font-semibold text-foreground">SROI Impact Filters</p>
                        <p className="text-xs text-muted-foreground">
                          Percentage adjustments that account for methodological assumptions about impact attribution.
                        </p>
                        <input type="hidden" name="projectId" value={params.projectId} />
                        <input type="hidden" name="assignmentId" value={assignment.id} />

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label
                              htmlFor={`dw-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Deadweight %
                            </label>
                            <input
                              id={`dw-${assignment.id}`}
                              name="deadweightPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.deadweightPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % that would have occurred without the intervention
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`at-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Attribution %
                            </label>
                            <input
                              id={`at-${assignment.id}`}
                              name="attributionPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.attributionPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % attributable to other actors
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`dp-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Displacement %
                            </label>
                            <input
                              id={`dp-${assignment.id}`}
                              name="displacementPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.displacementPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % of positive effects offset elsewhere
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`do-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Drop-off %
                            </label>
                            <input
                              id={`do-${assignment.id}`}
                              name="dropoffPct"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.dropoffPct ?? '0'}
                              className={INPUT_CLASS}
                            />
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              % annual reduction in impact after year 1
                            </p>
                          </div>
                          <div>
                            <label
                              htmlFor={`dur-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Duration (years)
                            </label>
                            <input
                              id={`dur-${assignment.id}`}
                              name="durationYears"
                              type="number"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.durationYears ?? 1}
                              className={INPUT_CLASS}
                            />
                          </div>
                          <div>
                            <label
                              htmlFor={`just-${assignment.id}`}
                              className="block text-xs font-medium text-foreground"
                            >
                              Justification
                              <span className="ml-1 text-[10px] text-muted-foreground font-normal">(optional)</span>
                            </label>
                            <input
                              id={`just-${assignment.id}`}
                              name="justification"
                              type="text"
                              disabled={!canEdit}
                              defaultValue={currentFilter?.justification ?? ''}
                              className={INPUT_CLASS}
                            />
                          </div>
                        </div>

                        {canEdit && (
                          <button
                            type="submit"
                            className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
                          >
                            Save Filters
                          </button>
                        )}
                      </form>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      {/* Preview Results */}
      {preview?.canCalculate && preview.result && (
        <Card>
          <CardHeader>
            <CardTitle>Preview Results</CardTitle>
            <CardDescription>
              Preliminary calculation based on current inputs. Requires human review before use in reports.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* KPI summary */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Preliminary SROI Ratio</p>
                <p className="mt-1 text-2xl font-bold text-foreground tabular-nums font-ibm-plex-mono">
                  {parseFloat(preview.result.sroiRatio.toString()).toFixed(2)}:1
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Net Social Value</p>
                <p className="mt-1 text-xl font-bold text-foreground">
                  {parseFloat(preview.result.netSocialValue.toString()).toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">{preview.result.currency}</span>
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Gross Social Value</p>
                <p className="mt-1 text-xl font-bold text-foreground">
                  {parseFloat(preview.result.grossSocialValue.toString()).toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">{preview.result.currency}</span>
                </p>
              </div>
              <div className="rounded-md border border-border bg-muted/30 p-4">
                <p className="text-xs font-medium text-muted-foreground">Total Investment</p>
                <p className="mt-1 text-xl font-bold text-foreground">
                  {parseFloat(preview.result.totalInvestment.toString()).toLocaleString()}{' '}
                  <span className="text-sm font-normal text-muted-foreground">{preview.result.currency}</span>
                </p>
              </div>
            </div>

            {/* Line items breakdown */}
            <div>
              <h3 className="mb-3 text-sm font-semibold text-foreground">Calculation Line Items</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Outcome / Proxy</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Proxy Value</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Adjusted (Net)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.result.lineItems.map((li, idx) => {
                    const info = assignmentLookup.get(li.assignmentId)
                    return (
                      <TableRow key={idx}>
                        <TableCell>
                          <p className="font-medium text-foreground text-sm">
                            {info?.outcomeName ?? `Assignment ${li.assignmentId.slice(0, 8)}…`}
                          </p>
                          {info?.proxyName && (
                            <p className="text-xs text-muted-foreground">{info.proxyName}</p>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            DW {li.deadweightPct}% · AT {li.attributionPct}% · DP {li.displacementPct}% · DO {li.dropoffPct}% · {li.durationYears}yr
                          </p>
                        </TableCell>
                        <TableCell className="text-right">{li.quantity}</TableCell>
                        <TableCell className="text-right">
                          {li.proxyValue.toLocaleString()} {li.currency}
                        </TableCell>
                        <TableCell className="text-right">
                          {li.grossValue.toLocaleString()} {li.currency}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-foreground">
                          {li.adjustedValue.toLocaleString()} {li.currency}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Register run */}
            {canEdit && (
              <div className="border-t border-border pt-4">
                <p className="text-xs text-muted-foreground mb-3">
                  Registering a run persists the current calculation with its full audit trail. This cannot be undone.
                </p>
                <form action={handleCalculateRun}>
                  <input type="hidden" name="projectId" value={params.projectId} />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors shadow-sm"
                  >
                    <Calculator className="h-4 w-4" aria-hidden="true" />
                    Save Calculation Run
                  </button>
                </form>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Run History */}
      <Card>
        <CardHeader>
          <CardTitle>Calculation Run History</CardTitle>
          <CardDescription>
            All registered SROI calculation runs for this project. Each run is immutable and audit-traceable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <EmptyState
              title="No calculation runs yet"
              description="Complete the investment and assignment inputs above, then save your first calculation run."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Investment</TableHead>
                  <TableHead className="text-right">Gross Value</TableHead>
                  <TableHead className="text-right">Net Value</TableHead>
                  <TableHead className="text-right">SROI Ratio</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => {
                  const statusConfig = RUN_STATUS[run.status] ?? { variant: 'neutral' as const, label: run.status }
                  return (
                    <TableRow key={run.id}>
                      <TableCell className="font-medium">v{run.version}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(run.createdAt).toLocaleString('en-US', {
                          year: 'numeric', month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </TableCell>
                      <TableCell className="text-right">
                        {run.totalInvestment ? parseFloat(run.totalInvestment).toLocaleString() : '0'}{' '}
                        <span className="text-xs text-muted-foreground">{run.currency}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {run.grossSocialValue ? parseFloat(run.grossSocialValue).toLocaleString() : '0'}{' '}
                        <span className="text-xs text-muted-foreground">{run.currency}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {run.netSocialValue ? parseFloat(run.netSocialValue).toLocaleString() : '0'}{' '}
                        <span className="text-xs text-muted-foreground">{run.currency}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className="font-bold text-foreground tabular-nums font-ibm-plex-mono">
                          {run.sroiRatio ? parseFloat(run.sroiRatio).toFixed(2) : '0.00'}:1
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/app/projects/${params.projectId}/pipeline/calculation/runs/${run.id}`}
                          className="text-xs font-medium text-[#B85200] hover:text-[#B85200]/80 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                          aria-label={`View run v${run.version} details`}
                        >
                          View →
                        </Link>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

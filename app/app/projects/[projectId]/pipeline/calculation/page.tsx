import Stepper from '@/components/sroi/Stepper';
import { calculateSroiRunAction } from './calculateSroiRun.action';
import { upsertProjectInvestmentAction } from './upsertProjectInvestment.action';
import { upsertSroiAssignmentInputAction } from './upsertSroiAssignmentInput.action';
import { upsertSroiFilterSetAction } from './upsertSroiFilterSet.action';
import {
  listSroiCalculationRuns,
  getSroiCalculationReadiness,
  calculateSroiPreview,
} from '@/lib/pipeline/sroi-calculation';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { db } from '@/db/client';
import {
  outcomeProxyAssignments,
  projectInvestments,
  sroiAssignmentInputs,
  sroiFilterSets,
  financialProxies,
  outcomes,
} from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

export default async function CalculationPage({ params }: { params: { projectId: string } }) {
  const ctx = await requireOrganizationAccess();
  const canEdit = ctx && ['organization_admin', 'impact_manager', 'analyst'].includes(ctx.membership.role);

  // Load readiness, preview and previous runs server‑side
  const readiness = await getSroiCalculationReadiness(params.projectId);
  const preview = await calculateSroiPreview(params.projectId);
  const runs = await listSroiCalculationRuns(params.projectId);

  // Load current investment
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
    .then((rows) => rows[0] ?? null);

  // Load assignments and inputs/filters to render inline forms
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
    );

  const inputs = await db
    .select()
    .from(sroiAssignmentInputs)
    .where(eq(sroiAssignmentInputs.organizationId, ctx.organization.id));

  const filterSets = await db
    .select()
    .from(sroiFilterSets)
    .where(eq(sroiFilterSets.organizationId, ctx.organization.id));

  const inputMap = new Map(inputs.map((i) => [i.assignmentId, i]));
  const filterSetMap = new Map(filterSets.map((f) => [f.assignmentId, f]));

  // Server Actions for mutation
  async function handleUpsertInvestment(formData: FormData) {
    'use server';
    await upsertProjectInvestmentAction(formData);
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`);
  }

  async function handleUpsertAssignmentInput(formData: FormData) {
    'use server';
    await upsertSroiAssignmentInputAction(formData);
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`);
  }

  async function handleUpsertFilterSet(formData: FormData) {
    'use server';
    await upsertSroiFilterSetAction(formData);
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`);
  }

  async function handleCalculateRun(formData: FormData) {
    'use server';
    await calculateSroiRunAction(formData);
    revalidatePath(`/app/projects/${params.projectId}/pipeline/calculation`);
  }

  return (
    <div className="p-4 space-y-8">
      <h1 className="text-2xl font-bold">Cálculo SROI</h1>
      <Stepper />

      {/* Methodology and Limits Header */}
      <section className="bg-gray-50 p-4 rounded text-sm text-gray-700 space-y-2">
        <p>
          Este panel permite realizar un <strong>cálculo metodológico trazable</strong> del retorno social de la inversión (SROI).
        </p>
        <p>
          El resultado obtenido corresponde a un <strong>ratio SROI preliminar</strong> y <strong>requiere revisión humana</strong> para su validación final. No constituye una certificación automática ni auditoría independiente.
        </p>
      </section>

      {/* Readiness Panel */}
      <section className="border rounded p-4 bg-white shadow-sm space-y-3">
        <h2 className="text-lg font-semibold">Estado de Preparación (Readiness)</h2>
        {readiness.canCalculate ? (
          <div className="p-3 bg-green-50 text-green-800 rounded font-medium">
            ¡Listo para calcular! Todos los requerimientos mínimos están completos.
          </div>
        ) : (
          <div className="p-3 bg-red-50 text-red-800 rounded space-y-2">
            <p className="font-semibold">Requerimientos faltantes para habilitar el cálculo:</p>
            <ul className="list-disc pl-5 space-y-1 text-sm">
              {readiness.blockingReasons.map((reason, idx) => (
                <li key={idx}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Inversión Section */}
      <section className="border rounded p-4 bg-white shadow-sm space-y-4">
        <h2 className="text-lg font-semibold">Inversión del Proyecto</h2>
        {investment ? (
          <div className="p-3 bg-gray-50 rounded text-sm space-y-1">
            <p><strong>Monto Actual:</strong> {investment.amount} {investment.currency}</p>
            {investment.year && <p><strong>Año:</strong> {investment.year}</p>}
            {investment.description && <p><strong>Descripción:</strong> {investment.description}</p>}
          </div>
        ) : (
          <p className="text-sm text-gray-500 italic">No se ha registrado ninguna inversión para este proyecto.</p>
        )}

        <form action={handleUpsertInvestment} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <input type="hidden" name="projectId" value={params.projectId} />
          <label className="block text-sm font-medium text-gray-700">
            Monto de Inversión:
            <input
              name="amount"
              type="text"
              required
              disabled={!canEdit}
              defaultValue={investment?.amount ?? ''}
              className="mt-1 block w-full rounded border-gray-300 shadow-sm focus:border-teal-500 focus:ring focus:ring-teal-200"
            />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Moneda:
            <input
              name="currency"
              type="text"
              required
              disabled={!canEdit}
              defaultValue={investment?.currency ?? ''}
              className="mt-1 block w-full rounded border-gray-300 shadow-sm focus:border-teal-500 focus:ring focus:ring-teal-200"
            />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Año de Referencia (opcional):
            <input
              name="year"
              type="number"
              disabled={!canEdit}
              defaultValue={investment?.year ?? ''}
              className="mt-1 block w-full rounded border-gray-300 shadow-sm focus:border-teal-500 focus:ring focus:ring-teal-200"
            />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            Descripción/Notas (opcional):
            <input
              name="description"
              type="text"
              disabled={!canEdit}
              defaultValue={investment?.description ?? ''}
              className="mt-1 block w-full rounded border-gray-300 shadow-sm focus:border-teal-500 focus:ring focus:ring-teal-200"
            />
          </label>
          {canEdit && (
            <div className="md:col-span-2">
              <button type="submit" className="bg-teal-600 hover:bg-teal-700 text-white px-4 py-2 rounded text-sm font-medium">
                Guardar Inversión
              </button>
            </div>
          )}
        </form>
      </section>

      {/* Active Assignments & Inputs/Filters Section */}
      <section className="border rounded p-4 bg-white shadow-sm space-y-6">
        <h2 className="text-lg font-semibold">Inputs y Filtros por Asignación</h2>
        {assignmentsData.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No hay asignaciones de proxies activas para este proyecto.</p>
        ) : (
          <div className="space-y-6">
            {assignmentsData.map(({ assignment, outcome, proxy }) => {
              const currentInput = inputMap.get(assignment.id);
              const currentFilter = filterSetMap.get(assignment.id);

              return (
                <div key={assignment.id} className="border rounded p-4 bg-gray-50 space-y-4">
                  <div className="border-b pb-2">
                    <h3 className="font-semibold text-teal-800">{outcome.title}</h3>
                    <p className="text-xs text-gray-600">
                      <strong>Proxy:</strong> {proxy.name} ({proxy.value} {proxy.currency} / {proxy.unit})
                    </p>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Assignment Input Form */}
                    <form action={handleUpsertAssignmentInput} className="space-y-3">
                      <h4 className="text-sm font-semibold text-gray-700">Cantidad e Inputs</h4>
                      <input type="hidden" name="projectId" value={params.projectId} />
                      <input type="hidden" name="assignmentId" value={assignment.id} />
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-xs font-medium text-gray-600">
                          Cantidad:
                          <input
                            name="quantity"
                            type="text"
                            required
                            disabled={!canEdit}
                            defaultValue={currentInput?.quantity ?? ''}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          Unidad:
                          <input
                            name="unit"
                            type="text"
                            required
                            disabled={!canEdit}
                            defaultValue={currentInput?.unit ?? proxy.unit ?? ''}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-xs font-medium text-gray-600">
                          Año (opcional):
                          <input
                            name="year"
                            type="number"
                            disabled={!canEdit}
                            defaultValue={currentInput?.year ?? ''}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          Notas (opcional):
                          <input
                            name="notes"
                            type="text"
                            disabled={!canEdit}
                            defaultValue={currentInput?.notes ?? ''}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                      </div>
                      {canEdit && (
                        <button type="submit" className="bg-teal-600 hover:bg-teal-700 text-white px-3 py-1 rounded text-xs font-medium">
                          Guardar Inputs
                        </button>
                      )}
                    </form>

                    {/* Assignment Filter Set Form */}
                    <form action={handleUpsertFilterSet} className="space-y-3">
                      <h4 className="text-sm font-semibold text-gray-700">Filtros de Impacto</h4>
                      <input type="hidden" name="projectId" value={params.projectId} />
                      <input type="hidden" name="assignmentId" value={assignment.id} />
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <label className="text-xs font-medium text-gray-600">
                          Deadweight %:
                          <input
                            name="deadweightPct"
                            type="text"
                            disabled={!canEdit}
                            defaultValue={currentFilter?.deadweightPct ?? '0'}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          Attribution %:
                          <input
                            name="attributionPct"
                            type="text"
                            disabled={!canEdit}
                            defaultValue={currentFilter?.attributionPct ?? '0'}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          Displacement %:
                          <input
                            name="displacementPct"
                            type="text"
                            disabled={!canEdit}
                            defaultValue={currentFilter?.displacementPct ?? '0'}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          Dropoff %:
                          <input
                            name="dropoffPct"
                            type="text"
                            disabled={!canEdit}
                            defaultValue={currentFilter?.dropoffPct ?? '0'}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-xs font-medium text-gray-600">
                          Duración (años):
                          <input
                            name="durationYears"
                            type="number"
                            disabled={!canEdit}
                            defaultValue={currentFilter?.durationYears ?? 1}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                        <label className="text-xs font-medium text-gray-600">
                          Justificación (opcional):
                          <input
                            name="justification"
                            type="text"
                            disabled={!canEdit}
                            defaultValue={currentFilter?.justification ?? ''}
                            className="mt-1 block w-full text-xs rounded border-gray-300"
                          />
                        </label>
                      </div>
                      {canEdit && (
                        <button type="submit" className="bg-teal-600 hover:bg-teal-700 text-white px-3 py-1 rounded text-xs font-medium">
                          Guardar Filtros
                        </button>
                      )}
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Preview Section */}
      {preview?.canCalculate && preview.result && (
        <section className="border rounded p-4 bg-white shadow-sm space-y-4">
          <h2 className="text-lg font-semibold">Vista Previa de Resultados</h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="p-3 bg-gray-50 rounded">
              <span className="text-xs text-gray-500 block">Ratio SROI Preliminar</span>
              <span className="text-xl font-bold text-teal-700">
                {parseFloat(preview.result.sroiRatio.toString()).toFixed(2)}:1
              </span>
            </div>
            <div className="p-3 bg-gray-50 rounded">
              <span className="text-xs text-gray-500 block">Valor Social Neto</span>
              <span className="text-xl font-bold text-gray-800">
                {parseFloat(preview.result.netSocialValue.toString()).toLocaleString()} {preview.result.currency}
              </span>
            </div>
            <div className="p-3 bg-gray-50 rounded">
              <span className="text-xs text-gray-500 block">Valor Social Bruto</span>
              <span className="text-xl font-bold text-gray-800">
                {parseFloat(preview.result.grossSocialValue.toString()).toLocaleString()} {preview.result.currency}
              </span>
            </div>
            <div className="p-3 bg-gray-50 rounded">
              <span className="text-xs text-gray-500 block">Inversión Total</span>
              <span className="text-xl font-bold text-gray-800">
                {parseFloat(preview.result.totalInvestment.toString()).toLocaleString()} {preview.result.currency}
              </span>
            </div>
          </div>

          <h3 className="font-semibold text-sm mt-3">Desglose de Líneas de Cálculo</h3>
          <table className="w-full table-auto border text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-2 py-1 text-left">Outcome / Proxy</th>
                <th className="px-2 py-1 text-right">Cantidad</th>
                <th className="px-2 py-1 text-right">Valor Proxy</th>
                <th className="px-2 py-1 text-right">Bruto</th>
                <th className="px-2 py-1 text-right">Ajustado (Neto)</th>
              </tr>
            </thead>
            <tbody>
              {preview.result.lineItems.map((li, idx) => (
                <tr key={idx} className="border-t">
                  <td className="px-2 py-1">
                    <p className="font-medium text-gray-800">ID Asignación: {li.assignmentId}</p>
                    <p className="text-[10px] text-gray-500">
                      DW: {li.deadweightPct}%, AT: {li.attributionPct}%, DP: {li.displacementPct}%, DO: {li.dropoffPct}%, Años: {li.durationYears}
                    </p>
                  </td>
                  <td className="px-2 py-1 text-right">{li.quantity}</td>
                  <td className="px-2 py-1 text-right">{li.proxyValue.toLocaleString()} {li.currency}</td>
                  <td className="px-2 py-1 text-right">{li.grossValue.toLocaleString()} {li.currency}</td>
                  <td className="px-2 py-1 text-right font-medium text-teal-700">{li.adjustedValue.toLocaleString()} {li.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Action to calculate and persist run */}
          {canEdit && (
            <form action={handleCalculateRun} className="pt-2">
              <input type="hidden" name="projectId" value={params.projectId} />
              <button type="submit" className="bg-teal-600 hover:bg-teal-700 text-white px-5 py-2 rounded text-sm font-semibold shadow">
                Guardar y Registrar Corrida Oficial
              </button>
            </form>
          )}
        </section>
      )}

      {/* Historial de Corridas */}
      <section className="border rounded p-4 bg-white shadow-sm space-y-4">
        <h2 className="text-lg font-semibold">Historial de Corridas SROI</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-gray-500 italic">No se han registrado corridas SROI para este proyecto.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full table-auto border text-sm text-left">
              <thead className="bg-gray-100 text-xs font-semibold">
                <tr>
                  <th className="px-3 py-2">Versión</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">Inversión</th>
                  <th className="px-3 py-2">Valor Bruto</th>
                  <th className="px-3 py-2">Valor Neto</th>
                  <th className="px-3 py-2">Ratio SROI</th>
                  <th className="px-3 py-2">Estado</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium">v{run.version}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      {run.totalInvestment ? parseFloat(run.totalInvestment).toLocaleString() : '0'} {run.currency}
                    </td>
                    <td className="px-3 py-2">
                      {run.grossSocialValue ? parseFloat(run.grossSocialValue).toLocaleString() : '0'} {run.currency}
                    </td>
                    <td className="px-3 py-2">
                      {run.netSocialValue ? parseFloat(run.netSocialValue).toLocaleString() : '0'} {run.currency}
                    </td>
                    <td className="px-3 py-2 font-bold text-teal-700">
                      {run.sroiRatio ? parseFloat(run.sroiRatio).toFixed(2) : '0.00'}:1
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <span className={`px-2 py-0.5 rounded-full font-medium ${
                        run.status === 'calculated'
                          ? 'bg-green-100 text-green-800'
                          : run.status === 'pending'
                          ? 'bg-yellow-100 text-yellow-800'
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {run.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}


// app/app/projects/[projectId]/pipeline/proxies/page.tsx

import Stepper from '@/components/sroi/Stepper';
import { getCurrentOrganizationContext } from '@/lib/auth/session';
import { listFinancialProxies, listProxySources, listProxyAssignmentsForProject } from '@/lib/pipeline/proxies';
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
import { createProxySourceAction } from '@/app/app/projects/[projectId]/pipeline/proxies/createProxySource.action';
import { createFinancialProxyAction } from '@/app/app/projects/[projectId]/pipeline/proxies/createFinancialProxy.action';
import { assignProxyToOutcomeAction } from '@/app/app/projects/[projectId]/pipeline/proxies/assignProxyToOutcome.action';
import { archiveOutcomeProxyAssignmentAction } from '@/app/app/projects/[projectId]/pipeline/proxies/archiveOutcomeProxyAssignment.action';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic'; // ensure server‑side fetching each request

export default async function ProxiesPage({ params }: { params: { projectId: string } }) {
  const ctx = await getCurrentOrganizationContext();
  const canEdit = ctx && ['organization_admin', 'impact_manager', 'analyst'].includes(ctx.membership.role);

  // Data fetching
  const [financialProxies, proxySources, assignments, outcomes] = await Promise.all([
    listFinancialProxies(),
    listProxySources(),
    listProxyAssignmentsForProject(params.projectId),
    fetchOutcomes(params.projectId),
  ]);

  // Form actions wrapped as Server Actions inside the Server Component
  async function handleCreateSource(formData: FormData) {
    'use server';
    const name = formData.get('name') as string;
    const url = formData.get('url') as string;
    const description = formData.get('description') as string;

    await createProxySourceAction(params.projectId, {
      name,
      url: url || undefined,
      description: description || undefined,
    });
    revalidatePath(`/app/projects/${params.projectId}/pipeline/proxies`);
  }

  async function handleCreateProxy(formData: FormData) {
    'use server';
    const sourceId = formData.get('sourceId') as string;
    const name = formData.get('name') as string;
    const description = formData.get('description') as string;
    const value = formData.get('value') as string;
    const currency = formData.get('currency') as string;
    const unit = formData.get('unit') as string;
    const referenceYearStr = formData.get('referenceYear') as string;
    const confidenceLevel = formData.get('confidenceLevel') as string;
    const methodologicalRisk = formData.get('methodologicalRisk') as string;

    await createFinancialProxyAction(params.projectId, {
      sourceId,
      name,
      description: description || undefined,
      value,
      currency,
      unit,
      referenceYear: Number(referenceYearStr),
      confidenceLevel: confidenceLevel || undefined,
      methodologicalRisk: methodologicalRisk || undefined,
    });
    revalidatePath(`/app/projects/${params.projectId}/pipeline/proxies`);
  }

  async function handleAssignProxy(formData: FormData) {
    'use server';
    const outcomeId = formData.get('outcomeId') as string;
    const proxyId = formData.get('proxyId') as string;
    const justification = formData.get('justification') as string;
    const territorialAdjustmentNotes = formData.get('territorialAdjustmentNotes') as string;

    await assignProxyToOutcomeAction(params.projectId, {
      outcomeId,
      proxyId,
      justification,
      territorialAdjustmentNotes: territorialAdjustmentNotes || undefined,
    });
    revalidatePath(`/app/projects/${params.projectId}/pipeline/proxies`);
  }

  async function handleArchiveAssignment(formData: FormData) {
    'use server';
    const assignmentId = formData.get('assignmentId') as string;

    await archiveOutcomeProxyAssignmentAction(params.projectId, {
      assignmentId,
    });
    revalidatePath(`/app/projects/${params.projectId}/pipeline/proxies`);
  }

  return (
    <div className="p-4 space-y-8">
      <h1 className="text-2xl font-bold">Proxies de la organización</h1>
      <Stepper />

      {/* Methodology header */}
      <section className="bg-gray-50 p-4 rounded">
        <p className="text-sm text-gray-700">
          Los proxies financieros presentados a continuación son trazables a fuentes oficiales, con justificación metodológica revisada por humanos. Se utilizan exclusivamente para análisis de impacto y no representan certificación automática.
        </p>
      </section>

      {/* Banco de Proxies */}
      <section>
        <h2 className="text-xl font-semibold mb-2">Banco de Proxies</h2>
        {financialProxies.length === 0 ? (
          <p className="text-gray-500">No hay proxies disponibles.</p>
        ) : (
          <table className="min-w-full table-auto border">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-2 py-1">Nombre</th>
                <th className="px-2 py-1">Fuente</th>
                <th className="px-2 py-1">Valor</th>
                <th className="px-2 py-1">Moneda</th>
                <th className="px-2 py-1">Unidad</th>
                <th className="px-2 py-1">Año</th>
                <th className="px-2 py-1">Estado</th>
                <th className="px-2 py-1">Confianza</th>
                <th className="px-2 py-1">Riesgo</th>
              </tr>
            </thead>
            <tbody>
              {financialProxies.map(p => (
                <tr key={p.id} className="border-t">
                  <td className="px-2 py-1">{p.name}</td>
                  <td className="px-2 py-1">{p.sourceId}</td>
                  <td className="px-2 py-1">{p.value}</td>
                  <td className="px-2 py-1">{p.currency}</td>
                  <td className="px-2 py-1">{p.unit}</td>
                  <td className="px-2 py-1">{p.referenceYear}</td>
                  <td className="px-2 py-1">{p.reviewStatus}</td>
                  <td className="px-2 py-1">{p.confidenceLevel ?? '-'}</td>
                  <td className="px-2 py-1">{p.methodologicalRisk ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Forms – visible only to permitted roles */}
      {canEdit && (
        <section className="space-y-6">
          {/* Crear Fuente */}
          <details className="border rounded p-3" open>
            <summary className="font-medium cursor-pointer">Crear Fuente</summary>
            <form action={handleCreateSource} className="mt-2 space-y-2">
              <input type="hidden" name="projectId" value={params.projectId} />
              <label>
                Nombre:<br />
                <input name="name" className="border rounded w-full" required />
              </label>
              <label>
                URL:<br />
                <input name="url" type="url" className="border rounded w-full" />
              </label>
              <label>
                Descripción:<br />
                <textarea name="description" className="border rounded w-full" rows={2} />
              </label>
              <button type="submit" className="bg-teal-600 text-white px-3 py-1 rounded">Crear Fuente</button>
            </form>
          </details>

          {/* Crear Proxy */}
          <details className="border rounded p-3" open>
            <summary className="font-medium cursor-pointer">Crear Proxy Financiero</summary>
            <form action={handleCreateProxy} className="mt-2 space-y-2">
              <input type="hidden" name="projectId" value={params.projectId} />
              <label>
                Fuente:<br />
                <select name="sourceId" className="border rounded w-full" required>
                  <option value="">Seleccione una fuente</option>
                  {proxySources.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Nombre:<br />
                <input name="name" className="border rounded w-full" required />
              </label>
              <label>
                Descripción:<br />
                <textarea name="description" className="border rounded w-full" rows={2} />
              </label>
              <label>
                Valor:<br />
                <input name="value" className="border rounded w-full" required />
              </label>
              <label>
                Moneda:<br />
                <input name="currency" className="border rounded w-full" required />
              </label>
              <label>
                Unidad:<br />
                <input name="unit" className="border rounded w-full" required />
              </label>
              <label>
                Año de referencia:<br />
                <input name="referenceYear" type="number" className="border rounded w-full" required />
              </label>
              <label>
                Confianza (high/medium/low):<br />
                <select name="confidenceLevel" className="border rounded w-full">
                  <option value="">N/A</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label>
                Riesgo metodológico:<br />
                <select name="methodologicalRisk" className="border rounded w-full">
                  <option value="">N/A</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <button type="submit" className="bg-teal-600 text-white px-3 py-1 rounded">Crear Proxy</button>
            </form>
          </details>

          {/* Asignar Proxy a Outcome */}
          <details className="border rounded p-3" open>
            <summary className="font-medium cursor-pointer">Asignar Proxy a Outcome</summary>
            <form action={handleAssignProxy} className="mt-2 space-y-2">
              <input type="hidden" name="projectId" value={params.projectId} />
              <label>
                Outcome:<br />
                <select name="outcomeId" className="border rounded w-full" required>
                  <option value="">Seleccione un outcome</option>
                  {outcomes.map(o => (
                    <option key={o.id} value={o.id}>{o.title}</option>
                  ))}
                </select>
              </label>
              <label>
                Proxy:<br />
                <select name="proxyId" className="border rounded w-full" required>
                  <option value="">Seleccione un proxy</option>
                  {financialProxies.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Justificación:<br />
                <textarea name="justification" className="border rounded w-full" rows={2} required />
              </label>
              <label>
                Nota de ajuste territorial (opcional):<br />
                <textarea name="territorialAdjustmentNotes" className="border rounded w-full" rows={2} />
              </label>
              <button type="submit" className="bg-teal-600 text-white px-3 py-1 rounded">Asignar</button>
            </form>
          </details>
        </section>
      )}

      {/* Listado de asignaciones */}
      <section>
        <h2 className="text-xl font-semibold mb-2">Asignaciones de Proxies</h2>
        {assignments.length === 0 ? (
          <p className="text-gray-500">No hay asignaciones.</p>
        ) : (
          <table className="min-w-full table-auto border">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-2 py-1">Outcome</th>
                <th className="px-2 py-1">Proxy</th>
                <th className="px-2 py-1">Justificación</th>
                <th className="px-2 py-1">Nota ajuste</th>
                <th className="px-2 py-1">Estado</th>
                {canEdit && <th className="px-2 py-1">Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {assignments.map(a => (
                <tr key={a.id} className="border-t">
                  <td className="px-2 py-1">{a.outcomeId}</td>
                  <td className="px-2 py-1">{a.proxyId}</td>
                  <td className="px-2 py-1">{a.justification}</td>
                  <td className="px-2 py-1">{a.territorialAdjustmentNotes ?? '-'}</td>
                  <td className="px-2 py-1">{a.assignmentStatus ?? 'active'}</td>
                  {canEdit && (
                    <td className="px-2 py-1">
                      <form action={handleArchiveAssignment} className="inline">
                        <input type="hidden" name="assignmentId" value={a.id} />
                        <button type="submit" className="text-red-600 underline">Archivar</button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

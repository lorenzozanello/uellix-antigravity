import React from 'react';
import Stepper from '@/components/sroi/Stepper';
import StellaPlaceholder from '@/components/sroi/StellaPlaceholder';
import { fetchOutcomes } from '@/app/app/projects/[projectId]/pipeline/outcomes.actions';
import { fetchIndicators } from '@/app/app/projects/[projectId]/pipeline/indicators.actions';
import { createFileEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action';
import { createUrlEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createUrlEvidence.action';
import { createTextEvidenceAction } from '@/app/app/projects/[projectId]/pipeline/evidence/createTextEvidence.action';
import { canUploadEvidence, hasRole } from '@/lib/auth/permissions';
import {
  listEvidenceForProject,
  archiveEvidenceForProject,
  updateEvidenceReviewStatus,
} from '@/lib/pipeline/evidence';
import { requireOrganizationAccess } from '@/lib/auth/session';
import { revalidatePath } from 'next/cache';

// Top-level Server Actions for the forms and buttons
export const fileAction = async (formData: FormData) => {
  'use server';
  const projectId = formData.get('projectId') as string;
  const fileEntry = formData.get('file');
  if (!fileEntry || !(fileEntry instanceof File) || fileEntry.size === 0) {
    throw new Error('Archivo no provisto o vacío.');
  }
  const buffer = Buffer.from(await fileEntry.arrayBuffer());
  const rawInput = {
    title: formData.get('title') as string,
    description: formData.get('description') as string || undefined,
    outcomeId: formData.get('outcomeId') as string || undefined,
    indicatorId: formData.get('indicatorId') as string || undefined,
    file: {
      name: fileEntry.name,
      mimeType: fileEntry.type,
      size: fileEntry.size,
      buffer,
    },
  };
  await createFileEvidenceAction(projectId, rawInput);
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`);
};

export const urlAction = async (formData: FormData) => {
  'use server';
  const projectId = formData.get('projectId') as string;
  const rawInput = {
    title: formData.get('title') as string,
    description: formData.get('description') as string || undefined,
    outcomeId: formData.get('outcomeId') as string || undefined,
    indicatorId: formData.get('indicatorId') as string || undefined,
    url: formData.get('url') as string,
  };
  await createUrlEvidenceAction(projectId, rawInput);
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`);
};

export const textAction = async (formData: FormData) => {
  'use server';
  const projectId = formData.get('projectId') as string;
  const rawInput = {
    title: formData.get('title') as string,
    description: formData.get('description') as string || undefined,
    outcomeId: formData.get('outcomeId') as string || undefined,
    indicatorId: formData.get('indicatorId') as string || undefined,
    text: formData.get('text') as string,
  };
  await createTextEvidenceAction(projectId, rawInput);
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`);
};

export const archiveAction = async (formData: FormData) => {
  'use server';
  const projectId = formData.get('projectId') as string;
  const evidenceId = formData.get('evidenceId') as string;
  await archiveEvidenceForProject(projectId, evidenceId);
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`);
};

export const updateStatusAction = async (formData: FormData) => {
  'use server';
  const projectId = formData.get('projectId') as string;
  const evidenceId = formData.get('evidenceId') as string;
  const status = formData.get('status') as string;
  if (!status) return;
  await updateEvidenceReviewStatus(projectId, evidenceId, { status });
  revalidatePath(`/app/projects/${projectId}/pipeline/evidence`);
};

export default async function EvidencePage({ params }: { params: { projectId: string } }) {
  const { membership } = await requireOrganizationAccess();
  const canCreate = canUploadEvidence(membership.role);
  const canArchive = hasRole(membership.role, 'analyst');
  const canReview = hasRole(membership.role, 'impact_manager');

  const evidences = await listEvidenceForProject(params.projectId);
  const outcomes = await fetchOutcomes(params.projectId);
  const indicators = await fetchIndicators(params.projectId);

  return (
    <div className="p-4 max-w-7xl mx-auto">
      <h2 className="text-xl font-semibold mb-2">Evidencias</h2>
      <Stepper />
      <StellaPlaceholder step="Evidencias" />

      {/* Evidences List */}
      <div className="mb-8">
        <h3 className="text-lg font-medium mb-3">Evidencias Registradas</h3>
        {evidences.length === 0 ? (
          <div className="p-6 bg-gray-50 border rounded-lg text-center text-gray-500">
            No hay evidencias registradas en este proyecto todavía.
          </div>
        ) : (
          <div className="overflow-x-auto border border-gray-200 rounded-lg shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 text-sm text-left">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Título</th>
                  <th className="px-4 py-3">Tipo</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Hash SHA‑256</th>
                  <th className="px-4 py-3">Sensibilidad</th>
                  <th className="px-4 py-3">Creado</th>
                  <th className="px-4 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200 text-gray-700">
                {evidences.map((ev) => (
                  <tr key={ev.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{ev.title}</td>
                    <td className="px-4 py-3 uppercase text-xs font-mono">{ev.type}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        ev.status === 'approved' ? 'bg-green-100 text-green-800' :
                        ev.status === 'rejected' ? 'bg-red-100 text-red-800' :
                        ev.status === 'under_review' ? 'bg-yellow-100 text-yellow-800' :
                        ev.status === 'archived' ? 'bg-gray-100 text-gray-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {ev.status === 'under_review' ? 'En revisión humana' : ev.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500" title={ev.contentHash || ''}>
                      {ev.contentHash ? `${ev.contentHash.slice(0, 8)}…` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">Privado</td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(ev.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 space-x-2">
                      {canReview && ev.status !== 'archived' && (
                        <form action={updateStatusAction} className="inline-flex items-center gap-1">
                          <input type="hidden" name="projectId" value={params.projectId} />
                          <input type="hidden" name="evidenceId" value={ev.id} />
                          <select
                            name="status"
                            className="text-xs border rounded p-1"
                            defaultValue=""
                          >
                            <option value="" disabled>Revisar...</option>
                            <option value="approved">Aprobar</option>
                            <option value="rejected">Rechazar</option>
                            <option value="under_review">En revisión</option>
                          </select>
                          <button
                            type="submit"
                            className="bg-gray-100 hover:bg-gray-200 text-xs px-2 py-1 rounded border border-gray-300 transition-colors"
                          >
                            OK
                          </button>
                        </form>
                      )}
                      {canArchive && ev.status !== 'archived' && (
                        <form action={archiveAction} className="inline-block">
                          <input type="hidden" name="projectId" value={params.projectId} />
                          <input type="hidden" name="evidenceId" value={ev.id} />
                          <button
                            type="submit"
                            className="text-xs text-red-600 hover:text-red-800 hover:underline transition-colors"
                          >
                            Archivar
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Creation forms */}
      {canCreate && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* File Form */}
          <div className="p-4 border rounded-lg shadow-sm bg-gray-50">
            <h4 className="font-semibold text-gray-900 mb-3">Subir Archivo</h4>
            <form action={fileAction} className="space-y-3">
              <input type="hidden" name="projectId" value={params.projectId} />

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Asociar Outcome</label>
                <select name="outcomeId" className="block w-full border rounded p-1 text-sm bg-white">
                  <option value="">Ninguno</option>
                  {outcomes?.map((o) => (
                    <option key={o.id} value={o.id}>{o.title}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Asociar Indicador</label>
                <select name="indicatorId" className="block w-full border rounded p-1 text-sm bg-white">
                  <option value="">Ninguno</option>
                  {indicators?.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Título</label>
                <input
                  name="title"
                  className="block w-full border rounded p-1 text-sm bg-white"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Descripción</label>
                <textarea
                  name="description"
                  rows={2}
                  className="block w-full border rounded p-1 text-sm bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Archivo</label>
                <input
                  type="file"
                  name="file"
                  className="block w-full text-xs"
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-1.5 px-3 rounded text-sm transition-colors"
              >
                Agregar Archivo
              </button>
            </form>
          </div>

          {/* URL Form */}
          <div className="p-4 border rounded-lg shadow-sm bg-gray-50">
            <h4 className="font-semibold text-gray-900 mb-3">Registrar Enlace URL</h4>
            <form action={urlAction} className="space-y-3">
              <input type="hidden" name="projectId" value={params.projectId} />

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Asociar Outcome</label>
                <select name="outcomeId" className="block w-full border rounded p-1 text-sm bg-white">
                  <option value="">Ninguno</option>
                  {outcomes?.map((o) => (
                    <option key={o.id} value={o.id}>{o.title}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Asociar Indicador</label>
                <select name="indicatorId" className="block w-full border rounded p-1 text-sm bg-white">
                  <option value="">Ninguno</option>
                  {indicators?.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Título</label>
                <input
                  name="title"
                  className="block w-full border rounded p-1 text-sm bg-white"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Descripción</label>
                <textarea
                  name="description"
                  rows={2}
                  className="block w-full border rounded p-1 text-sm bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">URL</label>
                <input
                  type="url"
                  name="url"
                  className="block w-full border rounded p-1 text-sm bg-white"
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-1.5 px-3 rounded text-sm transition-colors"
              >
                Agregar URL
              </button>
            </form>
          </div>

          {/* Text Form */}
          <div className="p-4 border rounded-lg shadow-sm bg-gray-50">
            <h4 className="font-semibold text-gray-900 mb-3">Registrar Declaración de Texto</h4>
            <form action={textAction} className="space-y-3">
              <input type="hidden" name="projectId" value={params.projectId} />

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Asociar Outcome</label>
                <select name="outcomeId" className="block w-full border rounded p-1 text-sm bg-white">
                  <option value="">Ninguno</option>
                  {outcomes?.map((o) => (
                    <option key={o.id} value={o.id}>{o.title}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Asociar Indicador</label>
                <select name="indicatorId" className="block w-full border rounded p-1 text-sm bg-white">
                  <option value="">Ninguno</option>
                  {indicators?.map((i) => (
                    <option key={i.id} value={i.id}>{i.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Título</label>
                <input
                  name="title"
                  className="block w-full border rounded p-1 text-sm bg-white"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Descripción</label>
                <textarea
                  name="description"
                  rows={2}
                  className="block w-full border rounded p-1 text-sm bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Texto</label>
                <textarea
                  name="text"
                  rows={3}
                  className="block w-full border rounded p-1 text-sm bg-white"
                  required
                />
              </div>

              <button
                type="submit"
                className="w-full bg-teal-600 hover:bg-teal-700 text-white font-medium py-1.5 px-3 rounded text-sm transition-colors"
              >
                Agregar Texto
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

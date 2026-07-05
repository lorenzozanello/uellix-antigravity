// app/app/projects/[projectId]/pipeline/narrative/page.tsx
import Stepper from '@/components/sroi/Stepper';
import { StellaAdvisorPanel } from '@/components/stella';
import { fetchNarrative, saveNarrative } from '@/app/app/projects/[projectId]/pipeline/narrative.actions';
import { z } from 'zod';
import { listOutcomesForProject } from '@/lib/pipeline/outcomes';
import {
  fetchToCNodes,
  fetchToCLinks,
  createToCNodeAction,
  archiveToCNodeAction,
  createToCLinkAction,
  archiveToCLinkAction,
} from '../theoryOfChange.actions';
import { revalidatePath } from 'next/cache';

// Zod schema for client-side validation (mirrors server)
const narrativeSchema = z.object({
  version: z.string().min(1),
  narrativeText: z.string().optional(),
  theoryOfChangeSummary: z.string().optional(),
  assumptions: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
});

export const action = async (formData: FormData) => {
  'use server';
  const parsed = narrativeSchema.parse({
    version: formData.get('version'),
    narrativeText: formData.get('narrativeText'),
    theoryOfChangeSummary: formData.get('theoryOfChangeSummary'),
    assumptions: formData.get('assumptions'),
    status: formData.get('status'),
  });
  const projectId = formData.get('projectId') as string;
  await saveNarrative(projectId, parsed);
};

const INPUT_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
const TEXTAREA_CLASS =
  'mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 resize-y'

export default async function NarrativePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const narrative = await fetchNarrative(projectId);
  const data = narrative ?? {};

  const [outcomes, nodes, links] = await Promise.all([
    listOutcomesForProject(projectId),
    fetchToCNodes(projectId),
    fetchToCLinks(projectId),
  ]);

  const activities = nodes.filter((n) => n.nodeType === 'activity');
  const outputs = nodes.filter((n) => n.nodeType === 'output');
  const outcomeNodes = nodes.filter((n) => n.nodeType === 'outcome');
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outcomeById = new Map(outcomes.map((o) => [o.id, o]));
  const modeledOutcomeIds = new Set(outcomeNodes.map((n) => n.outcomeId));
  const availableOutcomes = outcomes.filter((o) => !modeledOutcomeIds.has(o.id));
  const linksByFromNode = new Map<string, typeof links>();
  for (const l of links) {
    const list = linksByFromNode.get(l.fromNodeId) ?? [];
    list.push(l);
    linksByFromNode.set(l.fromNodeId, list);
  }

  async function handleCreateNode(formData: FormData) {
    'use server';
    await createToCNodeAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }

  async function handleArchiveNode(formData: FormData) {
    'use server';
    await archiveToCNodeAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }

  async function handleCreateLink(formData: FormData) {
    'use server';
    await createToCLinkAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }

  async function handleArchiveLink(formData: FormData) {
    'use server';
    await archiveToCLinkAction(formData);
    revalidatePath(`/app/projects/${projectId}/pipeline/narrative`);
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Narrativa</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Establece la narrativa de inicio del proyecto, teoría del cambio y supuestos metodológicos.
        </p>
      </div>
      <Stepper />
      <StellaAdvisorPanel projectId={projectId} step="Narrativa" highlightHint={!narrative} />
      <form action={action} className="space-y-6">
        <input type="hidden" name="projectId" value={projectId} />
        <div>
          <label htmlFor="version" className="block text-sm font-medium text-foreground">
            Versión
          </label>
          <input
            id="version"
            name="version"
            defaultValue={data.version ?? ''}
            className={INPUT_CLASS}
            required
          />
        </div>
        <div>
          <label htmlFor="narrativeText" className="block text-sm font-medium text-foreground">
            Texto narrativo
          </label>
          <textarea
            id="narrativeText"
            name="narrativeText"
            defaultValue={data.narrativeText ?? ''}
            className={TEXTAREA_CLASS}
            rows={4}
          />
        </div>
        <div>
          <label htmlFor="theoryOfChangeSummary" className="block text-sm font-medium text-foreground">
            Resumen de teoría del cambio
          </label>
          <textarea
            id="theoryOfChangeSummary"
            name="theoryOfChangeSummary"
            defaultValue={data.theoryOfChangeSummary ?? ''}
            className={TEXTAREA_CLASS}
            rows={3}
          />
        </div>
        <div>
          <label htmlFor="assumptions" className="block text-sm font-medium text-foreground">
            Suposiciones
          </label>
          <textarea
            id="assumptions"
            name="assumptions"
            defaultValue={data.assumptions ?? ''}
            className={TEXTAREA_CLASS}
            rows={2}
          />
        </div>
        <div>
          <label htmlFor="status" className="block text-sm font-medium text-foreground">
            Estado
          </label>
          <select
            id="status"
            name="status"
            defaultValue={data.status ?? 'draft'}
            className={INPUT_CLASS}
          >
            <option value="draft">Borrador</option>
            <option value="active">Activo</option>
            <option value="completed">Completado</option>
            <option value="archived">Archivado</option>
          </select>
        </div>
        <button
          type="submit"
          className="inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 transition-colors"
        >
          Guardar
        </button>
      </form>

      <div className="border-t border-border pt-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Teoría de cambio estructurada</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Modela actividades, productos y resultados como un grafo simple, con supuestos
            explícitos por enlace. Es opcional y complementa (no reemplaza) el resumen de arriba.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Activities */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Actividades</h3>
            <ul className="space-y-2">
              {activities.map((n) => (
                <li key={n.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{n.title}</span>
                    <form action={handleArchiveNode}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="nodeId" value={n.id} />
                      <button type="submit" className="text-xs text-red-600 hover:text-red-700">Quitar</button>
                    </form>
                  </div>
                  {(linksByFromNode.get(n.id) ?? []).map((l) => (
                    <p key={l.id} className="mt-1 text-xs text-muted-foreground">
                      → {nodeById.get(l.toNodeId)?.title ?? '—'}
                      {l.assumption && <span className="italic"> ({l.assumption})</span>}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            <form action={handleCreateNode} className="space-y-1">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="nodeType" value="activity" />
              <input name="title" type="text" required placeholder="Nueva actividad" className={INPUT_CLASS} />
              <button type="submit" className="text-xs font-medium text-primary">Agregar</button>
            </form>
          </div>

          {/* Outputs */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Productos</h3>
            <ul className="space-y-2">
              {outputs.map((n) => (
                <li key={n.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{n.title}</span>
                    <form action={handleArchiveNode}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="nodeId" value={n.id} />
                      <button type="submit" className="text-xs text-red-600 hover:text-red-700">Quitar</button>
                    </form>
                  </div>
                  {(linksByFromNode.get(n.id) ?? []).map((l) => (
                    <p key={l.id} className="mt-1 text-xs text-muted-foreground">
                      → {nodeById.get(l.toNodeId)?.title ?? '—'}
                      {l.assumption && <span className="italic"> ({l.assumption})</span>}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            <form action={handleCreateNode} className="space-y-1">
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="nodeType" value="output" />
              <input name="title" type="text" required placeholder="Nuevo producto" className={INPUT_CLASS} />
              <button type="submit" className="text-xs font-medium text-primary">Agregar</button>
            </form>
          </div>

          {/* Outcomes */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground">Resultados</h3>
            <ul className="space-y-2">
              {outcomeNodes.map((n) => (
                <li key={n.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground">{outcomeById.get(n.outcomeId ?? '')?.title ?? n.title}</span>
                    <form action={handleArchiveNode}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="nodeId" value={n.id} />
                      <button type="submit" className="text-xs text-red-600 hover:text-red-700">Quitar</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
            {availableOutcomes.length > 0 && (
              <form action={handleCreateNode} className="space-y-1">
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="nodeType" value="outcome" />
                <select name="outcomeId" required className={INPUT_CLASS}>
                  <option value="">— Seleccionar resultado —</option>
                  {availableOutcomes.map((o) => (
                    <option key={o.id} value={o.id}>{o.title}</option>
                  ))}
                </select>
                <input type="hidden" name="title" value="_" />
                <button type="submit" className="text-xs font-medium text-primary">Agregar al grafo</button>
              </form>
            )}
          </div>
        </div>

        {/* Link creation */}
        {(activities.length > 0 || outputs.length > 0) && (
          <div className="rounded-md border border-border p-4 space-y-2">
            <h3 className="text-sm font-semibold text-foreground">Nuevo enlace causal</h3>
            <form action={handleCreateLink} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="projectId" value={projectId} />
              <div>
                <label className="block text-xs text-muted-foreground">Desde</label>
                <select name="fromNodeId" required className={INPUT_CLASS}>
                  {[...activities, ...outputs].map((n) => (
                    <option key={n.id} value={n.id}>{n.title} ({n.nodeType})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-muted-foreground">Hacia</label>
                <select name="toNodeId" required className={INPUT_CLASS}>
                  {[...outputs, ...outcomeNodes].map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.nodeType === 'outcome' ? outcomeById.get(n.outcomeId ?? '')?.title ?? n.title : n.title} ({n.nodeType})
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[200px]">
                <label className="block text-xs text-muted-foreground">Supuesto (opcional)</label>
                <input name="assumption" type="text" className={INPUT_CLASS} />
              </div>
              <button type="submit" className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90">
                Enlazar
              </button>
            </form>
            <p className="text-xs text-muted-foreground">
              Solo se permiten enlaces actividad→producto o producto→resultado.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

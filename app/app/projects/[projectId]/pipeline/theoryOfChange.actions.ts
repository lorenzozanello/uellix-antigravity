// app/app/projects/[projectId]/pipeline/theoryOfChange.actions.ts
// Fase 2a — server actions for the structured theory-of-change graph.

'use server';

import {
  listNodesForProject,
  createNode,
  archiveNode,
  listLinksForProject,
  createLink,
  archiveLink,
} from '@/lib/pipeline/theory-of-change';

export async function fetchToCNodes(projectId: string) {
  return listNodesForProject(projectId);
}

export async function fetchToCLinks(projectId: string) {
  return listLinksForProject(projectId);
}

export async function createToCNodeAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const nodeType = formData.get('nodeType') as 'activity' | 'output' | 'outcome';
  const outcomeId = (formData.get('outcomeId') as string | null) || undefined;
  const title = formData.get('title') as string;
  const description = (formData.get('description') as string | null) || undefined;
  return createNode(projectId, { nodeType, outcomeId, title, description });
}

export async function archiveToCNodeAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const nodeId = formData.get('nodeId') as string;
  return archiveNode(projectId, nodeId);
}

export async function createToCLinkAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const fromNodeId = formData.get('fromNodeId') as string;
  const toNodeId = formData.get('toNodeId') as string;
  const assumption = (formData.get('assumption') as string | null) || undefined;
  return createLink(projectId, { fromNodeId, toNodeId, assumption });
}

export async function archiveToCLinkAction(formData: FormData) {
  const projectId = formData.get('projectId') as string;
  const linkId = formData.get('linkId') as string;
  return archiveLink(projectId, linkId);
}

'use server'
// app/actions/taxonomy.ts
// Server actions for Fase 3 outcome ↔ standard taxonomy crosswalks.

import { revalidatePath } from 'next/cache'
import {
  createOutcomeMapping,
  deleteOutcomeMapping,
  type OutcomeMappingInput,
} from '@/lib/taxonomies/service'
import { runWithOrganizationAccess } from '@/lib/auth/session'

export async function createOutcomeMappingAction(projectId: string, input: OutcomeMappingInput) {
  const result = await runWithOrganizationAccess(() =>
    createOutcomeMapping(projectId, input)
  )
  revalidatePath(`/app/projects/${projectId}/pipeline/outcomes`)
  return result
}

export async function deleteOutcomeMappingAction(projectId: string, mappingId: string) {
  const result = await runWithOrganizationAccess(() =>
    deleteOutcomeMapping(projectId, mappingId)
  )
  revalidatePath(`/app/projects/${projectId}/pipeline/outcomes`)
  return result
}

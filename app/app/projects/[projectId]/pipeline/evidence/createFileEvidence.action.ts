// app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action.ts

'use server'

import { createFileEvidenceForProject } from '@/lib/pipeline/evidence'
import { z } from 'zod'

const InputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  file: z.object({
    name: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().positive(),
    buffer: z.instanceof(Buffer),
  }),
})

export async function createFileEvidenceAction(projectId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput)
  return await createFileEvidenceForProject(projectId, input)
}

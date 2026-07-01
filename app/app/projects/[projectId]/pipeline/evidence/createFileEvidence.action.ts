// app/app/projects/[projectId]/pipeline/evidence/createFileEvidence.action.ts

'use server'

import {
  createFileEvidenceForProject,
  ALLOWED_EVIDENCE_MIME_TYPES,
  MAX_EVIDENCE_FILE_SIZE_BYTES,
} from '@/lib/pipeline/evidence'
import { z } from 'zod'

const InputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  outcomeId: z.string().uuid().optional(),
  indicatorId: z.string().uuid().optional(),
  file: z.object({
    name: z.string().min(1),
    mimeType: z.enum(ALLOWED_EVIDENCE_MIME_TYPES),
    size: z.number().int().positive().max(MAX_EVIDENCE_FILE_SIZE_BYTES),
    buffer: z.instanceof(Buffer),
  }),
})

export async function createFileEvidenceAction(projectId: string, rawInput: unknown) {
  const input = InputSchema.parse(rawInput)
  return await createFileEvidenceForProject(projectId, input)
}

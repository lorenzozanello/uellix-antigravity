'use server'
// app/actions/methodology-review.ts
// Server actions for the Fase 2 generalized methodology review matrix.
// Thin wrappers over lib/pipeline/methodology-review (authorized + audited there).

import {
  getMethodologyReview,
  startMethodologyReview,
  upsertMethodologyReviewItem,
  updateMethodologyReview,
  type PipelineReviewStep,
  type MethodologyReviewItemInput,
  type MethodologyReviewHeaderInput,
} from '@/lib/pipeline/methodology-review'

export async function getMethodologyReviewAction(projectId: string, step: PipelineReviewStep) {
  return getMethodologyReview(projectId, step)
}

export async function startMethodologyReviewAction(projectId: string, step: PipelineReviewStep) {
  return startMethodologyReview(projectId, step)
}

export async function upsertMethodologyReviewItemAction(
  projectId: string,
  step: PipelineReviewStep,
  input: MethodologyReviewItemInput
) {
  return upsertMethodologyReviewItem(projectId, step, input)
}

export async function updateMethodologyReviewAction(
  projectId: string,
  step: PipelineReviewStep,
  input: MethodologyReviewHeaderInput
) {
  return updateMethodologyReview(projectId, step, input)
}

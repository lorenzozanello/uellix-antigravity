'use server';

import {
  pauseProject,
  resumeProject,
  archiveProject,
  requestProjectDeletion,
  approveProjectDeletion,
  validateProjectDeletionEligibility,
} from '@/lib/projects/service';

export async function pauseProjectAction(projectId: string) {
  return pauseProject(projectId);
}

export async function resumeProjectAction(projectId: string) {
  return resumeProject(projectId);
}

export async function archiveProjectAction(projectId: string) {
  return archiveProject(projectId);
}

export async function requestProjectDeletionAction(
  projectId: string,
  reason: string,
) {
  return requestProjectDeletion(projectId, reason);
}

export async function approveProjectDeletionAction(
  projectId: string,
  confirmation: string,
  deleteReason: string,
) {
  return approveProjectDeletion(projectId, confirmation, deleteReason);
}

export async function validateDeletionEligibilityAction(projectId: string) {
  return validateProjectDeletionEligibility(projectId);
}

'use server';

import {
  pauseProject,
  resumeProject,
  archiveProject,
  requestProjectDeletion,
  approveProjectDeletion,
  validateProjectDeletionEligibility,
} from '@/lib/projects/service';
import { runWithOrganizationAccess } from '@/lib/auth/session';
import { withOrganizationDatabaseContext } from '@/lib/auth/database-context';

export async function pauseProjectAction(projectId: string) {
  return runWithOrganizationAccess(() => pauseProject(projectId));
}

export async function resumeProjectAction(projectId: string) {
  return runWithOrganizationAccess(() => resumeProject(projectId));
}

export async function archiveProjectAction(projectId: string) {
  return runWithOrganizationAccess(() => archiveProject(projectId));
}

export async function requestProjectDeletionAction(
  projectId: string,
  reason: string,
) {
  return runWithOrganizationAccess(() => requestProjectDeletion(projectId, reason));
}

export async function approveProjectDeletionAction(
  projectId: string,
  confirmation: string,
  deleteReason: string,
) {
  // `withOrganizationDatabaseContext`, NOT `runWithOrganizationAccess`: this is
  // called from a CLIENT component on /admin/project-deletions, which catches
  // and displays the error. `runWith…` redirects, and `redirect()` throws — a
  // super admin with no membership would see "NEXT_REDIRECT" in the dialog
  // instead of a reason. A thrown AuthContextError is a value that component
  // can render.
  //
  // Pre-existing and unchanged: `approveProjectDeletion` requires a
  // `super_admin` MEMBERSHIP in the project's own organisation and filters by
  // `ctx.organization.id`, so the cross-tenant list on that page can only be
  // acted on for the admin's own organisation. That is a scoping decision in
  // lib/projects/service.ts, not something the identity context introduced.
  return withOrganizationDatabaseContext(() =>
    approveProjectDeletion(projectId, confirmation, deleteReason)
  );
}

export async function validateDeletionEligibilityAction(projectId: string) {
  return runWithOrganizationAccess(() => validateProjectDeletionEligibility(projectId));
}

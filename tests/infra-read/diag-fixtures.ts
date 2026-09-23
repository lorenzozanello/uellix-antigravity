// tests/infra-read/diag-fixtures.ts — synthetic, NON-SECRET values for the safe-diagnostic tests.
// Values are assembled at runtime; none is a committed literal a scanner could mistake for a credential.
import { TEAM } from './fixtures'
import type { RunResult } from '../../scripts/infra-read/executor'

/** Every allowlisted V-R2.S2 location (PROJECT_IDENTITY_FIELDS under projects[], plus PAGINATION). */
export const VR2S2_FIELDS = [
  'id', 'name', 'accountId', 'createdAt', 'updatedAt',
  'link.type', 'link.repo', 'link.org', 'link.repoId', 'link.productionBranch',
  'pagination.next', 'pagination.count',
] as const

/**
 * A 48-character run that OPAQUE_HIGH_ENTROPY must flag (>= 4 upper, lower and digit),
 * distinct per field and wrapped in a quote so its JSON-escaped form differs from its raw form.
 */
export function syntheticSecret(field: string): string {
  const salt = [...field].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7)
  const alphabet = 'Qw7ErT9yUi3OpA5sDf1GhJ8kLz2XcV6bNm4'
  let run = ''
  for (let i = 0; i < 48; i++) run += alphabet[(salt + i * 13) % alphabet.length]
  return ['cfg"', run, '"end'].join('')
}

/** The V-R2.S2 response for TEAM, with `value` planted at `field` (projects[] field or pagination.*). */
export function projectsListWith(field: string, value: string): Record<string, RunResult> {
  const project: Record<string, unknown> = {
    id: 'prj_PRODWEB00002', name: 'uellix-production-web', accountId: TEAM, createdAt: 1, updatedAt: 2,
    link: { type: 'github', repo: 'uellix-production-web', org: 'lorenzozanello', repoId: 3, productionBranch: 'main' },
  }
  const pagination: Record<string, unknown> = { count: 1, next: null }
  if (field.startsWith('pagination.')) pagination[field.slice('pagination.'.length)] = value
  else if (field.startsWith('link.')) (project.link as Record<string, unknown>)[field.slice('link.'.length)] = value
  else project[field] = value
  return { [`/v9/projects?teamId=${TEAM}&limit=100`]: { status: 0, stdout: JSON.stringify({ projects: [project], pagination }), stderr: '' } }
}

export function expectedPathFor(field: string): string {
  return field.startsWith('pagination.') ? field : `projects[*].${field}`
}

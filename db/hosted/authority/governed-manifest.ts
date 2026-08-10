// db/hosted/authority/governed-manifest.ts
// COMMIT 4 — the pins for the governed artefacts.
//
// Same shape and same reasoning as db/hosted/hosted-package-manifest.ts, one
// derivation step later. It pins three things, and each closes a direction the
// others cannot see:
//
//   sourceDigest     the hosted artefact this was derived FROM. If somebody
//                    regenerates the middle layer and forgets this one, the
//                    generation refuses instead of shipping a stale artefact.
//   planDigest       the authority plan that decided who executes what. The
//                    input can be byte-identical while the plan changed — a
//                    window re-anchored, a segment re-split — and only this
//                    notices.
//   generatedDigest  the output itself, so `authority:verify` can regenerate
//                    and byte-compare rather than trust the file on disk.
//
// This is not a competing source of truth. The canonical packages under
// db/prepared/** remain the only one; these are pins over two derivations of it.

import { createHash } from 'node:crypto'

import { sha256OfSql } from '../hosted-package-manifest'
import type { AuthorityPlan } from './classification-manifest'

export interface GovernedPin {
  readonly packageId: string
  readonly sourceFile: string
  /** SHA-256 of the concatenated hosted-artefact statements this derives from. */
  readonly sourceDigest: string
  /** SHA-256 of the generated governed artefact. */
  readonly generatedDigest: string
}

/**
 * A digest over the DECISIONS the plan makes, not over its prose.
 *
 * Window boundaries, segment executors, destinations and temporary-privilege
 * requirements. A comment added to `recovered-boundaries.ts` must not move it;
 * a re-anchored window must.
 */
export function authorityPlanDigest(plan: AuthorityPlan): string {
  const material = [
    ...plan.windows.map((w) =>
      [
        w.windowId,
        w.packageId,
        w.authorityClass,
        w.startStatementIdentity,
        w.endStatementIdentity,
        String(w.structuralStatementCount),
        w.statementDigestSequence.join(','),
      ].join('|'),
    ),
    ...plan.segments.map((s) =>
      [
        s.segmentId,
        s.packageId,
        s.authorityClass,
        s.executor,
        s.ownerDestination ?? '-',
        String(s.statementCount),
        s.requiredTemporarySchemaCreate ?? '-',
      ].join('|'),
    ),
  ].join('\n')
  return createHash('sha256').update(material, 'utf8').digest('hex')
}

/**
 * The pinned digests, regenerated with `pnpm authority:generate`.
 *
 * A drift in any of the three is a refusal, never a silent regeneration: an
 * operator who edits a canonical package and forgets this layer is told so,
 * rather than shipping an artefact whose authority plan describes a file that no
 * longer exists.
 */
export const GOVERNED_PLAN_DIGEST = '19a0ff5a962806f72a3285ea0542653ae9451fa1cd7a05ed7cc74470514634bf'

export const GOVERNED_PINS: readonly GovernedPin[] = [
  {
    packageId: 'T1',
    sourceFile: 'grounding_0002_document_versions.sql',
    sourceDigest: '2a099839b6749916f9054d3ca336ee4f5042bc0ec2d1b7db97f6f9bc7b6acfe0',
    generatedDigest: 'e9d6752f57ed121572ed224b1aebd7d0e924c7ca80c6380aac8b2b05b719c5e8',
  },
  {
    packageId: 'T2',
    sourceFile: 'grounding_0003_evidence_chunks.sql',
    sourceDigest: '1c80a87774a67c8c5e1da230be1207e6ac7332da0512e0cf7e4c7aa378461c84',
    generatedDigest: '0a8833d33456d8e7a3dcc0dc932b39d788d5160bb5df3daeb1e2e667248d63be',
  },
  {
    packageId: 'T3',
    sourceFile: 'grounding_0004_runtime_attestation.sql',
    sourceDigest: '8b11be4819c886ffbe56cd54dad5174012d28eb691003ab2b9775eba72e96381',
    generatedDigest: '6b77ca64b7a255b14f73889055597d8e2b00f7af2b4e05712c730da3fce5f7e8',
  },
  {
    packageId: 'T4',
    sourceFile: 'stella_0013_grounded_query_quota.sql',
    sourceDigest: '770cba965bd336ebd3ebbceaaa590cdc3cc155cabb67c13c186718b491c9767c',
    generatedDigest: '3cb8497c8c969f479578b3c69f428be4a289934332eca2832f6b76c841156380',
  },
  {
    packageId: 'T5',
    sourceFile: 'stella_0014_operation_tickets.sql',
    sourceDigest: 'f69d724485229921325d91e7b021700f1d9bfc5aad4e91c07f15f3e876782b82',
    generatedDigest: '268fa3df2697000b89d4c891c53579022fb141b9022f0ee5930dc51dd1516ab8',
  },
  {
    packageId: 'T6',
    sourceFile: 'stella_0015_project_bound_operation_tickets.sql',
    sourceDigest: 'd1ca156d78eead4b391df6d4b6fae6c614bb871dc0b6893c11fd1a9feb0bfbef',
    generatedDigest: '2d05a4ef4c33897fa44b97afbb41f7d4efa70b8234c76d1e5177b2d859a31a20',
  },
  {
    packageId: 'T7',
    sourceFile: 'stella_0016_reserved_quota_semantics.sql',
    sourceDigest: 'c69c13ff69d5f0edd4dd7cd95c8e07cc5c44ac92fb02d3f7c99dc6395dac7ca7',
    generatedDigest: '72526faf61cc848e46e4a77cdc74d85939009fefb733bb5c19e3086db8c0cbb3',
  },
  {
    packageId: 'T8',
    sourceFile: 'stella_0017_governed_stella_consumption.sql',
    sourceDigest: '968f05d175f855034c499bd7d380f514298eb1eed0c708b45dd9c726ec2e17c3',
    generatedDigest: '6decb9aee9b6552840a0eb3d47c24f5a99e6f830cabd0f116b2becf6b447ae4c',
  },
  {
    packageId: 'T9',
    sourceFile: 'stella_0018_category_bound_operation_tickets.sql',
    sourceDigest: '51256fce7db242fb5aa4e9844d637289fcd249088161223bec25fffc4c3e7162',
    generatedDigest: 'b3be34cdb6a027786bd5c870e442850d5a8160bafc185e0be449a23d12879fd6',
  },
]

export { sha256OfSql }

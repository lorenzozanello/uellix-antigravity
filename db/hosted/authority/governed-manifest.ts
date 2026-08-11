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
export const GOVERNED_PLAN_DIGEST = 'a889a72681e86b98683ad835ab70786edfb4f05f7e98fb219730c9bbb27e2748'

export const GOVERNED_PINS: readonly GovernedPin[] = [
  {
    packageId: 'T1',
    sourceFile: 'grounding_0002_document_versions.sql',
    sourceDigest: '4e3f9abeef08b64cf9cf5c54b5d5c71dfc9c99f939fe660e89b64e12d41e820e',
    generatedDigest: '7b6be068139be6ac731f85074046238915bf843f2995f66e1dba752261ecfa9d',
  },
  {
    packageId: 'T2',
    sourceFile: 'grounding_0003_evidence_chunks.sql',
    sourceDigest: '7505586f6c3759cae85455e641ded5934413bafc8574db273ec90b5edadde6c9',
    generatedDigest: 'd2bd3b9d08a4d5243fdf64da6db3e2f018e1cd92fc68d564d7966eca262eddc8',
  },
  {
    packageId: 'T3',
    sourceFile: 'grounding_0004_runtime_attestation.sql',
    sourceDigest: '2442fef97a844cb695eb2f699729611b1d1d3b3365f5ced431ff72159f52d9a8',
    generatedDigest: 'b662a1b3b92482ae449cad1bf072033fae2f82f2a73beb2253123d2f79efed14',
  },
  {
    packageId: 'T4',
    sourceFile: 'stella_0013_grounded_query_quota.sql',
    sourceDigest: '1b275f5fd57f58b71e0b804fb730e0b1a1ed7b5d694084b3d9c1ddda69329d3c',
    generatedDigest: 'd6b04e271ffa0c81c5b650344925561f3374434175ebf187410ff67939877c92',
  },
  {
    packageId: 'T5',
    sourceFile: 'stella_0014_operation_tickets.sql',
    sourceDigest: 'd58e69b7d10b85f9beae3cd396af55f0981a82b414a08d0a3663d1b353dc156e',
    generatedDigest: 'f8a26f29f92b1a74be18159e9ed7a6732ed06aff75f9711b169f88b424233cce',
  },
  {
    packageId: 'T6',
    sourceFile: 'stella_0015_project_bound_operation_tickets.sql',
    sourceDigest: '376d4f6768e7edca479a13d86cec028370846aeacf2f0b3866de060726fe5668',
    generatedDigest: '7fccb63373efc531b31413b954e32afd370a9c4ac38f3c9eea601d533f4be800',
  },
  {
    packageId: 'T7',
    sourceFile: 'stella_0016_reserved_quota_semantics.sql',
    sourceDigest: '8824d8464a5e5baf972fa77b622a32758bdca393fd4fa0f560a2416efa4f3d0d',
    generatedDigest: 'beadf495b1358f5ed214ade13a87b77a5e5372fe216c0c9895545804f5e0657a',
  },
  {
    packageId: 'T8',
    sourceFile: 'stella_0017_governed_stella_consumption.sql',
    sourceDigest: 'fc2bea7f41fdab41a97f85970cb67d7b0c9a06f41e5b9e8d68a929a68f4eca00',
    generatedDigest: '053f13ad6d1db7f5f051ab8df043c1d93f34caad11e47c163895eebfcc123c55',
  },
  {
    packageId: 'T9',
    sourceFile: 'stella_0018_category_bound_operation_tickets.sql',
    sourceDigest: '26157a0c248226b009d04524f91b646869235fd5718bad4a773040d67e6eb867',
    generatedDigest: '0b5c481f9cc261f3d184c33a621881f76fed7b29b8ed0c8bf0c8d76a679316ac',
  },
  {
    // M-8. The tenth pin, and the first for a package whose classification
    // windows are AUTHORED rather than recovered. Nothing about the pinning
    // changes for that reason — the digests are over bytes either way — and
    // that is deliberate: an authored window buys no weaker check anywhere.
    packageId: 'T10',
    sourceFile: 'grounding_0005_claim_advisory_lock.sql',
    sourceDigest: 'd112386727dd36c7873362d0a5ddb2f44efa1e9e283b22bc3fe0b84f0fd09a03',
    generatedDigest: 'c784b121a3509f30cf2aacb2be619d9d14bc0072440edda1cb155edf91a9ed34',
  },
]

export { sha256OfSql }

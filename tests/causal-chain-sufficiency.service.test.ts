// tests/causal-chain-sufficiency.service.test.ts
// FIBIU-16 (FIBC-020). W2-B4 (HPO-ODS-W2-12,
// docs/ops/wave2/W2_B4_TEST_MANIFEST_v1.json). NO_DB_OBJECT: pure-logic
// controls over checkCausalChainSufficiency, operating on already-fetched
// node/link arrays — no database required.

import { describe, it, expect } from 'vitest'
import { checkCausalChainSufficiency, isValidLinkTransition } from '@/lib/pipeline/theory-of-change'

type Node = { id: string; nodeType: 'activity' | 'output' | 'outcome'; outcomeId: string | null; status: 'active' | 'archived' }
type Link = { fromNodeId: string; toNodeId: string; status: 'active' | 'archived' }

const OUTCOME_ID = 'outcome-1'

function node(id: string, nodeType: Node['nodeType'], opts: Partial<Node> = {}): Node {
  return { id, nodeType, outcomeId: nodeType === 'outcome' ? OUTCOME_ID : null, status: 'active', ...opts }
}
function link(fromNodeId: string, toNodeId: string, opts: Partial<Link> = {}): Link {
  return { fromNodeId, toNodeId, status: 'active', ...opts }
}

describe('checkCausalChainSufficiency (FIBIU-16, FIBC-020)', () => {
  // POS-16-1 — a complete, explicit, traceable activity -> output -> outcome
  // chain satisfies the gate.
  it('POS-16-1: activity -> output -> outcome, all active, is SUFFICIENT', () => {
    const nodes = [node('a', 'activity'), node('o', 'output'), node('out', 'outcome')]
    const links = [link('a', 'o'), link('o', 'out')]
    const result = checkCausalChainSufficiency(nodes, links, OUTCOME_ID)
    expect(result).toEqual({ sufficient: true, reason: 'sufficient' })
  })

  // POS-16-2 — no separate DB marker exists for "external model, sufficiently
  // mapped" (B4_FIBDB_SCOPE.FIBIU_16_DB): a mapped external model IS a set of
  // native nodes/links indistinguishable from a natively-authored one, so it
  // satisfies the gate through the exact same path as POS-16-1 — this test
  // documents that identity rather than asserting a second code path.
  it('POS-16-2: a "mapped external model" is represented as ordinary native nodes/links and satisfies the gate identically to POS-16-1', () => {
    const nodes = [node('ext-a', 'activity'), node('ext-o', 'output'), node('ext-out', 'outcome')]
    const links = [link('ext-a', 'ext-o'), link('ext-o', 'ext-out')]
    expect(checkCausalChainSufficiency(nodes, links, OUTCOME_ID)).toEqual({ sufficient: true, reason: 'sufficient' })
  })

  // NEG-16-2 (the measured gap this unit closes) — zero nodes at all.
  it('NEG-16-2: zero nodes for the outcome is INSUFFICIENT (no_outcome_node) — the measured gap this unit closes', () => {
    const result = checkCausalChainSufficiency([], [], OUTCOME_ID)
    expect(result).toEqual({ sufficient: false, reason: 'no_outcome_node' })
  })

  it('NEG-16-2: an outcome node with no incoming output link is INSUFFICIENT (no_output_link)', () => {
    const nodes = [node('out', 'outcome')]
    const result = checkCausalChainSufficiency(nodes, [], OUTCOME_ID)
    expect(result).toEqual({ sufficient: false, reason: 'no_output_link' })
  })

  it('NEG-16-2: an output linked to the outcome but with no incoming activity link is INSUFFICIENT (no_activity_link) — the missing intermediate level', () => {
    const nodes = [node('o', 'output'), node('out', 'outcome')]
    const links = [link('o', 'out')]
    const result = checkCausalChainSufficiency(nodes, links, OUTCOME_ID)
    expect(result).toEqual({ sufficient: false, reason: 'no_activity_link' })
  })

  it('NEG-16-2: an archived link does not count as present', () => {
    const nodes = [node('a', 'activity'), node('o', 'output'), node('out', 'outcome')]
    const links = [link('a', 'o'), link('o', 'out', { status: 'archived' })]
    const result = checkCausalChainSufficiency(nodes, links, OUTCOME_ID)
    expect(result.sufficient).toBe(false)
  })

  it('NEG-16-2: an archived node does not count as present even if its link is active', () => {
    const nodes = [node('a', 'activity', { status: 'archived' }), node('o', 'output'), node('out', 'outcome')]
    const links = [link('a', 'o'), link('o', 'out')]
    const result = checkCausalChainSufficiency(nodes, links, OUTCOME_ID)
    expect(result).toEqual({ sufficient: false, reason: 'no_activity_link' })
  })

  // NEG-16-3 — an uploaded document with no mapping leaves the graph exactly
  // as empty as if nothing had been uploaded; this function has no concept
  // of "attachment", so the only way to observe this is the absence itself.
  it('NEG-16-3: presence of unrelated evidence/attachments is irrelevant — this function only ever sees the graph, never a document', () => {
    // No nodes/links constructed "from" a document — the graph is empty,
    // which is exactly NEG-16-2's no_outcome_node case. There is no
    // affordance in checkCausalChainSufficiency's signature to pass a
    // document at all, which is the point: an upload cannot satisfy this
    // gate by any path.
    const result = checkCausalChainSufficiency([], [], OUTCOME_ID)
    expect(result.sufficient).toBe(false)
  })

  it('multiple outcome nodes / unrelated outcomes do not cross-contaminate', () => {
    const nodes = [
      node('a1', 'activity'), node('o1', 'output'), node('out1', 'outcome', { outcomeId: 'outcome-1' }),
      node('out2', 'outcome', { outcomeId: 'outcome-2' }), // outcome-2 has no chain at all
    ]
    const links = [link('a1', 'o1'), link('o1', 'out1')]
    expect(checkCausalChainSufficiency(nodes, links, 'outcome-1')).toEqual({ sufficient: true, reason: 'sufficient' })
    expect(checkCausalChainSufficiency(nodes, links, 'outcome-2')).toEqual({ sufficient: false, reason: 'no_output_link' })
  })

  // NEG-16-1 (non-regression) — preserved_prohibition: activity -> outcome
  // shortcuts remain forbidden. Already enforced at write time by
  // isValidLinkTransition; this checker does not need to (and must not)
  // separately special-case a "shortcut" link, because one can never exist
  // in the node/link sets it is fed — a badly-typed link is refused at
  // createLink and never persisted. Proven here by exercising the SAME
  // guard this unit is required to preserve, not reimplement.
  it('NEG-16-1 (non-regression): isValidLinkTransition still forbids activity->outcome and every other non-canonical transition', () => {
    expect(isValidLinkTransition('activity', 'output')).toBe(true)
    expect(isValidLinkTransition('output', 'outcome')).toBe(true)
    expect(isValidLinkTransition('activity', 'outcome')).toBe(false)
    expect(isValidLinkTransition('outcome', 'activity')).toBe(false)
    expect(isValidLinkTransition('output', 'activity')).toBe(false)
    expect(isValidLinkTransition('activity', 'activity')).toBe(false)
  })

  // NEG-16-4 — a material causal shortcut is documented via FIBIU-15
  // (assumption_object_links), never as a bypass of THIS gate. Proven
  // negatively: this function's signature has no assumption-related
  // parameter at all, so no caller can pass "there is a documented
  // shortcut assumption" as an input that would flip the result.
  it('NEG-16-4: the function has no assumption-aware parameter — recording a shortcut assumption elsewhere cannot silently satisfy this gate', () => {
    expect(checkCausalChainSufficiency.length).toBe(3) // (nodes, links, outcomeId) — no fourth "assumptions" argument
  })
})

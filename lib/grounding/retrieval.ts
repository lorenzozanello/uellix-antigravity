// lib/grounding/retrieval.ts
// WS5 (document grounding): in-memory, org-isolated retrieval index.
//
// The index is physically partitioned by organization id: search() only ever
// walks the requesting org's partition, so cross-org leakage is structurally
// impossible rather than filtered after the fact. The persisted (pgvector)
// implementation shares this contract, where the same invariant is enforced by
// the org-scoped RLS policies prepared in
// db/prepared/grounding_0001_evidence_chunks.sql plus an explicit
// organization_id filter on every service-client query (defense in depth).
//
// Every retrieved chunk carries `untrusted: true` at the type level: extracted
// document content is data, never instructions (spec §12.1 — it must enter
// prompts only inside an UNTRUSTED envelope).

import type { DocumentChunk, ChunkAnchor } from './chunk'
import { cosineSimilarity, type EmbeddingProvider } from './embedding-provider'

export interface RetrievedChunk {
  evidenceId: string
  chunkIndex: number
  text: string
  anchor: ChunkAnchor
  score: number
  /** Extracted document content is always untrusted data, never instructions. */
  untrusted: true
}

interface IndexedChunk {
  chunk: DocumentChunk
  vector: number[]
}

export class InMemoryGroundingIndex {
  // orgId -> evidenceId -> indexed chunks. Partitioned so a search can only
  // ever see its own org's slice of the map.
  private readonly orgs = new Map<string, Map<string, IndexedChunk[]>>()

  constructor(private readonly provider: EmbeddingProvider) {}

  /** Index a document's chunks under (orgId, evidenceId). Returns chunk count. */
  async addChunks(orgId: string, evidenceId: string, chunks: DocumentChunk[]): Promise<number> {
    if (!orgId) throw new Error('orgId is required')
    if (!evidenceId) throw new Error('evidenceId is required')
    const vectors = await this.provider.embed(chunks.map((chunk) => chunk.text))
    let org = this.orgs.get(orgId)
    if (!org) {
      org = new Map()
      this.orgs.set(orgId, org)
    }
    const existing = org.get(evidenceId) ?? []
    org.set(evidenceId, [
      ...existing,
      ...chunks.map((chunk, i) => ({ chunk, vector: vectors[i] })),
    ])
    return chunks.length
  }

  /**
   * Search within a single organization's partition. Results are cosine-ranked
   * (descending), deterministically tie-broken by (evidenceId, chunkIndex),
   * zero/negative scores dropped, capped at k.
   */
  async search(orgId: string, query: string, k: number): Promise<RetrievedChunk[]> {
    if (k <= 0) return []
    const org = this.orgs.get(orgId)
    if (!org) return []

    const [queryVector] = await this.provider.embed([query])
    const scored: RetrievedChunk[] = []
    for (const [evidenceId, indexed] of org) {
      for (const { chunk, vector } of indexed) {
        const score = cosineSimilarity(queryVector, vector)
        if (score <= 0) continue
        scored.push({
          evidenceId,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          anchor: chunk.anchor,
          score,
          untrusted: true,
        })
      }
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        a.evidenceId.localeCompare(b.evidenceId) ||
        a.chunkIndex - b.chunkIndex,
    )
    return scored.slice(0, k)
  }

  /** Drop every chunk of (orgId, evidenceId). Returns whether anything existed. */
  removeEvidence(orgId: string, evidenceId: string): boolean {
    const org = this.orgs.get(orgId)
    if (!org) return false
    const removed = org.delete(evidenceId)
    if (org.size === 0) this.orgs.delete(orgId)
    return removed
  }

  /** Replace an evidence's chunks with a freshly extracted set (remove + add). */
  async reindexEvidence(
    orgId: string,
    evidenceId: string,
    chunks: DocumentChunk[],
  ): Promise<number> {
    this.removeEvidence(orgId, evidenceId)
    return this.addChunks(orgId, evidenceId, chunks)
  }

  /** Number of chunks indexed for one organization. */
  countChunks(orgId: string): number {
    const org = this.orgs.get(orgId)
    if (!org) return 0
    let total = 0
    for (const indexed of org.values()) total += indexed.length
    return total
  }
}

// lib/grounding/embedding-provider.ts
// WS5 (document grounding): embeddings behind an injectable interface.
//
// Mirrors the injectable-provider pattern of lib/stella/adapter (the
// StellaGeminiAdapter accepts a StellaMockProvider so tests never touch the
// network): retrieval depends only on EmbeddingProvider, and the concrete
// provider is constructor-injected. The offline implementation below is not a
// mock — it is a real deterministic lexical fallback (G5 option 2) usable in
// production with zero infrastructure. A semantic provider (e.g. Gemini
// text-embedding-004) plugs in later without touching retrieval; provider.id
// is recorded so an id change forces a reindex.

export interface EmbeddingProvider {
  /** Versioned identity of the embedding space; a change requires reindexing. */
  readonly id: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}

export interface DeterministicHashEmbeddingProviderOptions {
  dimensions?: number
  seed?: number
}

/** Cosine similarity between two equal-length vectors (0 if either is zero). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Lowercase, strip diacritics (NFD + combining-mark removal, so
 * "COMITÉ" === "comite"), split on non-alphanumeric runs.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

// FNV-1a 32-bit, seed-mixed. Pure integer math — identical on every runtime.
function fnv1a(token: string, seed: number): number {
  let hash = (0x811c9dc5 ^ Math.imul(seed, 0x9e3779b9)) >>> 0
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Deterministic bag-of-words embedding by signed token hashing ("feature
 * hashing"): each token adds ±1 at (hash % dimensions), sign taken from a
 * second hash bit to reduce collision bias; the vector is L2-normalized so
 * dot product == cosine. Pure, seeded, offline — same text always embeds to
 * the identical vector.
 */
export class DeterministicHashEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  private readonly seed: number

  constructor(options: DeterministicHashEmbeddingProviderOptions = {}) {
    this.dimensions = options.dimensions ?? 384
    this.seed = options.seed ?? 1
    if (this.dimensions <= 0) throw new Error('dimensions must be positive')
    this.id = `deterministic-hash-v1:d${this.dimensions}:s${this.seed}`
  }

  // Async to honor the interface contract (real providers call a network API);
  // the computation itself is synchronous and pure.
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text))
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0)
    for (const token of tokenize(text)) {
      const hash = fnv1a(token, this.seed)
      const index = hash % this.dimensions
      const sign = (hash & 0x80000000) === 0 ? 1 : -1
      vector[index] += sign
    }
    let norm = 0
    for (const value of vector) norm += value * value
    if (norm > 0) {
      const inv = 1 / Math.sqrt(norm)
      for (let i = 0; i < vector.length; i++) vector[i] *= inv
    }
    return vector
  }
}

// lib/supabase/evidence-object-reader.ts
// G-01 — the one concrete `EvidenceObjectReader`, wired to Supabase Storage.
//
// ---------------------------------------------------------------------------
// WHY IT LIVES HERE AND NOT IN lib/grounding/**
// ---------------------------------------------------------------------------
// `resolveEvidenceSource` takes the reader as an INTERFACE precisely so that
// GROUNDING stays free of a storage client — every one of its twenty cases is
// provable without a network. This module is the composition root's half of
// that bargain: it knows the bucket and the client, and it knows nothing about
// scopes, hashes or ingestion.
//
// ---------------------------------------------------------------------------
// THE PRINCIPAL
// ---------------------------------------------------------------------------
// `createClient()` from lib/supabase/server.ts builds a request-scoped client
// over `NEXT_PUBLIC_SUPABASE_ANON_KEY` and the caller's own cookies, so the
// download runs under the SESSION and is subject to the bucket's RLS. There is
// deliberately no service-role client here and no way to pass one in: the
// factory takes no arguments, so a call site cannot hand it elevated
// credentials even by mistake.
//
// The bucket is the same constant `lib/pipeline/evidence.ts` uploads to. It is
// a literal rather than a parameter for the same reason: a reader that can be
// pointed at another bucket is one refactor away from being pointed at one the
// caller may not read.

import { createClient } from './server'
import type { EvidenceObjectReader } from '@/lib/grounding/ingest'

/** The bucket `lib/pipeline/evidence.ts` uploads evidence files to. */
const EVIDENCE_BUCKET = 'uellix-evidence'

/**
 * Reads evidence objects under the caller's own session.
 *
 * `read` returns `null` for an absent or unreadable object rather than
 * throwing: absence is an ordinary outcome the resolver already has a refusal
 * for, and an exception would only have to be classified back into one. The
 * storage error is deliberately NOT propagated — it can name a bucket and a
 * path, and the resolver's refusal detail is written to an audit trail.
 */
export function createEvidenceObjectReader(): EvidenceObjectReader {
  return {
    id: 'supabase-evidence-storage-v1',
    async read(filePath: string): Promise<Buffer | null> {
      const supabase = await createClient()
      const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).download(filePath)
      if (error || !data) return null
      return Buffer.from(await data.arrayBuffer())
    },
  }
}

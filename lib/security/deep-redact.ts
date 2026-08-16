// lib/security/deep-redact.ts
//
// A structure-preserving walk that applies a string transform to every string
// LEAF of an arbitrary value.
//
// ---------------------------------------------------------------------------
// WHY LEAVES, AND NEVER THE SERIALIZED FORM
// ---------------------------------------------------------------------------
// The obvious implementation — `JSON.parse(redact(JSON.stringify(value)))` —
// is wrong, and wrong in a way that is quiet until it is loud. Several
// redaction rules are bounded only by whitespace (`[^\s]+` in the PII
// url-credentials rule, the DSN rule's authority component). Minified JSON has
// no whitespace, so one such match eats across `","` boundaries and swallows
// the following keys. The result is a payload that no longer parses, or worse,
// one that parses into a DIFFERENT SHAPE than the citation catalog was
// computed from — which would silently re-point every sourceRefIndex the model
// returns at the wrong field.
//
// So: walk first, transform leaves, serialize after. Keys, array lengths,
// numbers, booleans and nulls are carried through untouched.
//
// ---------------------------------------------------------------------------
// FAIL CLOSED
// ---------------------------------------------------------------------------
// Three ways a walk can go wrong, and what each does:
//
//   a transform throws   → that leaf becomes `[REDACTED:error]`. The walk
//                          continues. A redactor that throws must never take
//                          the caller down and must never leave the raw value
//                          in place.
//   a cycle              → `[REDACTED:circular]`. Sentry contexts and captured
//                          request objects are routinely cyclic.
//   depth beyond the cap → `[REDACTED:depth]`. Bounds work on adversarial or
//                          pathological input without dropping the event.
//
// In all three the output is a token, never the untransformed input.

/** Emitted in place of a value the walk refused to process. */
export const DEEP_REDACT_ERROR_TOKEN = '[REDACTED:error]'
export const DEEP_REDACT_CIRCULAR_TOKEN = '[REDACTED:circular]'
export const DEEP_REDACT_DEPTH_TOKEN = '[REDACTED:depth]'

export interface DeepRedactOptions {
  /** Applied to every string leaf. Must be pure; may throw (handled). */
  readonly transform: (text: string) => string
  /**
   * Consulted for every OBJECT PROPERTY before its value is walked. Returning
   * a string replaces the whole value — this is how `authorization` and
   * `cookie` are removed wholesale rather than pattern-matched, since a header
   * value is secret by virtue of its NAME whatever it happens to contain.
   * Returning null walks the value normally.
   */
  readonly redactKey?: (key: string) => string | null
  /** Structural depth cap. Default 24 — far beyond any real Sentry event. */
  readonly maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 24

/**
 * Only plain containers are descended into. A Date, a RegExp, a Map or a class
 * instance is returned by reference: walking it would risk reshaping something
 * the consumer depends on, and none of them are how this codebase carries
 * strings. (Sentry events and Stella payloads are JSON all the way down.)
 */
function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}

/**
 * Deep-redact `value`, preserving its structure exactly.
 *
 * Returns a NEW value; the input is never mutated. That matters at the model
 * boundary: the caller's context object may legitimately still be needed
 * unredacted for the internal audit record.
 */
export function deepRedact<T>(value: T, options: DeepRedactOptions): T {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const seen = new WeakSet<object>()

  const apply = (text: string): string => {
    try {
      const out = options.transform(text)
      return typeof out === 'string' ? out : DEEP_REDACT_ERROR_TOKEN
    } catch {
      return DEEP_REDACT_ERROR_TOKEN
    }
  }

  const walk = (current: unknown, depth: number): unknown => {
    if (typeof current === 'string') return apply(current)
    if (current === null || typeof current !== 'object') return current

    if (depth >= maxDepth) return DEEP_REDACT_DEPTH_TOKEN
    if (seen.has(current)) return DEEP_REDACT_CIRCULAR_TOKEN
    seen.add(current)

    try {
      if (Array.isArray(current)) {
        // Cardinality is preserved: a dropped element would change what the
        // model — or the on-call reader — is looking at.
        return current.map((item) => walk(item, depth + 1))
      }

      if (!isPlainContainer(current)) return current

      const output: Record<string, unknown> = {}
      for (const key of Object.keys(current)) {
        const replacement = options.redactKey?.(key) ?? null
        output[key] = replacement !== null ? replacement : walk(current[key], depth + 1)
      }
      return output
    } catch {
      return DEEP_REDACT_ERROR_TOKEN
    } finally {
      // Released so a value that legitimately appears twice in a TREE (not a
      // cycle) is redacted both times instead of the second becoming a
      // circular token.
      seen.delete(current)
    }
  }

  return walk(value, 0) as T
}

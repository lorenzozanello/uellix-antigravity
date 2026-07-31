/** A concrete contextual leaf path: object segments and non-negative bracket indexes. */
export const CanonicalSourceFieldPathPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/

export function isCanonicalSourceFieldPath(path: string): boolean {
  return CanonicalSourceFieldPathPattern.test(path)
}

/**
 * R1: sentinel segment appended to the path of an empty registered
 * collection (array or object), so absence itself becomes a citable leaf —
 * e.g. `outcomesSnapshot.empty`. The sentinel matches the canonical path
 * pattern and only exists for genuinely empty containers.
 */
export const EMPTY_COLLECTION_SENTINEL_SEGMENT = 'empty'

export function emptyCollectionSentinelPath(path: string): string {
  return `${path}.${EMPTY_COLLECTION_SENTINEL_SEGMENT}`
}

/**
 * Collects the concrete leaves of one request-local contextual snapshot.
 * Object insertion order and array order are deliberately preserved.
 * Empty collections contribute a `.empty` sentinel leaf (R1) instead of
 * disappearing from the catalog; the root container never does.
 */
export function collectCanonicalSourceFieldPaths(value: unknown): string[] {
  const paths: string[] = []

  const visit = (current: unknown, path: string): void => {
    if (current === undefined) return
    if (current === null || typeof current !== 'object') {
      if (path) paths.push(path)
      return
    }
    if (Array.isArray(current)) {
      if (current.length === 0) {
        if (path) paths.push(emptyCollectionSentinelPath(path))
        return
      }
      current.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    const keys = Object.keys(current)
    if (keys.length === 0) {
      if (path) paths.push(emptyCollectionSentinelPath(path))
      return
    }
    for (const key of keys) {
      visit((current as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
    }
  }

  visit(value, '')
  return paths
}

/** A concrete contextual leaf path: object segments and non-negative bracket indexes. */
export const CanonicalSourceFieldPathPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/

export function isCanonicalSourceFieldPath(path: string): boolean {
  return CanonicalSourceFieldPathPattern.test(path)
}

/**
 * Collects the concrete leaves of one request-local contextual snapshot.
 * Object insertion order and array order are deliberately preserved.
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
      current.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    for (const key of Object.keys(current)) {
      visit((current as Record<string, unknown>)[key], path ? `${path}.${key}` : key)
    }
  }

  visit(value, '')
  return paths
}

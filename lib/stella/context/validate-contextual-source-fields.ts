import { StellaParseError } from '../errors'

type SourceFieldsOutput = {
  findings: unknown
  suggestions: unknown
}

export class ContextualSourceFieldsValidationError extends StellaParseError {
  readonly location: string
  readonly received: unknown
  readonly reason: string

  constructor(location: string, received: unknown, reason: string) {
    super(`${location}: received ${describeReceivedValue(received)}; ${reason}`)
    this.name = 'ContextualSourceFieldsValidationError'
    this.location = location
    this.received = received
    this.reason = reason
  }
}

function describeReceivedValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  return typeof value
}

function validateCollection(value: unknown, collection: 'findings' | 'suggestions', allowed: ReadonlySet<string>): void {
  if (!Array.isArray(value)) {
    throw new ContextualSourceFieldsValidationError(collection, value, 'must be an array')
  }
  value.forEach((item, itemIndex) => {
    const baseLocation = `${collection}[${itemIndex}].sourceFields`
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Object.hasOwn(item, 'sourceFields')) {
      throw new ContextualSourceFieldsValidationError(baseLocation, item, 'must be present on an object item')
    }
    const sourceFields = (item as { sourceFields: unknown }).sourceFields
    if (!Array.isArray(sourceFields)) {
      throw new ContextualSourceFieldsValidationError(baseLocation, sourceFields, 'must be an array')
    }
    sourceFields.forEach((sourceField, fieldIndex) => {
      const location = `${baseLocation}[${fieldIndex}]`
      if (typeof sourceField !== 'string') {
        throw new ContextualSourceFieldsValidationError(location, sourceField, 'must be a string')
      }
      if (!allowed.has(sourceField)) {
        throw new ContextualSourceFieldsValidationError(location, sourceField, 'must exactly match a canonical source path for this request')
      }
    })
  })
}

/** Fails closed unless every citation exactly belongs to this request's frozen catalog. */
export function validateContextualSourceFields(
  canonicalSourceFieldPaths: readonly string[],
  output: SourceFieldsOutput,
): void {
  const allowed = new Set(canonicalSourceFieldPaths)
  validateCollection(output.findings, 'findings', allowed)
  validateCollection(output.suggestions, 'suggestions', allowed)
}

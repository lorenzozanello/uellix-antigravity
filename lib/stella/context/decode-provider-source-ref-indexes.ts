import { StellaParseError } from '../errors'
import { AdvisorContextualOutputSchema, type AdvisorContextualOutput } from '../schemas/advisor-contextual-output'
import { validateContextualSourceFields } from './validate-contextual-source-fields'

export class ProviderSourceRefIndexesError extends StellaParseError {
  constructor(readonly location: string, received: unknown, readonly reason: string) {
    super(`${location}: received ${typeof received}; ${reason}`)
    this.name = 'ProviderSourceRefIndexesError'
  }
}

const outputKeys = ['step', 'responseType', 'summary', 'findings', 'suggestions', 'clarifyingQuestions', 'limitations', 'requiresHumanReview']
const findingKeys = ['id', 'severity', 'title', 'explanation', 'sourceRefIndexes']
const suggestionKeys = ['id', 'proposedText', 'rationale', 'missingInformation', 'sourceRefIndexes']

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderSourceRefIndexesError(location, value, 'must be an object')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new ProviderSourceRefIndexesError(location, value, `is missing ${key}`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ProviderSourceRefIndexesError(`${location}.${key}`, value[key], 'is not allowed')
}
function decode(value: unknown, name: 'findings' | 'suggestions', keys: readonly string[], paths: readonly string[]): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new ProviderSourceRefIndexesError(name, value, 'must be an array')
  return value.map((candidate, itemIndex) => {
    const location = `${name}[${itemIndex}]`; const item = record(candidate, location); exact(item, keys, location)
    if (!Array.isArray(item.sourceRefIndexes)) throw new ProviderSourceRefIndexesError(`${location}.sourceRefIndexes`, item.sourceRefIndexes, 'must be an array')
    const sourceFields = item.sourceRefIndexes.map((index, indexPosition) => {
      if (typeof index !== 'number' || !Number.isInteger(index) || !Number.isFinite(index) || index < 0 || index >= paths.length) throw new ProviderSourceRefIndexesError(`${location}.sourceRefIndexes[${indexPosition}]`, index, 'must be an in-range integer')
      return paths[index]
    })
    const { sourceRefIndexes: _, ...rest } = item; void _
    return { ...rest, sourceFields }
  })
}

/** Converts the provider-only index transport to internal paths without mutating raw JSON. */
export function decodeProviderSourceRefIndexes(value: unknown, paths: readonly string[]): AdvisorContextualOutput {
  const raw = record(value, 'response'); exact(raw, outputKeys, 'response')
  const internal = { ...raw, findings: decode(raw.findings, 'findings', findingKeys, paths), suggestions: decode(raw.suggestions, 'suggestions', suggestionKeys, paths) }
  const parsed = AdvisorContextualOutputSchema.parse(internal)
  validateContextualSourceFields(paths, parsed)
  return parsed
}

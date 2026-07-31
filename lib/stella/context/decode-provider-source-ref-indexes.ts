import { StellaParseError } from '../errors'
import { AdvisorContextualOutputSchema, type AdvisorContextualOutput } from '../schemas/advisor-contextual-output'
import { validateContextualSourceFields } from './validate-contextual-source-fields'
import { validateNoIndexReferenceTokens } from './validate-no-index-reference-tokens'

export class ProviderSourceRefIndexesError extends StellaParseError {
  constructor(readonly location: string, received: unknown, readonly reason: string) {
    super(`${location}: received ${typeof received}; ${reason}`)
    this.name = 'ProviderSourceRefIndexesError'
  }
}

export class ProviderOutputContractError extends StellaParseError {
  constructor(readonly location: string, received: unknown, readonly reason: string) {
    super(`${location}: received ${typeof received}; ${reason}`)
    this.name = 'ProviderOutputContractError'
  }
}

export class InternalSchemaValidationError extends StellaParseError {
  constructor(readonly reason: string) {
    super(`Internal schema validation failed: ${reason}`)
    this.name = 'InternalSchemaValidationError'
  }
}

const outputKeys = ['step', 'responseType', 'summary', 'findings', 'suggestions', 'clarifyingQuestions', 'limitations', 'requiresHumanReview']
const findingKeys = ['id', 'severity', 'title', 'explanation', 'sourceRefIndexes']
const suggestionKeys = ['id', 'proposedText', 'rationale', 'missingInformation', 'sourceRefIndexes']

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderOutputContractError(location, value, 'must be an object')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[], location: string): void {
  for (const key of keys) if (!Object.hasOwn(value, key)) throw new ProviderOutputContractError(location, value, `is missing ${key}`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ProviderOutputContractError(`${location}.${key}`, value[key], 'is not allowed')
}
function decode(value: unknown, name: 'findings' | 'suggestions', keys: readonly string[], paths: readonly string[]): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new ProviderOutputContractError(name, value, 'must be an array')
  return value.map((candidate, itemIndex) => {
    const location = `${name}[${itemIndex}]`; const item = record(candidate, location)
    if ('sourceFields' in item) throw new ProviderSourceRefIndexesError(`${location}.sourceFields`, item.sourceFields, 'sourceFields not allowed in provider response')
    exact(item, keys, location)
    if (!Array.isArray(item.sourceRefIndexes)) throw new ProviderSourceRefIndexesError(`${location}.sourceRefIndexes`, item.sourceRefIndexes, 'must be an array')
    const sourceFields = item.sourceRefIndexes.map((index, indexPosition) => {
      if (typeof index !== 'number' || !Number.isInteger(index) || !Number.isFinite(index) || index < 0 || index >= paths.length) throw new ProviderSourceRefIndexesError(`${location}.sourceRefIndexes[${indexPosition}]`, index, 'must be an in-range integer')
      return paths[index]
    })
    const { sourceRefIndexes: _, ...rest } = item; void _
    return { ...rest, sourceFields }
  })
}

export type DecodedAdvisorOutput = AdvisorContextualOutput & {
  readonly stepMismatch?: boolean
}

/** Converts the provider-only index transport to internal paths without mutating raw JSON. */
export function decodeProviderSourceRefIndexes(
  value: unknown,
  paths: readonly string[],
  expectedStep?: string
): DecodedAdvisorOutput {
  const raw = record(value, 'response'); exact(raw, outputKeys, 'response')
  if (typeof raw.step !== 'string') throw new ProviderOutputContractError('response.step', raw.step, 'must be a string')

  const stepMismatch = expectedStep !== undefined && raw.step !== expectedStep
  const canonicalStep = expectedStep ?? raw.step

  const internal = { ...raw, step: canonicalStep, findings: decode(raw.findings, 'findings', findingKeys, paths), suggestions: decode(raw.suggestions, 'suggestions', suggestionKeys, paths) }

  let parsed: AdvisorContextualOutput
  try {
    parsed = AdvisorContextualOutputSchema.parse(internal)
  } catch (error) {
    throw new InternalSchemaValidationError(error instanceof Error ? error.message : String(error))
  }

  validateContextualSourceFields(paths, parsed)
  // R4: citations exist only as decoded sourceFields — free text must not
  // surface bare index tokens like "(0)" or the transport field name.
  validateNoIndexReferenceTokens(parsed, paths.length)

  const result = parsed as DecodedAdvisorOutput
  Object.defineProperty(result, 'stepMismatch', {
    value: stepMismatch,
    writable: false,
    enumerable: false,
    configurable: true,
  })

  return result
}


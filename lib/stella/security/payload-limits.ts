// lib/stella/security/payload-limits.ts
// WS3 (Fable Moonshot): centralized prompt-size cap for the Stella adapter.
// Pure module — no imports, no side effects.

/**
 * Thrown by the adapter when the serialized request messages exceed the
 * configured maxPromptChars. Mapped to the 'PAYLOAD_TOO_LARGE' action error
 * code by the four Stella server actions.
 */
export class StellaPayloadTooLargeError extends Error {
  readonly promptChars: number
  readonly maxPromptChars: number

  constructor(promptChars: number, maxPromptChars: number) {
    super(`Stella prompt payload too large: ${promptChars} chars (limit ${maxPromptChars})`)
    this.name = 'StellaPayloadTooLargeError'
    this.promptChars = promptChars
    this.maxPromptChars = maxPromptChars
  }
}

/** Measure the serialized request messages (system prompt + user message). */
export function measurePromptChars(request: { systemPrompt: string; userMessage: string }): number {
  return request.systemPrompt.length + request.userMessage.length
}

/** Throw StellaPayloadTooLargeError when the request exceeds the cap. */
export function assertPromptWithinLimit(
  request: { systemPrompt: string; userMessage: string },
  maxPromptChars: number
): void {
  const promptChars = measurePromptChars(request)
  if (promptChars > maxPromptChars) {
    throw new StellaPayloadTooLargeError(promptChars, maxPromptChars)
  }
}

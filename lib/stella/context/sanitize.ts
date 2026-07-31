// lib/stella/context/sanitize.ts
// Sprint 9B: Context sanitization to prevent prompt injection and secret leakage
// WS3 (Fable Moonshot): injection markers, untrusted-data envelope, inline labels.

// Secret-oriented patterns — matched case-insensitively as substrings.
const FORBIDDEN_PATTERNS = [
  'GEMINI_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'process.env',
  'SECRET',
  'PASSWORD',
  'API_KEY',
  'sk_',
  'key_',
  'secret_',
]

// Injection markers — prompt-injection attempts in Spanish and English.
// These extend the forbidden-pattern check (secrets above stay untouched).
// Regexes (not substrings) so that e.g. "ecosystem: renewal" or
// "operating system: Linux" do NOT false-positive on `system:`.
const FORBIDDEN_INJECTION_PATTERNS: RegExp[] = [
  // Ignore-previous-instructions (EN)
  /ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  /disregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  // Ignore-previous-instructions (ES)
  /ignor[aáe]\w*\s+(?:todas?\s+|las?\s+)?(?:las?\s+)?instrucciones/i,
  /instrucciones\s+(?:anteriores|previas)/i,
  /(?:ignora|olvida)\s+(?:todo\s+)?lo\s+anterior/i,
  // Fake conversation-role blocks at line start (EN + ES)
  /(?:^|\n)\s*system\s*:/i,
  /(?:^|\n)\s*assistant\s*:/i,
  /(?:^|\n)\s*sistema\s*:/i,
  /(?:^|\n)\s*asistente\s*:/i,
  // Role hijack (ES + EN)
  /eres\s+ahora/i,
  /act[uú]a\s+como/i,
  /you\s+are\s+now/i,
  /act\s+as\s+(?:a|an|the)\b/i,
  // Markdown fence breakout
  /```/,
]

/**
 * Sanitize string to prevent basic prompt injection.
 * Removes control characters and limits length.
 */
export function sanitizeString(input: string, maxLength = 1000): string {
  if (!input) return ''

  // Remove control characters (0x00-0x1F except newline/tab)
  let sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ')

  // Truncate
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + '...'
  }

  return sanitized.trim()
}

/**
 * Check if string contains forbidden patterns: secret-oriented substrings
 * (case-insensitive) or prompt-injection markers (regex, ES + EN).
 * Returns true if any forbidden pattern is found.
 */
export function hasForbiddenPattern(input: string): boolean {
  const lowerInput = input.toLowerCase()
  if (FORBIDDEN_PATTERNS.some((pattern) => lowerInput.includes(pattern.toLowerCase()))) {
    return true
  }
  return FORBIDDEN_INJECTION_PATTERNS.some((pattern) => pattern.test(input))
}

/**
 * Sanitize narrative text for safe inclusion in prompts.
 */
export function sanitizeNarrative(narrative: string): string {
  const cleaned = sanitizeString(narrative, 2000)
  if (hasForbiddenPattern(cleaned)) {
    return '[Narrative contains restricted content - filtered for Stella]'
  }
  return cleaned
}

/**
 * Sanitize outcome name and description.
 */
export function sanitizeOutcome(name: string, description?: string): { name: string; description: string } {
  return {
    name: sanitizeString(name, 200),
    description: sanitizeString(description || '', 500),
  }
}

/**
 * Sanitize a short label interpolated into a SYSTEM prompt (e.g. a pipeline
 * step or a report section type). Strips control characters AND newlines,
 * collapses whitespace, and truncates — a label can never span lines or smuggle
 * a fake prompt section into the system prompt.
 */
export function sanitizeInlineLabel(input: string, maxLength = 80): string {
  if (!input) return ''
  const collapsed = input
    .replace(/[\x00-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed
}

/**
 * Marker that opens the untrusted-data envelope in every Stella user message.
 * Mirrors the contextual advisor pattern (advisor-contextual-system.ts).
 */
export const UNTRUSTED_DATA_MARKER = 'UNTRUSTED_PROJECT_DATA'

/**
 * Wrap user/org-derived content in the delimited untrusted-data envelope:
 * the marker on its own line followed by a single JSON payload.
 * JSON.stringify escapes newlines and quotes, so payload content can never
 * start a new line, close the envelope, or spoof the marker at line start.
 */
export function wrapUntrustedData(payload: unknown): string {
  return `${UNTRUSTED_DATA_MARKER}\n${JSON.stringify(payload)}`
}

/**
 * Mark user-provided content as data, not instructions.
 * Now delegates to the untrusted-data envelope.
 */
export function markAsData(content: string): string {
  return wrapUntrustedData(content)
}

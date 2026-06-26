// lib/stella/context/sanitize.ts
// Sprint 9B: Context sanitization to prevent prompt injection and secret leakage

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
 * Check if string contains forbidden patterns (case-insensitive).
 * Returns true if forbidden pattern found.
 */
export function hasForbiddenPattern(input: string): boolean {
  const lowerInput = input.toLowerCase()
  return FORBIDDEN_PATTERNS.some(pattern => lowerInput.includes(pattern.toLowerCase()))
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
 * Mark user-provided content as data, not instructions.
 */
export function markAsData(content: string): string {
  return `[DATA]: ${content}`
}

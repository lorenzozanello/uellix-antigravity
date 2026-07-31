// lib/stella/context/sanitize.ts
// Sprint 9B: Context sanitization to prevent prompt injection and secret leakage
// WS3 (Fable Moonshot): injection markers, untrusted-data envelope, inline
// labels, PII redaction on all free-text paths.

import { redactPii } from '../security/redact-pii'

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
//
// FIX 3 (audit): these markers are defense-in-depth only — the untrusted-data
// envelope is the real defense — so they must be SPECIFIC enough that
// legitimate ToC prose is never destroyed. Standard narrative phrasings like
// "actúa como articulador/catalizador" or "Sistema: educativo departamental"
// must pass; a fake role block is only flagged when the same line carries
// instruction-like content, and role hijack only in explicit formulations.
const INSTRUCTION_TAIL =
  '(?:mode|modo|override|developer|desarrollador|debug|admin|root|enabled|activad|instru|aprueb|approve|certif|reveal|revela|ignor|secret|prompt)'

const FORBIDDEN_INJECTION_PATTERNS: RegExp[] = [
  // Ignore-previous-instructions (EN)
  /ignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  /disregard\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)/i,
  // Ignore-previous-instructions (ES)
  /ignor[aáe]\w*\s+(?:todas?\s+|las?\s+)?(?:las?\s+)?instrucciones/i,
  /instrucciones\s+(?:anteriores|previas)/i,
  /(?:ignora|olvida)\s+(?:todo\s+)?lo\s+anterior/i,
  // Fake conversation-role blocks at line start (EN + ES) — only when the
  // rest of the same line contains instruction-like content.
  new RegExp(`(?:^|\\n)\\s*(?:system|sistema|assistant|asistente)\\s*:[^\\n]*${INSTRUCTION_TAIL}`, 'i'),
  // Role hijack (ES) — explicit formulations only.
  /eres\s+ahora\s+un/i,
  /act[uú]a\s+como\s+(?:si\s+fueras|un\s+asistente|una?\s+(?:ia|inteligencia)|un\s+modelo|(?:el\s+)?administrador|el\s+sistema|root)/i,
  // Role hijack (EN) — explicit formulations only.
  /you\s+are\s+now\s+(?:a|an|in)\b/i,
  /[Yy]ou\s+are\s+now\s+[A-Z]{2,}/,
  /act\s+as\s+(?:if\b|the\s+system|an?\s+(?:ai|assistant|model|admin))/i,
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
  return redactPii(cleaned).text
}

/**
 * Sanitize an arbitrary free-text field (titles, names, sources, summaries)
 * for inclusion in a prompt payload: control-char cleanup + PII redaction.
 * Used by the prompt builders so every Stella role benefits from redaction
 * regardless of which context builder produced the data.
 */
export function sanitizeFreeText(input: string, maxLength = 500): string {
  return redactPii(sanitizeString(input, maxLength)).text
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

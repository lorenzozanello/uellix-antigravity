// components/stella/error-messages.ts
// WS2 (Moonshot) — shared error taxonomy for every Stella panel (U5).
//
// Maps the server-action error codes (see app/actions/stella/*.ts, READ-ONLY)
// to distinct Spanish presentations. Client-safe, dependency-free.

/** Union of every error code any Stella server action can return. */
export type StellaPanelErrorCode =
  | 'DISABLED'
  | 'UNAUTHORIZED'
  | 'UNSUPPORTED_STEP'
  | 'RATE_LIMITED'
  | 'RATE_LIMIT_UNAVAILABLE'
  | 'QUOTA_EXCEEDED'
  | 'PAYLOAD_TOO_LARGE'
  | 'GEMINI_ERROR'
  | 'PARSE_ERROR'
  | 'TIMEOUT'
  | 'AUDIT_ERROR'
  | 'UNKNOWN_ERROR'

export type StellaErrorTone = 'info' | 'warning' | 'error'

export interface StellaErrorPresentation {
  code: StellaPanelErrorCode
  /** Short Spanish title, distinct per code. */
  title: string
  /** Spanish body. For QUOTA_EXCEEDED this is the server message verbatim. */
  description: string
  /** Whether the panel should offer a "Reintentar" affordance. */
  retryable: boolean
  /** Drives iconography + styling in <StellaErrorNotice>. */
  tone: StellaErrorTone
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'DISABLED',
  'UNAUTHORIZED',
  'UNSUPPORTED_STEP',
  'RATE_LIMITED',
  'RATE_LIMIT_UNAVAILABLE',
  'QUOTA_EXCEEDED',
  'PAYLOAD_TOO_LARGE',
  'GEMINI_ERROR',
  'PARSE_ERROR',
  'TIMEOUT',
  'AUDIT_ERROR',
  'UNKNOWN_ERROR',
])

export function isStellaPanelErrorCode(code: string): code is StellaPanelErrorCode {
  return KNOWN_CODES.has(code)
}

/**
 * Extracts the reset info from a RATE_LIMITED server message
 * ("Rate limit exceeded. Resets at <hour>.") so the UI can show it in
 * Spanish without dropping the server-provided reset moment.
 */
function rateLimitResetInfo(message: string): string | null {
  const match = /Resets at\s+(.+?)\.?\s*$/i.exec(message)
  return match ? match[1]! : null
}

/**
 * Maps a server error code + message to a Spanish presentation.
 * Unknown codes degrade to the UNKNOWN_ERROR presentation.
 */
export function stellaErrorPresentation(code: string, message: string): StellaErrorPresentation {
  switch (code) {
    case 'DISABLED':
      return {
        code,
        title: 'Stella no está habilitada',
        description: 'Stella no está habilitada para tu organización en este momento.',
        retryable: false,
        tone: 'info',
      }
    case 'UNAUTHORIZED':
      return {
        code,
        title: 'Sin permiso para usar Stella',
        // The server message carries the role explanation (e.g. "Tu rol no
        // tiene permiso para usar Stella.") — show it when it is in Spanish,
        // otherwise fall back to a generic Spanish explanation.
        description: /[a-z]/i.test(message) && /\b(rol|permiso|acceso)\b/i.test(message)
          ? message
          : 'Tu sesión o tu rol no tiene permiso para usar Stella en este proyecto.',
        retryable: false,
        tone: 'warning',
      }
    case 'UNSUPPORTED_STEP':
      return {
        code,
        title: 'Paso no soportado',
        description: 'Stella todavía no ofrece orientación para este paso del pipeline.',
        retryable: false,
        tone: 'info',
      }
    case 'RATE_LIMITED': {
      const reset = rateLimitResetInfo(message)
      return {
        code,
        title: 'Límite de solicitudes por hora alcanzado',
        description: reset
          ? `Se alcanzó el límite de solicitudes a Stella por esta hora. Se restablece a las ${reset} (UTC).`
          : `Se alcanzó el límite de solicitudes a Stella por esta hora. ${message}`,
        retryable: false,
        tone: 'warning',
      }
    }
    case 'RATE_LIMIT_UNAVAILABLE':
      return {
        code,
        title: 'Servicio de límites no disponible',
        description:
          'El servicio de control de límites de Stella no está disponible temporalmente. Podés reintentar en unos segundos.',
        retryable: true,
        tone: 'warning',
      }
    case 'QUOTA_EXCEEDED':
      return {
        code,
        title: 'Cuota mensual agotada',
        // Verbatim: the server message includes quota, usage and reset date.
        description: message,
        retryable: false,
        tone: 'warning',
      }
    case 'PAYLOAD_TOO_LARGE':
      return {
        code,
        title: 'El contexto es demasiado grande',
        description:
          'El contexto del proyecto supera el tamaño que Stella puede analizar. Reducí la cantidad de texto en las secciones más extensas (narrativa, descripciones) e intentá de nuevo.',
        retryable: false,
        tone: 'warning',
      }
    case 'TIMEOUT':
      return {
        code,
        title: 'La solicitud tardó demasiado',
        description:
          'Stella no respondió a tiempo. Suele ser transitorio: podés reintentar ahora.',
        retryable: true,
        tone: 'warning',
      }
    case 'PARSE_ERROR':
      return {
        code,
        title: 'Respuesta con formato inesperado',
        description:
          'Stella devolvió una respuesta con un formato que no se pudo verificar, así que no se muestra. Podés intentar de nuevo.',
        retryable: false,
        tone: 'error',
      }
    case 'GEMINI_ERROR':
      return {
        code,
        title: 'Error del servicio de IA',
        description:
          'El servicio de IA de Stella encontró un error inesperado. Podés intentar de nuevo en unos minutos.',
        retryable: false,
        tone: 'error',
      }
    case 'AUDIT_ERROR':
      return {
        code,
        title: 'No se pudo registrar la interacción',
        description:
          'La respuesta se descartó porque no se pudo registrar la interacción para auditoría. Intentá de nuevo.',
        retryable: false,
        tone: 'error',
      }
    case 'UNKNOWN_ERROR':
    default:
      return {
        code: 'UNKNOWN_ERROR',
        title: 'Stella no está disponible',
        description: 'Stella no está disponible temporalmente. Podés intentar de nuevo en unos minutos.',
        retryable: false,
        tone: 'error',
      }
  }
}

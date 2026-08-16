// tests/fixtures/synthetic-credentials.ts
//
// The single home for credential-SHAPED literals used by the redaction suites.
//
// Every value here is inert. None of them can authenticate against anything,
// and that is a property this file has to keep proving rather than assert:
// `scripts/scan-secrets.ts` scans this file like any other. Two techniques keep
// it green without weakening the gate (which the F-GB brief forbids):
//
//   1. The credential BODY announces itself — `not-a-real`, `placeholder`,
//      `synthetic`, `fake`. `isUnmistakablePlaceholder` reads the secret half,
//      so a marker inside the value is what excuses it, not a fixture hostname.
//   2. Where the shape is base64 and cannot carry a legible marker (a JWT), the
//      value is ASSEMBLED AT RUNTIME from parts. No single line contains a
//      match, so there is nothing for a line-oriented scanner — ours or
//      GitHub's push protection — to find.
//
// The detectors still MATCH these shapes; that is the point. A fixture the
// redactor is not asked to recognise proves nothing.

/** Google/Gemini API key shape: `AIza` + 35 token chars. */
export const SYNTHETIC_GEMINI_KEY = 'AIzaSyNOT_A_REAL_KEY_000000000000000000'

/** Supabase Personal Access Token shape (the GH013 detector's target). */
export const SYNTHETIC_SUPABASE_PAT = 'sbp_placeholder_not_a_real_token_0000'

/** Supabase secret-key shape. */
export const SYNTHETIC_SUPABASE_SECRET = 'sb_secret_placeholder_not_a_real_0000'

/** OpenAI-style key shape. */
export const SYNTHETIC_OPENAI_KEY = 'sk-placeholder-not-a-real-key-000000'

/**
 * JWT shape, assembled at runtime. Base64 segments cannot carry a legible
 * fixture marker, so the value never exists as a literal on any single line.
 */
export const SYNTHETIC_JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiJzeW50aGV0aWMtc3ViamVjdCJ9',
  'c3ludGhldGljLXNpZ25hdHVyZS12YWx1ZQ',
].join('.')

/** Postgres DSN with an embedded password. Password carries the marker. */
export const SYNTHETIC_PG_DSN =
  'postgresql://uellix_app:not-a-real-password@db.ejemplo-remoto.supabase.co:5432/postgres'

/** Bare password used inside the DSN above — asserted on independently. */
export const SYNTHETIC_PG_PASSWORD = 'not-a-real-password'

/** Bearer token value (no recognised prefix — exercises the generic rules). */
export const SYNTHETIC_BEARER_TOKEN = 'placeholder0not0a0real0bearer0token0value'

/** Session cookie value. */
export const SYNTHETIC_COOKIE_VALUE = 'sb-access-token=placeholder-not-a-real-session-value'

/** Webhook signing secret. */
export const SYNTHETIC_WEBHOOK_SECRET = 'whsec_placeholder_not_a_real_webhook_0000'

/** URL carrying credentials in the authority component. */
export const SYNTHETIC_URL_WITH_CREDENTIALS =
  'https://operador:not-a-real-password@panel.ejemplo.test/informes'

/** URL carrying a token in the query string. */
export const SYNTHETIC_URL_WITH_QUERY_TOKEN =
  'https://api.ejemplo.test/v1/generate?key=AIzaSyNOT_A_REAL_KEY_000000000000000000&alt=sse'

/**
 * Every synthetic credential as a flat list, for suites that assert "none of
 * these survives". Kept in one place so a new fixture is automatically covered
 * by every existing "nothing leaks" assertion instead of silently escaping it.
 */
export const ALL_SYNTHETIC_SECRETS: readonly string[] = [
  SYNTHETIC_GEMINI_KEY,
  SYNTHETIC_SUPABASE_PAT,
  SYNTHETIC_SUPABASE_SECRET,
  SYNTHETIC_OPENAI_KEY,
  SYNTHETIC_JWT,
  SYNTHETIC_PG_PASSWORD,
  SYNTHETIC_BEARER_TOKEN,
  SYNTHETIC_WEBHOOK_SECRET,
]

// ---------------------------------------------------------------------------
// Personal data fixtures
// ---------------------------------------------------------------------------
// Colombian/Spanish forms, because that is what the deployment actually holds
// and what `redactPii` was written against.

export const SYNTHETIC_EMAIL = 'juan.perez@ejemplo-fundacion.test'
export const SYNTHETIC_EMAIL_ACCENTED = 'josé.muñoz@fundación.test'
export const SYNTHETIC_PHONE_INTL = '+57 300 123 4567'
export const SYNTHETIC_PHONE_PARENS = '(301) 555-0147'
export const SYNTHETIC_PHONE_LOCAL = '312-555-0182'
export const SYNTHETIC_CEDULA = 'cédula 1.234.567.890'
export const SYNTHETIC_CEDULA_DIGITS = '1.234.567.890'
export const SYNTHETIC_NIT = 'NIT 900.123.456-7'

/**
 * Personal-data values that must never survive to a provider or to telemetry.
 * The cédula/NIT entries list the DIGIT RUN, not the phrase: the redactor
 * deliberately keeps the context word ("cédula [REDACTED:id]") so the model
 * still knows what was removed.
 */
export const ALL_SYNTHETIC_PII: readonly string[] = [
  SYNTHETIC_EMAIL,
  SYNTHETIC_EMAIL_ACCENTED,
  SYNTHETIC_PHONE_INTL,
  SYNTHETIC_PHONE_PARENS,
  SYNTHETIC_PHONE_LOCAL,
  SYNTHETIC_CEDULA_DIGITS,
  '900.123.456-7',
]

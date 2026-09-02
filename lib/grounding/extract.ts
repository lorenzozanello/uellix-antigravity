// lib/grounding/extract.ts
// WS5 (document grounding): dependency-free ingest-time extraction layer.
//
// Pure and synchronous — no network, no fs, no DB. Designed to be called on the
// in-memory Buffer already present at upload time in
// lib/pipeline/evidence.ts:137 (the SHA-256 hashing point), so extraction never
// needs a storage round-trip. Extraction failures must never block an evidence
// upload: every failure mode is a returned status, never a thrown exception.
//
// Real extractors: text/csv (RFC 4180-ish) and text/plain.
// PDF / XLSX / DOC(X) intentionally return status 'unsupported' — parsing those
// binary formats requires an npm dependency, which is the external product
// decision G5 (docs/ops/gates/G5_PACKAGE.md). Hand-rolling binary parsers is
// explicitly out of scope.

export type ExtractionStatus = 'extracted' | 'unsupported' | 'error'

export interface ExtractedPage {
  page: number
  text: string
}

export interface ExtractedTable {
  page?: number
  rows: string[][]
}

export interface ExtractionResult {
  status: ExtractionStatus
  text: string
  pages: ExtractedPage[]
  tables: ExtractedTable[]
  warnings: string[]
  meta: { chars: number; truncated: boolean }
}

// Mirrors MAX_EVIDENCE_FILE_SIZE_BYTES in lib/pipeline/evidence.ts (25 MB).
// Kept as a local constant instead of an import so this module stays free of
// the server-only dependency chain (db client, Supabase server client) that
// lib/pipeline/evidence.ts pulls in.
export const MAX_GROUNDING_INPUT_BYTES = 25 * 1024 * 1024

// Cap on extracted text length. A 25 MB text file decodes to far more content
// than any grounding index needs; beyond this we truncate and flag it.
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000

const CSV_MIME_TYPES = new Set(['text/csv', 'application/csv'])
const PLAIN_MIME_TYPES = new Set(['text/plain'])

// Formats we deliberately do not parse without the G5 dependency decision.
const G5_GATED_FORMATS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX spreadsheet',
  'application/vnd.ms-excel': 'XLS spreadsheet',
  'application/msword': 'DOC document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX document',
}

/**
 * Which extractor — if any — claims a MIME type.
 *
 * SPLIT OUT OF `extractDocument` SO THERE IS ONE TABLE, NOT TWO. The evidence
 * UX has to tell a reviewer "this document cannot be indexed" BEFORE any bytes
 * are read, and the only honest source for that answer is the same table the
 * extractor itself branches on. A second list in the UI layer would be free to
 * drift the day a format is added here — which is the exact shape of "the
 * screen says PDF is indexable and the pipeline always skips it".
 *
 * `warning` is worded here rather than at each call site for the same reason.
 */
export type GroundingFormatSupport =
  /** A real extractor exists. `mimeType` is the normalized form. */
  | { readonly kind: 'text'; readonly mimeType: string }
  | { readonly kind: 'csv'; readonly mimeType: string }
  /** Parseable in principle; gated on the G5 npm-dependency decision. */
  | { readonly kind: 'gated'; readonly mimeType: string; readonly label: string; readonly warning: string }
  /** No extractor registered for it, and none is planned. */
  | { readonly kind: 'unregistered'; readonly mimeType: string; readonly warning: string }

/**
 * `text/CSV; charset=UTF-8` -> `text/csv`.
 *
 * Parameters are stripped rather than matched, because `charset` is the one a
 * browser routinely appends and it changes nothing about which parser applies.
 * Deliberately LENIENT about shape: deciding whether a string is a well-formed
 * MIME type at all belongs to the layer that also knows what to do about it
 * (see `classifyEvidenceIndexability`), and duplicating the judgement here
 * would give a malformed value two different names.
 */
export function normalizeExtractionMimeType(raw: string): string {
  return raw.split(';')[0].trim().toLowerCase()
}

/** The extractor table, as a decision. Pure; takes no bytes. */
export function classifyGroundingFormat(rawMimeType: string): GroundingFormatSupport {
  const mimeType = normalizeExtractionMimeType(rawMimeType)

  if (PLAIN_MIME_TYPES.has(mimeType)) return { kind: 'text', mimeType }
  if (CSV_MIME_TYPES.has(mimeType)) return { kind: 'csv', mimeType }

  const label = G5_GATED_FORMATS[mimeType]
  if (label) {
    return {
      kind: 'gated',
      mimeType,
      label,
      warning: `${label} extraction (${mimeType}) requires an npm dependency pending the G5 product decision (docs/ops/gates/G5_PACKAGE.md); binary formats are never hand-parsed`,
    }
  }

  return {
    kind: 'unregistered',
    mimeType,
    warning: `No extractor registered for MIME type "${mimeType}"`,
  }
}

function emptyResult(status: ExtractionStatus, warnings: string[]): ExtractionResult {
  return { status, text: '', pages: [], tables: [], warnings, meta: { chars: 0, truncated: false } }
}

function decodeText(buffer: Buffer): { text: string; truncated: boolean; warnings: string[] } {
  let text = buffer.toString('utf8')
  // Strip a UTF-8 BOM so anchors/offsets never include an invisible prefix.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const warnings: string[] = []
  let truncated = false
  if (text.length > MAX_EXTRACTED_TEXT_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_TEXT_CHARS)
    truncated = true
    warnings.push(
      `Extracted text truncated at ${MAX_EXTRACTED_TEXT_CHARS} characters; anchors only cover the truncated prefix`,
    )
  }
  return { text, truncated, warnings }
}

/**
 * RFC 4180-ish CSV parser (dependency-free): quoted fields, escaped quotes
 * (`""`), embedded commas/newlines inside quotes, CRLF/CR/LF row terminators.
 * Lenient where real-world evidence files are messy: an unterminated quote
 * produces a warning and keeps the field content instead of throwing.
 */
function parseCsv(input: string): { rows: string[][]; warnings: string[] } {
  const rows: string[][] = []
  const warnings: string[] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let fieldWasQuoted = false
  let i = 0

  const endField = () => {
    row.push(field)
    field = ''
    fieldWasQuoted = false
  }
  const endRow = () => {
    endField()
    rows.push(row)
    row = []
  }

  while (i < input.length) {
    const ch = input[i]
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i += 1
        }
      } else {
        field += ch
        i += 1
      }
      continue
    }
    if (ch === '"' && field === '' && !fieldWasQuoted) {
      inQuotes = true
      fieldWasQuoted = true
      i += 1
    } else if (ch === ',') {
      endField()
      i += 1
    } else if (ch === '\r') {
      endRow()
      i += input[i + 1] === '\n' ? 2 : 1
    } else if (ch === '\n') {
      endRow()
      i += 1
    } else {
      field += ch
      i += 1
    }
  }
  if (inQuotes) {
    warnings.push('CSV contains an unterminated quoted field; content kept as-is')
  }
  // Flush the final row unless the file ended with a row terminator (in which
  // case the pending row is a single empty field — a phantom, not data).
  if (field !== '' || fieldWasQuoted || row.length > 0) {
    endRow()
  }
  return { rows, warnings }
}

/**
 * Extract text (and, where the format has structure, table rows) from an
 * evidence file held in memory. See module header for the contract; never
 * throws — all failure modes are encoded in `status` + `warnings`.
 */
export function extractDocument(buffer: Buffer, mimeType: string): ExtractionResult {
  // The size cap is checked BEFORE the format, so a 40 MB PDF is reported as
  // the operational problem it is rather than as an unsupported format the
  // operator would go looking for a parser for.
  if (buffer.length > MAX_GROUNDING_INPUT_BYTES) {
    return emptyResult('error', [
      `File exceeds the 25 MB grounding input cap (${buffer.length} bytes); matches the evidence upload limit in lib/pipeline/evidence.ts`,
    ])
  }

  // The table lives in `classifyGroundingFormat` — see its header for why the
  // branch below reads a decision instead of re-testing the MIME sets.
  const format = classifyGroundingFormat(mimeType)

  if (format.kind === 'text') {
    const { text, truncated, warnings } = decodeText(buffer)
    return {
      status: 'extracted',
      text,
      pages: [],
      tables: [],
      warnings,
      meta: { chars: text.length, truncated },
    }
  }

  if (format.kind === 'csv') {
    const { text, truncated, warnings } = decodeText(buffer)
    const parsed = parseCsv(text)
    return {
      status: 'extracted',
      text,
      pages: [],
      tables: [{ rows: parsed.rows }],
      warnings: [...warnings, ...parsed.warnings],
      meta: { chars: text.length, truncated },
    }
  }

  return emptyResult('unsupported', [format.warning])
}

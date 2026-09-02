// tests/cross-workstream/ticket-idempotency.test.ts
// INTEGRACIÓN — Tren 4.1, FASE 14. Las tres fronteras del protocolo de
// tickets, comprobadas donde se tocan y no dentro de cada línea.
//
// ---------------------------------------------------------------------------
// POR QUÉ ESTAS PRUEBAS NO ABREN UNA BASE
// ---------------------------------------------------------------------------
// Lo que el protocolo HACE se prueba contra PostgreSQL real, en
// `tests/e2e/stella-ticket-journey.e2e.test.ts`. Lo que se prueba aquí es lo
// que ninguna base puede contestar: que los DOS lados de cada frontera dicen lo
// mismo. Un contrato de canonicalización escrito en SQL y otro en Node pueden
// estar ambos correctos y no coincidir; una allowlist de eventos duplicada
// puede quedar desincronizada sin que ningún evento falle. Eso es lo que estas
// pruebas fijan, y es barato y determinista.

import { describe, expect, it } from 'vitest'
import { readSourceText } from '@/tests/helpers/source-text'
import { createHash } from 'node:crypto'

import {
  CANONICAL_QUERY_NAMESPACE,
  canonicalQueryHash,
  canonicalizeQuery,
  isCanonicalQueryHash,
} from '@/lib/stella/operation-ticket/canonical-query-hash'
import {
  TICKET_EVENT_ALLOWED_FIELDS,
  TICKET_LIFECYCLE_EVENT_NAMES,
  emitTicketEvent,
  ticketEventPayload,
  ticketTelemetryFailureCount,
} from '@/lib/stella/operation-ticket/ticket-observability'
import {
  STELLA_OBSERVABILITY_EVENT_NAMES,
  MAX_EVENT_FIELD_VALUE_LENGTH,
  validateObservabilityEvent,
} from '@/tests/eval/stella-release/observability-contract'
import { stellaErrorPresentation } from '@/components/stella/error-messages'

// FASE 9 (Train 4.2). `readSourceText`, never a bare `readFileSync`: several
// assertions below anchor on two and three CONSECUTIVE LINES, and `.ts`/`.tsx`
// are not pinned to LF by `.gitattributes` — so under `core.autocrlf=true` the
// same checkout materializes them either way. Normalizing at the READER is the
// only place that fixes every anchor at once; normalizing the FILES would be
// editing production bytes to suit a test.
const TICKET_SQL = readSourceText('db/prepared/stella_0014_operation_tickets.sql')
const CONTRACT_MD = readSourceText('docs/ops/contracts/INT-INT-001_operation_ticket_protocol.md')
const ACTION_TS = readSourceText('app/actions/stella/grounded-query.ts')
const PANEL_TSX = readSourceText('components/stella/StellaGroundedQueryPanel.tsx')
const PRODUCT_CONTRACT_TS = readSourceText('components/stella/grounded-query.ts')
const ADAPTER_TS = readSourceText('db/stella/operation-tickets.ts')

/** Source with comments stripped — assertions of the form "this must NOT appear"
 *  otherwise punish documentation that names what it deliberately avoids. */
function codeLines(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

/* ========================================================================== */
/* CAPABILITIES -> RUNTIME                                                    */
/* ========================================================================== */

describe('CAPABILITIES -> RUNTIME: el digest canónico', () => {
  it('el namespace de Node es EXACTAMENTE el que publica el contrato', () => {
    expect(CANONICAL_QUERY_NAMESPACE).toBe('stella/query/v1')
    expect(CONTRACT_MD).toContain("sha256_hex(utf8('stella/query/v1' || LF || canonical(q)))")
  })

  it('el digest se enmarca como el contrato dice, recomputado desde cero', () => {
    // El oráculo INDEPENDIENTE: se reconstruye el digest desde la definición
    // del contrato, sin llamar a la implementación. Comparar
    // `canonicalQueryHash` consigo mismo no probaría el encuadre.
    const q = '  Cuál   es  el SROI  '
    const canonical = canonicalizeQuery(q)
    const expected = createHash('sha256')
      .update(Buffer.from(`stella/query/v1\n${canonical}`, 'utf8'))
      .digest('hex')
    expect(canonicalQueryHash(q)).toBe(expected)
  })

  it('las seis reglas de canonicalización se cumplen sobre vectores compartidos', () => {
    const h = canonicalQueryHash
    // NFC
    expect(h('Cuál')).toBe(h('Cuál'))
    // trim + colapso, incluidos NBSP e ideográfico
    expect(h('  a \t\n b  ')).toBe(h('a b'))
    expect(h('a b')).toBe(h('a b'))
    expect(h('a　b')).toBe(h('a b'))
    // sensible a mayúsculas
    expect(h('A b')).not.toBe(h('a b'))
    // vacío y sólo-blancos colapsan al mismo digest, y es un digest válido
    expect(h('')).toBe(h('    \t '))
    expect(isCanonicalQueryHash(h(''))).toBe(true)
    // no ASCII
    expect(isCanonicalQueryHash(h('中文 查询 ñ é'))).toBe(true)
    // consultas distintas difieren
    expect(h('a b')).not.toBe(h('a c'))
    // forma: 64 hex minúsculas, la que el CHECK de SQL impone
    expect(h('cualquiera')).toMatch(/^[0-9a-f]{64}$/)
    expect(TICKET_SQL).toContain("'^[0-9a-f]{64}$'")
  })
})

describe('CAPABILITIES -> RUNTIME: la superficie gobernada', () => {
  it('el ticket sólo lo emite el servidor: la acción de emisión no acepta scope del cliente', () => {
    // Un único parámetro, y lo enlaza el servidor en el punto de montaje.
    expect(ACTION_TS).toContain('export async function issueStellaGroundedQueryTicketForProject(\n  projectId: string,\n)')
    // Ni categoría, ni TTL, ni nonce, ni clave de idempotencia como parámetros.
    const code = codeLines(ACTION_TS)
    expect(code).not.toMatch(/idempotencyKey/)
    expect(code).not.toMatch(/chargeNonce|charge_nonce/)
  })

  it('el actor, la organización y el proyecto se DERIVAN, nunca se reciben', () => {
    // `issue_operation_ticket` no tiene parámetro de actor: lo saca de auth.uid().
    expect(TICKET_SQL).toContain('CREATE OR REPLACE FUNCTION uellix_stella_ops.issue_operation_ticket(\n  p_organization_id uuid,\n  p_project_id uuid,\n  p_category varchar(50)\n)')
    expect(TICKET_SQL).toContain('auth.uid()')
  })

  it('el query hash es write-once y un digest distinto se rechaza', () => {
    expect(TICKET_SQL).toContain('the query digest of a ticket is fixed at bind')
    expect(TICKET_SQL).toContain("USING ERRCODE = 'U0107'")
  })

  it('la clave de idempotencia es INTERNA: se deriva dentro de complete y de un nonce que nadie devuelve', () => {
    expect(TICKET_SQL).toContain("'stella/ticket/charge/v1'")
    // Ninguna función RETURNS incluye el nonce.
    expect(TICKET_SQL).not.toMatch(/RETURNS[\s\S]{0,200}charge_nonce/)
    // Y el adaptador no lo lee ni lo nombra como dato.
    expect(codeLines(ADAPTER_TS)).not.toMatch(/charge_nonce/)
  })

  it('el adaptador nunca lee la tabla de tickets directamente', () => {
    const code = codeLines(ADAPTER_TS)
    expect(code).not.toMatch(/FROM\s+uellix_stella_ops\.operation_tickets/i)
    // Sólo las seis funciones gobernadas.
    for (const fn of [
      'issue_operation_ticket',
      'bind_operation_ticket',
      'complete_operation_ticket',
      'abort_operation_ticket',
      'inspect_operation_ticket',
      'expire_operation_tickets',
    ]) {
      expect(code).toContain(`uellix_stella_ops.${fn}`)
    }
  })

  it('el cobro ocurre por complete y el abort no cobra', () => {
    expect(TICKET_SQL).toContain('uellix_stella.consume_stella_quota(v_org, v_project, v_category, v_key)')
    // `abort` no menciona consume_stella_quota en su cuerpo.
    const abortBody = TICKET_SQL.slice(
      TICKET_SQL.indexOf('FUNCTION uellix_stella_ops.abort_operation_ticket'),
      TICKET_SQL.indexOf('FUNCTION uellix_stella_ops.inspect_operation_ticket'),
    )
    expect(abortBody.length).toBeGreaterThan(200)
    expect(abortBody).not.toContain('consume_stella_quota')
  })
})

/* ========================================================================== */
/* RUNTIME -> PRODUCT                                                         */
/* ========================================================================== */

describe('RUNTIME -> PRODUCT: el payload y el transporte del ticket', () => {
  it('StellaGroundedQueryRequest sigue teniendo EXACTAMENTE una propiedad', () => {
    const start = PRODUCT_CONTRACT_TS.indexOf('export interface StellaGroundedQueryRequest {')
    const body = PRODUCT_CONTRACT_TS.slice(start, PRODUCT_CONTRACT_TS.indexOf('}', start))
    const fields = body.split('\n').filter((l) => /^\s+readonly\s/.test(l))
    expect(fields).toHaveLength(1)
    expect(fields[0]).toContain('query: string')
  })

  it('el ticket viaja SEPARADO: es un segundo parámetro del runner, no un campo', () => {
    expect(PRODUCT_CONTRACT_TS).toContain('export type StellaGroundedQueryRunner = (\n  request: StellaGroundedQueryRequest,\n  ticket: StellaOperationTicket,\n) => Promise<StellaGroundedQueryResult>')
  })

  it('una consulta NUEVA pide ticket nuevo y un REINTENTO conserva el que tiene', () => {
    const code = codeLines(PANEL_TSX)
    // handleSubmit emite; handleRetry no.
    const submit = code.slice(code.indexOf('async function handleSubmit'), code.indexOf('async function handleRetry'))
    const retry = code.slice(code.indexOf('async function handleRetry'))
    expect(submit).toContain('await issueTicket()')
    expect(retry.slice(0, retry.indexOf('}'))).not.toContain('issueTicket')
    expect(retry).toContain('currentTicket.current')
  })

  it('la identidad de la operación NO se deriva del texto, del tiempo ni de un uuid por invocación', () => {
    const code = codeLines(PANEL_TSX)
    // El panel no compara consultas ni mide tiempo para decidir.
    expect(code).not.toMatch(/lastQuery\s*===\s*query/)
    expect(code).not.toMatch(/Date\.now\(\)/)
    expect(code).not.toMatch(/randomUUID|crypto\.randomUUID/)
  })

  it('el reintento post-complete tiene un estado explícito, y no aparenta éxito ni culpa a un proveedor', () => {
    const p = stellaErrorPresentation('ALREADY_COMPLETED_RESULT_UNAVAILABLE', '')
    expect(p.code).toBe('ALREADY_COMPLETED_RESULT_UNAVAILABLE')
    // No reintentable: un botón "Reintentar" aquí cobraría una segunda unidad.
    expect(p.retryable).toBe(false)
    // Dice que se contabilizó, y no menciona a ningún proveedor.
    expect(p.description).toMatch(/cuota/i)
    expect(p.description).not.toMatch(/IA|Gemini|proveedor|servicio de IA/i)
    // Y no afirma que la respuesta esté guardada.
    expect(p.description).toMatch(/no se conserva/i)
  })

  it('R9 permanece: el éxito sigue declarando qué lo produjo', () => {
    expect(PRODUCT_CONTRACT_TS).toContain('readonly answerStrategy: AnswerStrategyDescriptor')
    expect(ACTION_TS).toContain('answerStrategy: {')
  })
})

/* ========================================================================== */
/* RUNTIME -> RELEASE                                                         */
/* ========================================================================== */

describe('RUNTIME -> RELEASE: observabilidad', () => {
  it('los diez nombres del emisor son EXACTAMENTE los que RELEASE añadió a su contrato', () => {
    expect([...TICKET_LIFECYCLE_EVENT_NAMES].sort()).toEqual(
      STELLA_OBSERVABILITY_EVENT_NAMES.filter((n) => (TICKET_LIFECYCLE_EVENT_NAMES as readonly string[]).includes(n))
        .slice()
        .sort(),
    )
    // TRAIN 4.3 added the SIX reservation events (FASE 12). The count is asserted
    // rather than relaxed to a `toBeGreaterThan`: the equality of the two name
    // sets is what stops one side gaining an event the other never validates,
    // and a floor would let exactly that drift through.
    expect(TICKET_LIFECYCLE_EVENT_NAMES).toHaveLength(16)
    for (const name of TICKET_LIFECYCLE_EVENT_NAMES) {
      expect(STELLA_OBSERVABILITY_EVENT_NAMES).toContain(name)
    }
  })

  it('cada evento que el emisor puede producir valida LIMPIO contra el evaluador de RELEASE', () => {
    const scope = {
      organizationId: '11111111-1111-4111-8111-111111111111',
      projectId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
    }
    for (const name of TICKET_LIFECYCLE_EVENT_NAMES) {
      // Se rellena CADA campo permitido del evento, para que la validación no
      // pase por omisión.
      const fields: Record<string, string | number> = {}
      for (const field of TICKET_EVENT_ALLOWED_FIELDS[name]) {
        fields[field] = field === 'attempt' ? 2 : `${field}-0123456789abcdef`
      }
      const payload = ticketEventPayload(name, scope, fields, '2026-08-05T00:00:00.000Z')
      const verdict = validateObservabilityEvent(payload)
      expect(verdict.violations, `${name}: ${verdict.violations.join(' | ')}`).toEqual([])
    }
  })

  it('el tope de longitud del emisor es el de RELEASE', () => {
    expect(MAX_EVENT_FIELD_VALUE_LENGTH).toBe(200)
    const scope = { organizationId: 'o', projectId: 'p', requestId: 'r' }
    const payload = ticketEventPayload(
      'operation_ticket_issued',
      scope,
      { ticketId: 'x'.repeat(201) },
      '2026-08-05T00:00:00.000Z',
    )
    // Descartado, no truncado ni emitido: el campo simplemente no está.
    expect(payload.ticketId).toBeUndefined()
  })

  it('un campo fuera de la allowlist se DESCARTA y se cuenta, sin lanzar', () => {
    const scope = { organizationId: 'o', projectId: 'p', requestId: 'r' }
    const before = ticketTelemetryFailureCount()
    const payload = ticketEventPayload(
      'operation_ticket_issued',
      scope,
      { ticketId: 'abc', queryText: 'la pregunta del revisor' } as never,
      '2026-08-05T00:00:00.000Z',
    )
    expect(payload.queryText).toBeUndefined()
    expect(payload.ticketId).toBe('abc')
    // Visible: FASE 9 exige que un fallo de telemetría no cambie el estado pero
    // tampoco desaparezca.
    expect(ticketTelemetryFailureCount()).toBe(before + 1)
  })

  it('emitir nunca lanza, ni con un scope degenerado', () => {
    expect(() =>
      emitTicketEvent('replay_rejected', { organizationId: '', projectId: '', requestId: '' }, {
        ticketId: 'abc',
        reasonCode: 'query_mismatch',
      }),
    ).not.toThrow()
  })

  it('el modelo de referencia de RELEASE NO es importado por el runtime', () => {
    // El oráculo tiene que quedarse siendo un oráculo: si el runtime lo
    // importara, la implementación pasaría comparándose consigo misma.
    for (const source of [ACTION_TS, ADAPTER_TS, PANEL_TSX]) {
      expect(codeLines(source)).not.toMatch(/tests\/eval\/stella-release/)
    }
  })
})

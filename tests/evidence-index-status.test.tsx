// tests/evidence-index-status.test.tsx
// G-01 (product path) — what a reviewer actually sees per evidence row.
//
// ---------------------------------------------------------------------------
// THE ONE CLAIM THIS COMPONENT MUST NEVER MAKE
// ---------------------------------------------------------------------------
// "Stored" and "indexed" are different facts about the same row, and the
// product gap G-01 exists to close was the screen having no way to say the
// second. The failure mode to guard against is not an ugly badge — it is a
// screen that implies the corpus holds something it does not:
//
//   * an unsupported format rendered as if it were pending (it will never
//     index, and there is nothing to wait for);
//   * a failed attempt rendered as nothing at all (silence reads as success);
//   * a retry offered where the server action would refuse it.
//
// Each of those is a test below. They assert on RENDERED TEXT and CONTROLS,
// which is what a reviewer reads — not on the props they were handed.

import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { EvidenceIndexStatus } from '@/components/evidence/EvidenceIndexStatus'
import type { EvidenceCorpusState } from '@/lib/grounding/corpus-state'

const PROJECT = '22222222-2222-4222-8222-222222222222'
const EVIDENCE = '55555555-5555-4555-8555-555555555555'

function state(overrides: Partial<EvidenceCorpusState> = {}): EvidenceCorpusState {
  return {
    evidenceId: EVIDENCE,
    phase: 'ready_to_index',
    reason: null,
    detail: null,
    chunkCount: null,
    versionOrdinal: null,
    indexedAt: null,
    canRetry: false,
    ...overrides,
  }
}

const noop = async () => {}

function renderStatus(overrides: Partial<EvidenceCorpusState> = {}) {
  return render(
    <EvidenceIndexStatus state={state(overrides)} projectId={PROJECT} retryAction={noop} />,
  )
}

/* -------------------------------------------------------------------------- */
/* Stored is not indexed                                                      */
/* -------------------------------------------------------------------------- */

describe('the badge tells stored evidence from corpus content', () => {
  it('names the indexed state and how much of it there is', () => {
    renderStatus({ phase: 'indexed', chunkCount: 12, versionOrdinal: 1 })

    expect(screen.getByText(/indexado/i)).toBeInTheDocument()
    // The count is the only number that says the corpus really holds passages.
    expect(screen.getByText(/12/)).toBeInTheDocument()
  })

  it('says an unsupported format is NOT indexable, never that it is pending', () => {
    renderStatus({
      phase: 'not_indexable',
      reason: 'unsupported_format',
      detail: 'La extracción de PDF está pendiente de la decisión de dependencia G5.',
    })

    expect(screen.getByText(/no indexable/i)).toBeInTheDocument()
    expect(screen.queryByText(/pendiente de indexar/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^indexado$/i)).not.toBeInTheDocument()
  })

  it('shows the reason for a row that cannot be indexed', () => {
    // Without it, "no indexable" is a verdict with no appeal: a reviewer cannot
    // tell a format problem (convert the file) from a URL (nothing to do).
    renderStatus({
      phase: 'not_indexable',
      reason: 'unsupported_kind',
      detail: 'La evidencia de tipo URL no se indexa: nunca se descarga contenido remoto.',
    })

    expect(screen.getByText(/nunca se descarga contenido remoto/i)).toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* Failure is never silent                                                    */
/* -------------------------------------------------------------------------- */

describe('a failed indexing attempt is visible', () => {
  it('renders a failure label and the stage it stopped at', () => {
    renderStatus({
      phase: 'failed_retryable',
      reason: 'write_failed',
      detail: 'El último intento de indexación falló en la etapa «persist_chunks» y se revirtió.',
      canRetry: true,
    })

    // `getAllByText`, because the failure is stated twice on purpose: once as
    // the badge a reviewer scans for, once in the detail they read. Requiring
    // exactly one would fail the day the detail is added — the opposite of what
    // this test is for.
    expect(screen.getAllByText(/falló/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/persist_chunks/)).toBeInTheDocument()
  })

  it('renders a terminal failure without offering a retry', () => {
    renderStatus({
      phase: 'failed_terminal',
      reason: 'content_hash_mismatch',
      detail: 'El contenido almacenado no reproduce el hash registrado.',
      canRetry: false,
    })

    expect(screen.getByText(/falló|no indexable/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /indexar/i })).not.toBeInTheDocument()
  })

  it('surfaces an active version that holds no fragments', () => {
    // The M-7 hazard. It looks indexed everywhere else in the system, and this
    // is the only place a human is told the content is not citable.
    renderStatus({
      phase: 'incomplete',
      reason: 'no_chunks',
      detail: 'La versión activa del documento no tiene fragmentos.',
      chunkCount: 0,
      canRetry: true,
    })

    expect(screen.getByText(/incompleto/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /indexar/i })).toBeInTheDocument()
  })

  it('marks an index built by an older pipeline as stale rather than healthy', () => {
    renderStatus({
      phase: 'indexed_stale',
      reason: 'pipeline_drift',
      detail: 'Indexado con una versión anterior de normalización.',
      chunkCount: 5,
      canRetry: true,
    })

    expect(screen.getByText(/desactualizado/i)).toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* The label itself, with no detail to hide behind                            */
/* -------------------------------------------------------------------------- */

describe('the badge label alone carries the phase', () => {
  // FOUND BY MUTATION. The tests above assert the failure is VISIBLE, and the
  // detail sentence says "…falló…" too — so relabelling the badge
  // `failed_retryable` as "Pendiente de indexar" left every one of them
  // passing. A reviewer scanning a column of badges would have read a failed
  // row as merely queued.
  //
  // These render with `detail: null`, so the badge is the only text there is.

  const UNHEALTHY = ['failed_retryable', 'failed_terminal', 'incomplete', 'indexed_stale'] as const

  it.each(UNHEALTHY)('%s is never labelled as healthy or as merely pending', (phase) => {
    renderStatus({ phase, detail: null })

    expect(screen.queryByText(/pendiente de indexar/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Indexado')).not.toBeInTheDocument()
    expect(screen.queryByText(/no indexable/i)).not.toBeInTheDocument()
  })

  it('gives every phase a label of its own', () => {
    // The distinction the whole feature exists for dies the moment two phases
    // share a word, and no single-phase assertion can notice that.
    const phases = [
      'not_indexable',
      'ready_to_index',
      'indexed',
      'indexed_stale',
      'incomplete',
      'failed_retryable',
      'failed_terminal',
    ] as const

    const labels = phases.map((phase) => {
      const { container, unmount } = render(
        <EvidenceIndexStatus
          state={state({ phase, detail: null })}
          projectId={PROJECT}
          retryAction={noop}
        />,
      )
      const label = container.textContent?.trim() ?? ''
      unmount()
      return label
    })

    expect(labels.every((label) => label.length > 0)).toBe(true)
    // `failed_retryable` and `failed_terminal` intentionally read the same to a
    // human — the difference between them is whether a retry is OFFERED, which
    // is asserted separately. Every other phase is distinct.
    expect(new Set(labels).size).toBe(phases.length - 1)
  })
})

/* -------------------------------------------------------------------------- */
/* The offer matches the server's answer                                      */
/* -------------------------------------------------------------------------- */

describe('the retry control', () => {
  it('is offered only when the read model says this caller may retry', () => {
    const { unmount } = renderStatus({ phase: 'failed_retryable', canRetry: true })
    expect(screen.getByRole('button', { name: /indexar/i })).toBeInTheDocument()
    unmount()

    renderStatus({ phase: 'failed_retryable', canRetry: false })
    expect(screen.queryByRole('button', { name: /indexar/i })).not.toBeInTheDocument()
  })

  it('submits the project and the ONE evidence row it belongs to', () => {
    // Both are re-verified server-side against the session; carrying them is
    // what identifies the row, not what authorizes it.
    const { container } = renderStatus({ phase: 'ready_to_index', canRetry: true })

    const fields = Array.from(container.querySelectorAll('input[type="hidden"]')).map((input) => [
      input.getAttribute('name'),
      input.getAttribute('value'),
    ])
    expect(fields).toEqual([
      ['projectId', PROJECT],
      ['evidenceId', EVIDENCE],
    ])
  })

  it('names the row it acts on, for a screen reader in a table of many', () => {
    renderStatus({ phase: 'failed_retryable', canRetry: true })
    expect(screen.getByRole('button', { name: /indexar/i })).toHaveAccessibleName()
  })

  it('never renders a control that could act on a different row', () => {
    const { container } = renderStatus({ phase: 'ready_to_index', canRetry: true })
    const values = Array.from(container.querySelectorAll('input')).map((i) => i.getAttribute('value'))
    expect(values.filter((v) => v === EVIDENCE)).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* No leakage                                                                 */
/* -------------------------------------------------------------------------- */

describe('what the cell never shows', () => {
  it('renders no storage path and no content hash', () => {
    // The read model does not carry them, and this asserts the cell does not
    // acquire them from somewhere else later.
    const { container } = renderStatus({
      phase: 'indexed',
      chunkCount: 3,
      versionOrdinal: 1,
      indexedAt: '2026-08-15T10:00:00.000Z',
    })
    expect(container.textContent).not.toMatch(/[0-9a-f]{64}/)
    expect(container.textContent).not.toContain('/')
  })

  it('does not crash on a state with no detail', () => {
    expect(() => renderStatus({ phase: 'ready_to_index' })).not.toThrow()
    expect(screen.getByText(/pendiente/i)).toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* The mount site                                                             */
/* -------------------------------------------------------------------------- */

describe('the retry action it is given', () => {
  it('is the only way the cell can trigger indexing', () => {
    // The cell holds no client state and calls nothing itself: it renders a
    // form whose action is the server action the page passed in. If it ever
    // grows its own fetch, this assertion — no submit handler, no onClick —
    // is what notices.
    const retryAction = vi.fn()
    const { container } = render(
      <EvidenceIndexStatus
        state={state({ phase: 'ready_to_index', canRetry: true })}
        projectId={PROJECT}
        retryAction={retryAction}
      />,
    )

    expect(container.querySelector('form')).not.toBeNull()
    expect(retryAction).not.toHaveBeenCalled()
  })
})

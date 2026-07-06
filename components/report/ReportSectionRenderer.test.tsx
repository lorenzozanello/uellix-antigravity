import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReportSectionRenderer } from './ReportSectionRenderer'
import type { FunderBreakdownRow } from '@/lib/pipeline/sroi-funders'

describe('ReportSectionRenderer', () => {
  const mockSnapshotWithFunders = {
    fundersBreakdown: [
      {
        funderId: 'funder-1',
        funderName: 'Foundation A',
        funderType: 'foundation',
        investmentUsd: '500000.0000',
        attributedNsvUsd: '1600000.0000',
        sroiRatio: '3.200000',
      },
      {
        funderId: 'funder-2',
        funderName: 'Private B',
        funderType: 'private',
        investmentUsd: '200000.0000',
        attributedNsvUsd: '420000.0000',
        sroiRatio: '2.100000',
      },
    ] as FunderBreakdownRow[],
    unattributedNsvUsd: '50000.0000',
    netSocialValue: '2070000.0000',
  }

  describe('Section routing', () => {
    it('renders FunderBreakdownSection for funder_breakdown type', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    it('renders text content for non-funder_breakdown sections', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'executive_summary',
        title: 'Resumen ejecutivo',
        content: 'This is summary text.',
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.getByText('This is summary text.')).toBeInTheDocument()
    })
  })

  describe('funder_breakdown section in locked mode', () => {
    it('renders table without edit form when locked', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: 'Some notes',
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={true}
        />
      )

      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    it('extracts fundersBreakdown from snapshotJson', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={true}
        />
      )

      expect(screen.getByText('Foundation A')).toBeInTheDocument()
      expect(screen.getByText('Private B')).toBeInTheDocument()
    })

    it('extracts unattributedNsvUsd from snapshotJson', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={true}
        />
      )

      expect(screen.getByText(/Valor Social Sin Atribuir/i)).toBeInTheDocument()
    })
  })

  describe('funder_breakdown section in draft mode', () => {
    it('renders table and edit form when not locked', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: 'Notas metodológicas aquí',
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.getByRole('table')).toBeInTheDocument()
      expect(screen.getByText(/Notas metodológicas/i)).toBeInTheDocument()
    })

    it('shows section content in notes when provided', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: 'The Foundation allocated funds across all outcomes.',
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.getByText('The Foundation allocated funds across all outcomes.')).toBeInTheDocument()
    })

    it('does not show notes when content is empty', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.queryByText(/Notas metodológicas/i)).not.toBeInTheDocument()
    })
  })

  describe('Handling missing snapshotJson', () => {
    it('handles null snapshotJson for funder_breakdown', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={null}
          currency="USD"
          isLocked={true}
        />
      )

      // Should show empty state
      expect(screen.getByText(/No hay datos de desglose/i)).toBeInTheDocument()
    })

    it('handles undefined snapshotJson', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={undefined}
          currency="USD"
          isLocked={true}
        />
      )

      expect(screen.getByText(/No hay datos de desglose/i)).toBeInTheDocument()
    })

    it('handles snapshotJson without fundersBreakdown property', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      const snapshotWithoutFunders = {
        netSocialValue: '2070000.0000',
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={snapshotWithoutFunders}
          currency="USD"
          isLocked={true}
        />
      )

      expect(screen.getByText(/No hay datos de desglose/i)).toBeInTheDocument()
    })
  })

  describe('Plain text sections', () => {
    it('renders content as plain text for non-table sections', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'limitations',
        title: 'Limitaciones',
        content: 'Data quality limitations:\n- Limited sample size\n- Unmeasured outcomes',
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.getByText(/Data quality limitations/)).toBeInTheDocument()
      expect(screen.getByText(/Limited sample size/)).toBeInTheDocument()
    })

    it('shows empty state for section without content', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'review_notes',
        title: 'Notas de revisión',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.getByText(/No hay contenido registrado/i)).toBeInTheDocument()
    })

    it('preserves whitespace in plain text content', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'proxy_methodology',
        title: 'Metodología de proxies',
        content: 'Proxy values:\n  - Outcome A: $500\n  - Outcome B: $1,200',
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="USD"
          isLocked={false}
        />
      )

      expect(screen.getByText(/Proxy values:/)).toBeInTheDocument()
    })
  })

  describe('Currency handling', () => {
    it('passes currency to FunderBreakdownSection', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          currency="EUR"
          isLocked={true}
        />
      )

      // Verify currency is used (would show EUR instead of USD)
      const currencyCells = screen.queryAllByText(/EUR/)
      expect(currencyCells.length).toBeGreaterThan(0)
    })

    it('defaults to USD when currency not provided', () => {
      const section = {
        id: 'sec-1',
        sectionType: 'funder_breakdown',
        title: 'Desglose financiero por financiador',
        content: null,
      }

      render(
        <ReportSectionRenderer
          section={section}
          snapshotJson={mockSnapshotWithFunders}
          isLocked={true}
        />
      )

      const currencyCells = screen.queryAllByText(/USD/)
      expect(currencyCells.length).toBeGreaterThan(0)
    })
  })
})

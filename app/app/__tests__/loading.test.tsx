// app/app/__tests__/loading.test.tsx
// RE-U1 U1-F06: zero loading.tsx existed anywhere in the app tree, and the
// existing LoadingState primitive had zero consumers, so every async
// navigation under the authenticated workspace silently retained the
// previous page. app/app/loading.tsx is the segment root for the whole
// workspace (dashboard, projects, portfolios, trust-center,
// organization/**), so one boundary here covers all of it.

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import AppLoading from '../loading'

describe('app/app/loading.tsx', () => {
  it('reuses the existing LoadingState primitive rather than a new one', () => {
    render(<AppLoading />)
    expect(screen.getByText('Cargando...')).toBeInTheDocument()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const values = vi.hoisted(() => vi.fn())

vi.mock('@/db/client', () => ({
  db: {
    insert: vi.fn(() => ({ values })),
  },
}))

import { POST } from '@/app/api/marketing/lead/route'

describe('POST /api/marketing/lead', () => {
  beforeEach(() => {
    values.mockReset()
  })

  it('rejects invalid public input with a generic client error', async () => {
    const response = await POST(new Request('http://localhost/api/marketing/lead', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ success: false, error: 'Invalid request' })
    expect(values).not.toHaveBeenCalled()
  })

  // After the runtime cutover this endpoint refuses BEFORE attempting the
  // insert: marketing_leads' INSERT policies are scoped TO anon / TO
  // authenticated, and uellix_app is a member of neither, so the write can
  // never succeed. A permanently-failing endpoint answering 500 on every
  // request buries itself in noise — see the header of the route.
  it('refuses with 503 and never reaches the database', async () => {
    const response = await POST(new Request('http://localhost/api/marketing/lead', {
      method: 'POST',
      body: JSON.stringify({ email: 'pilot@example.com' }),
    }))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({ success: false, error: 'Lead capture is temporarily unavailable' })
    expect(values).not.toHaveBeenCalled()
  })

  it('refuses only AFTER validation, so a malformed body still gets its 400', async () => {
    const response = await POST(new Request('http://localhost/api/marketing/lead', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    }))

    expect(response.status).toBe(400)
  })
})

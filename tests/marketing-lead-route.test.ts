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

  it('does not expose database errors', async () => {
    values.mockRejectedValue(new Error('sensitive database connection detail'))

    const response = await POST(new Request('http://localhost/api/marketing/lead', {
      method: 'POST',
      body: JSON.stringify({ email: 'pilot@example.com' }),
    }))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ success: false, error: 'Unable to save lead' })
    expect(JSON.stringify(body)).not.toContain('sensitive database connection detail')
  })
})

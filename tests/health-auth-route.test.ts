import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUser = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser },
  }),
}))

import { GET } from '@/app/api/health/auth/route'

describe('GET /api/health/auth', () => {
  beforeEach(() => {
    getUser.mockReset()
  })

  it('reports connectivity without exposing user information', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'private-user-id' } }, error: null })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'ok', authenticated: true })
    expect(JSON.stringify(body)).not.toContain('private-user-id')
    expect(body).not.toHaveProperty('error')
  })

  it('does not expose an upstream authentication error', async () => {
    getUser.mockResolvedValue({
      data: { user: null },
      error: new Error('sensitive upstream detail'),
    })

    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toMatchObject({
      status: 'degraded',
      authenticated: false,
      message: 'Authentication service unavailable',
    })
    expect(JSON.stringify(body)).not.toContain('sensitive upstream detail')
  })
})

// lib/email/resend-client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock }
  },
}))

import { ResendEmailProvider } from './resend-client'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ResendEmailProvider', () => {
  it('is not ready without an API key', () => {
    const provider = new ResendEmailProvider('')
    expect(provider.isReady()).toBe(false)
  })

  it('no-ops and returns null when no API key is configured', async () => {
    const provider = new ResendEmailProvider('')
    const result = await provider.send({ to: 'a@b.com', subject: 'Hi', html: '<p>Hi</p>' })
    expect(result).toBeNull()
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends via the Resend SDK when an API key is configured', async () => {
    sendMock.mockResolvedValue({ data: { id: 'email-123' }, error: null })
    const provider = new ResendEmailProvider('re_test_key')
    expect(provider.isReady()).toBe(true)

    const result = await provider.send({ to: 'a@b.com', subject: 'Hi', html: '<p>Hi</p>' })
    expect(result).toEqual({ id: 'email-123' })
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@b.com', subject: 'Hi', html: '<p>Hi</p>' })
    )
  })

  it('returns null and does not throw when Resend returns an error', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'invalid domain', name: 'validation_error' } })
    const provider = new ResendEmailProvider('re_test_key')

    const result = await provider.send({ to: 'a@b.com', subject: 'Hi', html: '<p>Hi</p>' })
    expect(result).toBeNull()
  })
})

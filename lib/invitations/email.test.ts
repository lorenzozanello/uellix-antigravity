// lib/invitations/email.test.ts
import { describe, it, expect } from 'vitest'
import { sendInvitationEmail, buildInvitationAcceptUrl } from './email'
import type { EmailProvider, EmailMessage } from '@/lib/email/provider'

class RecordingProvider implements EmailProvider {
  public sent: EmailMessage[] = []
  async send(message: EmailMessage) {
    this.sent.push(message)
    return { id: 'mock-id' }
  }
}

class ThrowingProvider implements EmailProvider {
  async send(): Promise<never> {
    throw new Error('network down')
  }
}

describe('buildInvitationAcceptUrl', () => {
  it('embeds the raw token as a query param', () => {
    const url = buildInvitationAcceptUrl('abc123')
    expect(url).toContain('/invite/accept?token=abc123')
  })
})

describe('sendInvitationEmail', () => {
  it('sends an email with the accept link and role label to the injected provider', async () => {
    const provider = new RecordingProvider()
    await sendInvitationEmail(
      { email: 'invitee@user.com', organizationName: 'Acme', role: 'analyst', rawToken: 'tok123' },
      provider
    )

    expect(provider.sent).toHaveLength(1)
    expect(provider.sent[0].to).toBe('invitee@user.com')
    expect(provider.sent[0].subject).toContain('Acme');
    expect(provider.sent[0].html).toContain('tok123');
    expect(provider.sent[0].html).toContain('Analista'); // ROLE_LABELS['analyst']
  });

  it('does not throw when the provider fails', async () => {
    const provider = new ThrowingProvider();
    await expect(
      sendInvitationEmail(
        { email: 'invitee@user.com', organizationName: 'Acme', role: 'viewer', rawToken: 'tok123' },
        provider
      )
    ).resolves.toBeUndefined();
  });
});

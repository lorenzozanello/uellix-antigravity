import { describe, expect, it } from 'vitest'
import { getInvitationEmailTemplate } from './invitation'

describe('getInvitationEmailTemplate', () => {
  it('escapes user-controlled names and link attributes', () => {
    const html = getInvitationEmailTemplate({
      inviterName: '<script>alert(1)</script>',
      organizationName: 'Org & Partners',
      roleName: 'Analyst "Lead"',
      joinLink: 'https://uellix.com/invite?token=a&next="bad"',
    })

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('Org &amp; Partners')
    expect(html).toContain('Analyst &quot;Lead&quot;')
    expect(html).toContain('token=a&amp;next=&quot;bad&quot;')
  })
})

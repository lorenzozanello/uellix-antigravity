// lib/pipeline/build-identity.test.ts
import { describe, it, expect } from 'vitest'
import { resolveBuildIdentity } from './build-identity'

describe('resolveBuildIdentity', () => {
  it('prefers VERCEL_GIT_COMMIT_SHA when both are set', () => {
    expect(resolveBuildIdentity({ VERCEL_GIT_COMMIT_SHA: 'abc123', BUILD_IDENTITY: 'manual' })).toBe('abc123')
  })

  it('falls back to BUILD_IDENTITY when VERCEL_GIT_COMMIT_SHA is absent', () => {
    expect(resolveBuildIdentity({ BUILD_IDENTITY: 'manual-override' })).toBe('manual-override')
  })

  it('returns null — never a fabricated value — when neither is set', () => {
    expect(resolveBuildIdentity({})).toBeNull()
  })

  it('treats an empty string the same as absent', () => {
    expect(resolveBuildIdentity({ VERCEL_GIT_COMMIT_SHA: '', BUILD_IDENTITY: '' })).toBeNull()
  })
})

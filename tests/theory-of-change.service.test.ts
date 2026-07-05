// tests/theory-of-change.service.test.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { isValidLinkTransition } from '@/lib/pipeline/theory-of-change';

describe('isValidLinkTransition', () => {
  it('allows activity -> output', () => {
    expect(isValidLinkTransition('activity', 'output')).toBe(true);
  });
  it('allows output -> outcome', () => {
    expect(isValidLinkTransition('output', 'outcome')).toBe(true);
  });
  it('rejects reverse order (output -> activity)', () => {
    expect(isValidLinkTransition('output', 'activity')).toBe(false);
  });
  it('rejects same-type links', () => {
    expect(isValidLinkTransition('activity', 'activity')).toBe(false);
    expect(isValidLinkTransition('output', 'output')).toBe(false);
    expect(isValidLinkTransition('outcome', 'outcome')).toBe(false);
  });
  it('rejects a direct activity -> outcome jump', () => {
    expect(isValidLinkTransition('activity', 'outcome')).toBe(false);
  });
});

// components/stella/__tests__/grounded-query.test.ts
// PRODUCT TRAIN 3 — grounded-query.ts is a pure contract type module.
// `grounding-adapter.test.ts`'s "holds for EVERY Stella component" scan
// already enforces zero runtime `@/lib/grounding` imports across all of
// `components/stella/**`, this file included — no need to duplicate that
// scan here. What is specific to this file is the one runtime export.

import { describe, expect, it } from 'vitest'
import { isStellaGroundedQuerySuccess } from '../grounded-query'
import type { StellaGroundedQueryFailure, StellaGroundedQuerySuccess } from '../grounded-query'
import { groundedAnswerView } from './grounded-fixtures'

describe('isStellaGroundedQuerySuccess', () => {
  it('narrows a successful result to StellaGroundedQuerySuccess', () => {
    const result: StellaGroundedQuerySuccess = {
      status: 'ok',
      answerId: 'answer-1',
      answer: groundedAnswerView(),
    }
    expect(isStellaGroundedQuerySuccess(result)).toBe(true)
  })

  it('rejects every failure code', () => {
    const codes: StellaGroundedQueryFailure['code'][] = [
      'DISABLED',
      'UNAUTHORIZED',
      'QUOTA_EXCEEDED',
      'GEMINI_ERROR',
      'TIMEOUT',
      'UNKNOWN_ERROR',
    ]
    for (const code of codes) {
      const result: StellaGroundedQueryFailure = { status: 'error', code, message: 'x' }
      expect(isStellaGroundedQuerySuccess(result)).toBe(false)
    }
  })
})

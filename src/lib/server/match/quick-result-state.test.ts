import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getQuickResultState,
  QUICK_MATCH_VOID_DESCRIPTION,
} from './quick-result-state'

test('quick result state recognizes both current and legacy invalidation markers', () => {
  assert.equal(
    getQuickResultState({
      confirmed: false,
      score: { text: '3:1', invalidReason: 'rejected' },
      match: { description: '由快速比赛功能创建' },
    }),
    'invalidated',
  )
  assert.equal(
    getQuickResultState({
      confirmed: false,
      score: { text: '3:1' },
      match: { description: QUICK_MATCH_VOID_DESCRIPTION },
    }),
    'invalidated',
  )
})

test('confirmed state remains authoritative for legacy inconsistent rows', () => {
  assert.equal(
    getQuickResultState({
      confirmed: true,
      score: { invalidReason: 'rejected' },
      match: { description: QUICK_MATCH_VOID_DESCRIPTION },
    }),
    'confirmed',
  )
})

test('an untouched quick result is pending', () => {
  assert.equal(
    getQuickResultState({
      confirmed: false,
      score: { text: '3:1' },
      match: { description: '由快速比赛功能创建' },
    }),
    'pending',
  )
})

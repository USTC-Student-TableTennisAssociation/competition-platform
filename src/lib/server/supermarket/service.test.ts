import assert from 'node:assert/strict'
import test from 'node:test'

import { SupermarketError, isSupermarketError, supermarketErrorMessage } from './errors'

test('insufficient points tells the member exactly how many they are short', () => {
  const error = new SupermarketError('INSUFFICIENT_POINTS', 'not enough', {
    available: 30,
    required: 80,
    shortfall: 50,
  })

  assert.equal(supermarketErrorMessage(error), '积分不足，还差 50 分。')
})

test('a missing shortfall detail still produces a readable message', () => {
  const error = new SupermarketError('INSUFFICIENT_POINTS', 'not enough')
  assert.equal(supermarketErrorMessage(error), '积分不足，还差 0 分。')
})

test('every declared error code maps to a distinct user-facing message', () => {
  const codes = [
    'NO_OPEN_PERIOD',
    'PERIOD_ALREADY_OPEN',
    'PERIOD_NOT_OPEN',
    'PERIOD_CLOSED',
    'PRIZE_NOT_FOUND',
    'PRIZE_NOT_AVAILABLE',
    'PRIZE_SOLD_OUT',
    'REDEMPTION_NOT_FOUND',
    'REDEMPTION_ALREADY_RESOLVED',
    'INVALID_AMOUNT',
    'INVALID_REASON',
    'INVALID_PRIZE',
    'USER_NOT_FOUND',
    'SETTLEMENT_STATE_CONFLICT',
  ] as const

  for (const code of codes) {
    const message = supermarketErrorMessage(new SupermarketError(code, 'x'))
    assert.notEqual(message, '操作失败，请稍后重试。', `${code} must be mapped`)
    assert.ok(message.length > 0)
  }
})

test('unknown failures fall back to a generic message and are not leaked', () => {
  assert.equal(supermarketErrorMessage(new Error('raw sql detail')), '操作失败，请稍后重试。')
  assert.equal(supermarketErrorMessage(null), '操作失败，请稍后重试。')
  assert.equal(isSupermarketError(new Error('nope')), false)
  assert.equal(isSupermarketError(new SupermarketError('USER_NOT_FOUND', 'x')), true)
})

test('error details are frozen so callers cannot rewrite them', () => {
  const error = new SupermarketError('INSUFFICIENT_POINTS', 'x', { shortfall: 5 })
  assert.equal(Object.isFrozen(error.details), true)
})

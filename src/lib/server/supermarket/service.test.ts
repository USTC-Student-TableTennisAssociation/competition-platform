import assert from 'node:assert/strict'
import test from 'node:test'

import { SupermarketError, isSupermarketError, supermarketErrorMessage } from './errors'
import { isLocalSupermarketDatabase, isPrizeImageUrl, prizeImageExtension } from './image-policy'

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

test('a redemption limit explains the per-period quota to the member', () => {
  const error = new SupermarketError('REDEMPTION_LIMIT_REACHED', 'limit reached', {
    limit: 1,
    redeemedCount: 1,
  })
  assert.equal(supermarketErrorMessage(error), '本期该奖品每人限兑 1 件，你已达到上限。')
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
    'REDEMPTION_LIMIT_REACHED',
    'REDEMPTION_NOT_FOUND',
    'REDEMPTION_ALREADY_RESOLVED',
    'INVALID_AMOUNT',
    'INVALID_REASON',
    'INVALID_PRIZE',
    'INVALID_PRIZE_IMAGE',
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

test('prize image sources reject active URLs, credentials, and traversal', () => {
  for (const url of ['/supermarket/towel-design.png','/uploads/supermarket/abc-123.webp','https://res.cloudinary.com/demo/image/upload/v1/prize.jpg']) {
    assert.equal(isPrizeImageUrl(url), true, url)
  }
  for (const url of ['javascript:alert(1)','data:image/svg+xml,anything','//evil.test/x.png','/supermarket/../secret.png','https://evil.test/image/upload/photo.png','https://evil.test@res.cloudinary.com/image/upload/a.jpg','https://res.cloudinary.com:8443/image/upload/a.jpg','']) {
    assert.equal(isPrizeImageUrl(url), false, url)
  }
})

test('image uploads require a supported MIME and matching magic bytes', () => {
  const png = new Uint8Array([137,80,78,71,13,10,26,10])
  assert.equal(prizeImageExtension('image/png',png),'png')
  assert.equal(prizeImageExtension('image/jpeg',png),null)
  assert.equal(prizeImageExtension('image/jpeg',new Uint8Array([255,216,255])),'jpg')
  assert.equal(prizeImageExtension('image/webp',new TextEncoder().encode('RIFFxxxxWEBP')),'webp')
  assert.equal(prizeImageExtension('image/svg+xml',new TextEncoder().encode('<svg/>')),null)
  assert.equal(prizeImageExtension('image/png',new Uint8Array([137])),null)
})

test('local-only preview requires the named loopback PostgreSQL database', () => {
  assert.equal(isLocalSupermarketDatabase('postgresql://local@127.0.0.1:55432/ustctta_v2'),true)
  for (const value of ['postgresql://remote.test/ustctta_v2','postgresql://localhost/production','postgresql://localhost/ustctta_v2_test','https://localhost/ustctta_v2','invalid']) {
    assert.equal(isLocalSupermarketDatabase(value),false,value)
  }
})

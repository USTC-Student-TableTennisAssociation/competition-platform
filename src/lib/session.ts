import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'ustc_tta_session'
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30

type SessionPayload = {
  userId: string
  expiresAtMs: number
  authStamp: string
}

function getSessionSecret() {
  return process.env.AUTH_SECRET ?? null
}

function signPayload(payload: string) {
  const secret = getSessionSecret()
  if (!secret) return null
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export function createSessionAuthStamp(userId: string, hashedPassword: string | null | undefined) {
  const secret = getSessionSecret()
  if (!secret || !hashedPassword) return null
  return createHmac('sha256', secret)
    .update(`${userId}.${hashedPassword}`)
    .digest('hex')
}

export function shouldUseSecureCookies() {
  return process.env.NODE_ENV === 'production'
}

export function createSessionToken(userId: string, hashedPassword: string | null | undefined) {
  const expiresAtMs = Date.now() + SESSION_TTL_SECONDS * 1000
  const nonce = randomBytes(16).toString('hex')
  const authStamp = createSessionAuthStamp(userId, hashedPassword)
  if (!authStamp) return null
  const payload = `${userId}.${expiresAtMs}.${nonce}.${authStamp}`
  const signature = signPayload(payload)
  if (!signature) return null
  return `${payload}.${signature}`
}

export function verifySessionToken(rawValue: string): SessionPayload | null {
  if (!getSessionSecret()) return null

  const [userId, expiresAtRaw, nonce, authStamp, signature] = rawValue.split('.')
  if (!userId || !expiresAtRaw || !nonce || !authStamp || !signature) return null
  if (!/^[0-9a-f]{64}$/i.test(authStamp)) return null

  const expiresAtMs = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) return null

  const payload = `${userId}.${expiresAtMs}.${nonce}.${authStamp}`
  const expectedSignature = signPayload(payload)
  if (!expectedSignature) return null
  const actualBuffer = Buffer.from(signature, 'hex')
  const expectedBuffer = Buffer.from(expectedSignature, 'hex')

  if (actualBuffer.length !== expectedBuffer.length) return null
  if (!timingSafeEqual(actualBuffer, expectedBuffer)) return null

  return {
    userId,
    expiresAtMs,
    authStamp,
  }
}

export function safeEqualHex(left: string, right: string) {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

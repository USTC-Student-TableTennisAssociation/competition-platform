import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const PASSWORD_SCHEME = 's2'
const SCRYPT_N = 1 << 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 64
const SALT_BYTES = 32
const MAXMEM = 128 * 1024 * 1024

function derive(password: string, saltHex: string, n: number, r: number, p: number) {
  return scryptSync(password, saltHex, KEY_LENGTH, {
    N: n,
    r,
    p,
    maxmem: MAXMEM,
  })
}

function verifyModern(password: string, storedHash: string) {
  const [scheme, nRaw, rRaw, pRaw, saltHex, hashHex] = storedHash.split('$')
  if (scheme !== PASSWORD_SCHEME || !nRaw || !rRaw || !pRaw || !saltHex || !hashHex) {
    return false
  }

  const n = Number(nRaw)
  const r = Number(rRaw)
  const p = Number(pRaw)
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false

  const expected = Buffer.from(hashHex, 'hex')
  const actual = derive(password, saltHex, n, r, p)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

function verifyLegacy(password: string, storedHash: string) {
  const [salt, hash] = storedHash.split(':')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = scryptSync(password, salt, KEY_LENGTH)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

export function hashPassword(password: string) {
  const saltHex = randomBytes(SALT_BYTES).toString('hex')
  const hashHex = derive(password, saltHex, SCRYPT_N, SCRYPT_R, SCRYPT_P).toString('hex')
  return `${PASSWORD_SCHEME}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltHex}$${hashHex}`
}

export function verifyPassword(password: string, storedHash: string) {
  const isModern = storedHash.startsWith(`${PASSWORD_SCHEME}$`)
  if (isModern) {
    return { ok: verifyModern(password, storedHash), needsRehash: false }
  }

  return { ok: verifyLegacy(password, storedHash), needsRehash: true }
}
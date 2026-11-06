import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'

export type RegistrationIdentityInput = { realName: string; idNumber: string; consent: boolean }
type IdentityDetails = Pick<RegistrationIdentityInput, 'realName' | 'idNumber'>
type Scope = { matchId: string; userId: string }
export class RegistrationIdentityError extends Error {}

function encryptionKey() {
  const encoded = process.env.REGISTRATION_IDENTITY_KEY
  const key = Buffer.from(encoded ?? '', 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new RegistrationIdentityError('本场比赛的身份信息收集尚未配置，请联系管理员。')
  }
  return key
}
export function assertRegistrationIdentityConfigured() { encryptionKey() }

const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
export function normalizeRegistrationIdentity(input?: RegistrationIdentityInput): IdentityDetails {
  if (input?.consent !== true) throw new RegistrationIdentityError('请确认同意为本场比赛提交本人的身份信息。')
  const realName = typeof input.realName === 'string' ? input.realName.trim() : ''
  if (realName.length > 80 || !/^[\p{L}][\p{L}\p{M}·・ ’'.-]*$/u.test(realName)) {
    throw new RegistrationIdentityError('请填写证件上的真实姓名。')
  }
  const idNumber = typeof input.idNumber === 'string' ? input.idNumber.trim().toUpperCase() : ''
  const invalid = () => new RegistrationIdentityError('身份证号格式不正确，请核对出生日期、末位校验码和全部 18 位号码。')
  if (!/^[1-9]\d{16}[\dX]$/.test(idNumber)) throw invalid()
  const birthday = idNumber.slice(6,14)
  const date = new Date(Date.UTC(+birthday.slice(0,4), +birthday.slice(4,6)-1, +birthday.slice(6,8)))
  if (+birthday.slice(0,4) < 1800 || date.toISOString().slice(0,10).replaceAll('-', '') !== birthday ||
      birthday > new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10).replaceAll('-', '') ||
      idNumber.slice(14,17) === '000') throw invalid()
  const checksum = weights.reduce((sum, weight, index) => sum + weight * Number(idNumber[index]), 0)
  if ('10X98765432'[checksum % 11] !== idNumber[17]) throw invalid()
  return { realName, idNumber }
}

// Bind the ciphertext to its purpose and owner; swapping two rows must fail authentication.
function aad(scope: Scope) {
  return Buffer.from(JSON.stringify(['match-registration-identity', 1, scope.matchId, scope.userId]), 'utf8')
}
export function encryptRegistrationIdentity(scope: Scope, input: RegistrationIdentityInput | undefined) {
  const details = normalizeRegistrationIdentity(input)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce)
  cipher.setAAD(aad(scope))
  const payload = Buffer.concat([cipher.update(JSON.stringify(details), 'utf8'), cipher.final()])
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), payload.toString('base64url')].join('.')
}
export function decryptRegistrationIdentity(scope: Scope, encrypted: string): IdentityDetails {
  const key = encryptionKey()
  try {
    const [version, nonce, tag, payload, extra] = encrypted.split('.')
    if (version !== 'v1' || extra !== undefined || Buffer.from(nonce,'base64url').length !== 12 || Buffer.from(tag,'base64url').length !== 16) throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce,'base64url'))
    decipher.setAAD(aad(scope))
    decipher.setAuthTag(Buffer.from(tag,'base64url'))
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(payload,'base64url')), decipher.final()]).toString('utf8'))
  } catch {
    throw new RegistrationIdentityError('身份信息读取失败，请联系管理员检查加密配置。')
  }
}

export async function saveRegistrationIdentity(
  tx: Pick<Prisma.TransactionClient, 'match' | 'matchRegistrationIdentity'>,
  { matchId, userId, identity }: Scope & { identity?: RegistrationIdentityInput },
) {
  const match = await tx.match.findUniqueOrThrow({ where: { id: matchId }, select: { collectIdentityInfo: true } })
  if (!match.collectIdentityInfo) return
  const encryptedData = encryptRegistrationIdentity({matchId, userId}, identity)
  const data = { encryptedData, consentedAt: new Date() }
  await tx.matchRegistrationIdentity.upsert({
    where: { matchId_userId: { matchId, userId } },
    create: { matchId, userId, ...data }, update: data, select: { matchId: true },
  })
}

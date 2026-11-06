import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { decryptRegistrationIdentity, encryptRegistrationIdentity, normalizeRegistrationIdentity, RegistrationIdentityError, saveRegistrationIdentity } from '../../../lib/server/registration-identity'

const scope = { matchId: 'synthetic-match', userId: 'synthetic-user' }
const sample = { realName: ' 测试甲 ', idNumber: '990000199003010045', consent: true }
test('identity input requires explicit consent, a name, valid birthday and check digit', () => {
  assert.deepEqual(normalizeRegistrationIdentity(sample), { realName: '测试甲', idNumber: sample.idNumber })
  for (const input of [undefined, {...sample,consent:false}, {...sample,realName:''}, {...sample,realName:'1'}, {...sample,idNumber:'990000199002310011'}, {...sample,idNumber:'990000199003010046'}]) {
    assert.throws(() => normalizeRegistrationIdentity(input), e => e instanceof RegistrationIdentityError && !e.message.includes(sample.idNumber))
  }
})
test('stored identity authenticates ciphertext, match and user; missing keys fail closed', () => {
  const original = process.env.REGISTRATION_IDENTITY_KEY
  try {
    process.env.REGISTRATION_IDENTITY_KEY = randomBytes(32).toString('base64')
    const encrypted = encryptRegistrationIdentity(scope, sample)
    assert.ok(!encrypted.includes('测试甲') && !encrypted.includes(sample.idNumber))
    assert.notEqual(encrypted, encryptRegistrationIdentity(scope, sample))
    assert.deepEqual(decryptRegistrationIdentity(scope, encrypted), {realName:'测试甲',idNumber:sample.idNumber})
    assert.throws(() => decryptRegistrationIdentity({...scope,userId:'other'}, encrypted), RegistrationIdentityError)
    assert.throws(() => decryptRegistrationIdentity({...scope,matchId:'other'}, encrypted), RegistrationIdentityError)
    const parts = encrypted.split('.')
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1)
    assert.throws(() => decryptRegistrationIdentity(scope, parts.join('.')), RegistrationIdentityError)
    delete process.env.REGISTRATION_IDENTITY_KEY
    assert.throws(() => encryptRegistrationIdentity(scope,sample), RegistrationIdentityError)
  } finally { if(original===undefined) delete process.env.REGISTRATION_IDENTITY_KEY; else process.env.REGISTRATION_IDENTITY_KEY=original }
})
test('even unsolicited identity fields for a disabled match are discarded before validation or storage', async () => {
  const tx = { match: { findUniqueOrThrow: async () => ({collectIdentityInfo:false}) } } as unknown as Parameters<typeof saveRegistrationIdentity>[0]
  await saveRegistrationIdentity(tx, {...scope,identity:{realName:'',idNumber:'',consent:false}})
})

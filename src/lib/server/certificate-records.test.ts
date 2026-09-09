import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ParticipationCertificate,
  PrismaClient,
  UserIdentity,
} from '@prisma/client'

import {
  createUserIdentityOrReadConcurrent,
  findOrCreateParticipationCertificate,
} from './certificate-records'

type CertificateRecordDatabase = Pick<
  PrismaClient,
  'participationCertificate' | 'userIdentity'
>

const identity: UserIdentity = {
  id: 'identity-1',
  userId: 'user-1',
  nameHash: 'winning-name-hash',
  studentIdHash: 'winning-student-hash',
  createdAt: new Date('2026-09-04T00:00:00.000Z'),
}

const certificate: ParticipationCertificate = {
  id: 'certificate-1',
  matchId: 'match-1',
  userId: 'user-1',
  certificateNo: 'PPC-20260904-ABCDEF',
  createdAt: new Date('2026-09-04T00:00:00.000Z'),
}

function uniqueConstraintError() {
  return Object.assign(new Error('unique constraint'), { code: 'P2002' })
}

test('identity creation returns the row committed by a concurrent request', async () => {
  let reads = 0
  const db = {
    userIdentity: {
      create: async () => {
        throw uniqueConstraintError()
      },
      findUnique: async () => {
        reads += 1
        return identity
      },
    },
  } as unknown as CertificateRecordDatabase

  const result = await createUserIdentityOrReadConcurrent(db, {
    userId: 'user-1',
    nameHash: 'losing-name-hash',
    studentIdHash: 'losing-student-hash',
  })

  assert.equal(result, identity)
  assert.equal(reads, 1)
})

test('identity creation does not hide non-unique persistence errors', async () => {
  const persistenceError = new Error('database unavailable')
  const db = {
    userIdentity: {
      create: async () => {
        throw persistenceError
      },
      findUnique: async () => identity,
    },
  } as unknown as CertificateRecordDatabase

  await assert.rejects(
    createUserIdentityOrReadConcurrent(db, {
      userId: 'user-1',
      nameHash: 'name-hash',
      studentIdHash: 'student-hash',
    }),
    (error: unknown) => error === persistenceError,
  )
})

test('certificate creation reuses the row committed for the business key', async () => {
  let reads = 0
  let creates = 0
  const db = {
    participationCertificate: {
      findUnique: async () => {
        reads += 1
        return reads === 1 ? null : certificate
      },
      create: async () => {
        creates += 1
        throw uniqueConstraintError()
      },
    },
  } as unknown as CertificateRecordDatabase

  const result = await findOrCreateParticipationCertificate(db, {
    matchId: 'match-1',
    userId: 'user-1',
    generateCertificateNumber: () => 'PPC-20260904-ABCDEF',
  })

  assert.equal(result, certificate)
  assert.equal(reads, 2)
  assert.equal(creates, 1)
})

test('certificate creation retries only when the generated number collided', async () => {
  const generated: string[] = []
  let creates = 0
  const db = {
    participationCertificate: {
      findUnique: async () => null,
      create: async ({ data }: { data: { certificateNo: string } }) => {
        creates += 1
        generated.push(data.certificateNo)
        if (creates === 1) throw uniqueConstraintError()
        return { ...certificate, certificateNo: data.certificateNo }
      },
    },
  } as unknown as CertificateRecordDatabase
  const numbers = ['PPC-COLLISION', 'PPC-AVAILABLE']

  const result = await findOrCreateParticipationCertificate(db, {
    matchId: 'match-1',
    userId: 'user-1',
    generateCertificateNumber: () => numbers.shift()!,
  })

  assert.equal(result?.certificateNo, 'PPC-AVAILABLE')
  assert.deepEqual(generated, ['PPC-COLLISION', 'PPC-AVAILABLE'])
})

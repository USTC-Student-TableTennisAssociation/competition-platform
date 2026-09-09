import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PrismaClient } from '@prisma/client'

import {
  acceptDoublesInviteInTransaction,
  revokeDoublesInviteInTransaction,
  runDoublesSourceTransaction,
  sendDoublesInviteInTransaction,
} from './doubles-source'

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL

test(
  'PostgreSQL serializes doubles sends and competing accepts without a schema unique constraint',
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl
    const db = new PrismaClient()
    const suffix = randomUUID().replaceAll('-', '')
    const id = (name: string) => `doubles-${name}-${suffix}`
    const userA = id('user-a')
    const userB = id('user-b')
    const userC = id('user-c')
    const duplicateSendMatchId = id('duplicate-send-match')
    const competingAcceptMatchId = id('competing-accept-match')
    const revokeMatchId = id('revoke-match')
    const createMatch = (matchId: string, status: 'registration' | 'finished' = 'registration') =>
      db.match.create({
        data: {
          id: matchId,
          title: matchId,
          dateTime: new Date('2099-02-01T00:00:00.000Z'),
          type: 'double',
          status,
          engineVersion: 'V2',
          isQuickMatch: false,
          maxParticipants: 16,
          createdBy: userA,
          registrationDeadline: new Date('2099-01-01T00:00:00.000Z'),
        },
      })

    try {
      await db.user.createMany({
        data: [userA, userB, userC].map((userId) => ({
          id: userId,
          email: `${userId}@example.test`,
          nickname: userId,
          emailVerifiedAt: new Date('2026-09-04T00:00:00.000Z'),
        })),
      })

      await createMatch(duplicateSendMatchId)
      const duplicateSendResults = await Promise.all([
        runDoublesSourceTransaction(
          db,
          (tx) => sendDoublesInviteInTransaction(tx, {
            matchId: duplicateSendMatchId,
            inviterId: userA,
            inviteeId: userB,
          }),
        ),
        runDoublesSourceTransaction(
          db,
          (tx) => sendDoublesInviteInTransaction(tx, {
            matchId: duplicateSendMatchId,
            inviterId: userB,
            inviteeId: userA,
          }),
        ),
      ])
      assert.equal(duplicateSendResults.filter((result) => result.ok).length, 1)
      assert.equal(
        duplicateSendResults.filter(
          (result) =>
            !result.ok &&
            ['双方已有待处理邀请。', '数据已发生变化，请重试。'].includes(
              result.error,
            ),
        ).length,
        1,
      )
      assert.equal(
        await db.matchDoublesInvite.count({
          where: { matchId: duplicateSendMatchId, status: 'pending' },
        }),
        1,
      )

      await createMatch(competingAcceptMatchId)
      const firstInvite = await db.matchDoublesInvite.create({
        data: {
          id: id('invite-a-b'),
          matchId: competingAcceptMatchId,
          inviterId: userA,
          inviteeId: userB,
          status: 'pending',
        },
      })
      const secondInvite = await db.matchDoublesInvite.create({
        data: {
          id: id('invite-c-b'),
          matchId: competingAcceptMatchId,
          inviterId: userC,
          inviteeId: userB,
          status: 'pending',
        },
      })

      const competingAcceptResults = await Promise.all([
        runDoublesSourceTransaction(
          db,
          (tx) => acceptDoublesInviteInTransaction(tx, {
            inviteId: firstInvite.id,
            currentUserId: userB,
          }),
        ),
        runDoublesSourceTransaction(
          db,
          (tx) => acceptDoublesInviteInTransaction(tx, {
            inviteId: secondInvite.id,
            currentUserId: userB,
          }),
        ),
      ])
      assert.equal(competingAcceptResults.filter((result) => result.ok).length, 1)
      assert.equal(
        competingAcceptResults.filter(
          (result) =>
            !result.ok &&
            ['该邀请已失效。', '数据已发生变化，请重试。'].includes(
              result.error,
            ),
        ).length,
        1,
      )
      assert.equal(
        await db.matchDoublesTeam.count({
          where: { matchId: competingAcceptMatchId },
        }),
        1,
      )
      const memberships = await db.matchDoublesTeamMember.findMany({
        where: { matchId: competingAcceptMatchId },
        select: { teamId: true, userId: true },
      })
      assert.equal(memberships.length, 2)
      assert.equal(new Set(memberships.map(({ teamId }) => teamId)).size, 1)
      assert.equal(
        memberships.filter(({ userId }) => userId === userB).length,
        1,
      )

      await createMatch(revokeMatchId, 'finished')
      const revocableInvite = await db.matchDoublesInvite.create({
        data: {
          id: id('revoke-invite'),
          matchId: revokeMatchId,
          inviterId: userA,
          inviteeId: userC,
          status: 'pending',
        },
      })
      await db.match.update({
        where: { id: revokeMatchId },
        data: { type: 'single', isQuickMatch: true },
      })
      const revokeResult = await runDoublesSourceTransaction(
        db,
        (tx) => revokeDoublesInviteInTransaction(tx, {
          inviteId: revocableInvite.id,
          currentUserId: userA,
        }),
      )
      assert.deepEqual(revokeResult, { ok: true })
      assert.equal(
        (
          await db.matchDoublesInvite.findUniqueOrThrow({
            where: { id: revocableInvite.id },
            select: { status: true },
          })
        ).status,
        'revoked',
      )
    } finally {
      await db.$disconnect()
    }
  },
)

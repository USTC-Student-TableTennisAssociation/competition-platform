'use server'

import { getAuditContext } from '@/lib/audit-log'
import { getCurrentUser } from '@/lib/auth'
import { validateCsrfToken } from '@/lib/csrf'
import { prisma } from '@/lib/prisma'
import {
isRetryableTeamSourceConflict,
lockTeamSourceMatch,
lockTeamSourceRows,
TEAM_SOURCE_CHANGED_MESSAGE,
} from '@/lib/server/match/team-source'
import { getV2MatchCreationPolicy } from '@/lib/server/match/v2-creation-flag'
import { lockUsersForUpdate } from '@/lib/server/user/lock-users'
import {
createV2DoubleGroupThenKnockoutMatchCreationHandler,
createV2DoubleMatchCreationHandler,
resolveExistingV2DoubleGroupThenKnockoutMatchCreationHandler,
resolveExistingV2DoubleMatchCreationHandler,
} from '@/modules/competitions-v2/adapters/double-match-creation'
import {
dispatchV2MatchCreation,
type V2MatchCreationHandlers,
} from '@/modules/competitions-v2/adapters/group-only-match-creation-dispatch'
import {
createV2SingleGroupThenKnockoutMatchCreationHandler,
createV2SingleMatchCreationHandler,
resolveExistingV2SingleGroupThenKnockoutMatchCreationHandler,
resolveExistingV2SingleMatchCreationHandler,
} from '@/modules/competitions-v2/adapters/single-match-creation'
import {
createV2TeamGroupThenKnockoutMatchCreationHandler,
createV2TeamMatchCreationHandler,
resolveExistingV2TeamGroupThenKnockoutMatchCreationHandler,
resolveExistingV2TeamMatchCreationHandler,
} from '@/modules/competitions-v2/adapters/team-match-creation'
import { transitionV2EntryStatusInTransaction } from '@/modules/competitions-v2/application/entries'
import {
lockV2TeamEntryRegistrationContext,
lockV2TeamEntryRegistrationCreationContext,
reconcileV2TeamEntryRegistrationInTransaction,
type V2LockedTeamEntryRegistrationContext,
} from '@/modules/competitions-v2/application/team-entry-registration'
import { MatchEngineVersion,MatchStatus,MatchType,Prisma,TeamRegistrationStatus } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { randomBytes,randomUUID } from 'node:crypto'
const DEFAULT_TEAM_MIN_MEMBERS = 3
const DEFAULT_TEAM_MAX_MEMBERS = 6
const TEAM_INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function safeLogV2MatchCreationError(message: string, error: unknown) {
  try {
    const name = error instanceof Error ? error.name : 'UnknownError'
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined

    console.error(message, code === undefined ? { name } : { name, code })
  } catch {
    console.error(message, { name: 'UninspectableError' })
  }
}

const v2MatchCreationDependencies = {
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  logError: safeLogV2MatchCreationError,
}
const createV2SingleMatch = createV2SingleMatchCreationHandler(
  v2MatchCreationDependencies,
)
const resolveExistingV2SingleMatch =
  resolveExistingV2SingleMatchCreationHandler(v2MatchCreationDependencies)
const createV2SingleGroupThenKnockoutMatch =
  createV2SingleGroupThenKnockoutMatchCreationHandler(
    v2MatchCreationDependencies,
  )
const resolveExistingV2SingleGroupThenKnockoutMatch =
  resolveExistingV2SingleGroupThenKnockoutMatchCreationHandler(
    v2MatchCreationDependencies,
  )
const createV2DoubleMatch = createV2DoubleMatchCreationHandler(
  v2MatchCreationDependencies,
)
const resolveExistingV2DoubleMatch =
  resolveExistingV2DoubleMatchCreationHandler(v2MatchCreationDependencies)
const createV2DoubleGroupThenKnockoutMatch =
  createV2DoubleGroupThenKnockoutMatchCreationHandler(
    v2MatchCreationDependencies,
  )
const resolveExistingV2DoubleGroupThenKnockoutMatch =
  resolveExistingV2DoubleGroupThenKnockoutMatchCreationHandler(
    v2MatchCreationDependencies,
  )
const createV2TeamMatch = createV2TeamMatchCreationHandler(
  v2MatchCreationDependencies,
)
const resolveExistingV2TeamMatch =
  resolveExistingV2TeamMatchCreationHandler(v2MatchCreationDependencies)
const createV2TeamGroupThenKnockoutMatch =
  createV2TeamGroupThenKnockoutMatchCreationHandler(v2MatchCreationDependencies)
const resolveExistingV2TeamGroupThenKnockoutMatch =
  resolveExistingV2TeamGroupThenKnockoutMatchCreationHandler(
    v2MatchCreationDependencies,
  )

const v2MatchCreationHandlers = Object.freeze({
  single: Object.freeze({
    group_only: Object.freeze({
      createV2: createV2SingleMatch,
      resolveExistingV2: resolveExistingV2SingleMatch,
    }),
    group_then_knockout: Object.freeze({
      createV2: createV2SingleGroupThenKnockoutMatch,
      resolveExistingV2: resolveExistingV2SingleGroupThenKnockoutMatch,
    }),
  }),
  double: Object.freeze({
    group_only: Object.freeze({
      createV2: createV2DoubleMatch,
      resolveExistingV2: resolveExistingV2DoubleMatch,
    }),
    group_then_knockout: Object.freeze({
      createV2: createV2DoubleGroupThenKnockoutMatch,
      resolveExistingV2: resolveExistingV2DoubleGroupThenKnockoutMatch,
    }),
  }),
  team: Object.freeze({
    group_only: Object.freeze({
      createV2: createV2TeamMatch,
      resolveExistingV2: resolveExistingV2TeamMatch,
    }),
    group_then_knockout: Object.freeze({
      createV2: createV2TeamGroupThenKnockoutMatch,
      resolveExistingV2: resolveExistingV2TeamGroupThenKnockoutMatch,
    }),
  }),
}) satisfies V2MatchCreationHandlers



export type MatchFormState = {
  error?: string
  success?: string
}

function generateTeamInviteCode() {
  const bytes = randomBytes(8)
  let code = ''
  for (const byte of bytes) {
    code += TEAM_INVITE_CODE_ALPHABET[byte % TEAM_INVITE_CODE_ALPHABET.length]
  }
  return code
}

function cleanText(value: FormDataEntryValue | null, maxLength: number) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function resolveTeamWindow(match: {
  createdAt: Date
  registrationDeadline: Date
  teamRegistrationStart: Date | null
  teamRegistrationDeadline: Date | null
}) {
  return {
    startsAt: match.teamRegistrationStart ?? match.createdAt,
    deadline: match.teamRegistrationDeadline ?? match.registrationDeadline,
  }
}

function assertTeamRegistrationOpen(match: {
  type: MatchType
  status: MatchStatus
  createdAt: Date
  registrationDeadline: Date
  teamRegistrationStart: Date | null
  teamRegistrationDeadline: Date | null
}) {
  if (match.type !== MatchType.team) {
    return { ok: false as const, error: '该比赛不是团体赛。' }
  }
  if (match.status !== MatchStatus.registration) {
    return { ok: false as const, error: '当前比赛不在报名阶段。' }
  }

  const now = new Date()
  const { startsAt, deadline } = resolveTeamWindow(match)
  if (now < startsAt) {
    return { ok: false as const, error: '团体赛报名尚未开始。' }
  }
  if (now >= deadline) {
    return { ok: false as const, error: '团体赛报名已截止。' }
  }

  return { ok: true as const }
}

function canEditTeamStatus(status: TeamRegistrationStatus) {
  return status !== TeamRegistrationStatus.cancelled
}

function resolveAutoTeamStatus(memberCount: number, minMembers: number) {
  return memberCount >= minMembers
    ? TeamRegistrationStatus.approved
    : TeamRegistrationStatus.draft
}

export async function createMatchAction(_: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const v2CreationPolicy = getV2MatchCreationPolicy()
  const v2Dispatch = await dispatchV2MatchCreation({
    formData,
    capabilities: v2CreationPolicy.capabilities,
    disabledRoute: v2CreationPolicy.disabledRoute,
    handlers: v2MatchCreationHandlers,
  })
  if (v2Dispatch.kind !== 'legacy') {
    if (v2Dispatch.kind === 'v2' && v2Dispatch.state.createdMatchId) {
      const createdMatchId = v2Dispatch.state.createdMatchId
      revalidatePath('/')
      revalidatePath('/matchs')
      redirect(`/matchs/${createdMatchId}`)
    }
    return v2Dispatch.state
  }

  return { error: '旧版正式比赛创建已停用，请刷新页面。' }
}

function revalidateTeamRegistrationViews(matchId: string) {
  revalidatePath('/matchs')
  revalidatePath('/admin')
  revalidatePath(`/matchs/${matchId}`)
}

export async function createMatchTeamAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后创建队伍。' }

  const name = cleanText(formData.get('name'), 40)
  const contact = cleanText(formData.get('contact'), 100)
  const remark = cleanText(formData.get('remark'), 500)

  if (name.length < 2) return { error: '队伍名称至少需要 2 个字符。' }
  if (!contact) return { error: '请填写队伍联系方式。' }

  const auditContext = await getAuditContext()

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const inviteCode = generateTeamInviteCode()
    const teamId = randomUUID()

    try {
      const creationResult = await prisma.$transaction(async (tx) => {
        const lockedMatch = await lockTeamSourceMatch(tx, matchId)
        if (!lockedMatch.ok) return lockedMatch

        let v2Context: V2LockedTeamEntryRegistrationContext | null = null
        if (lockedMatch.match.engineVersion === MatchEngineVersion.V2) {
          v2Context = await lockV2TeamEntryRegistrationCreationContext(tx, {
            matchId,
            teamId,
            additionalUserIds: [currentUser.id],
          })
        } else {
          const lockedSource = await lockTeamSourceRows(tx, {
            matchId,
            userIds: [currentUser.id],
          })
          const sourceTeams = lockedSource.teamIds.length > 0
            ? await tx.matchTeam.findMany({
                where: { id: { in: lockedSource.teamIds }, matchId },
                select: { captainId: true },
              })
            : []
          await lockUsersForUpdate(tx, [
            currentUser.id,
            ...sourceTeams.map((team) => team.captainId),
            ...lockedSource.members.map((member) => member.userId),
          ])
        }

        const actor = await tx.user.findUnique({
          where: { id: currentUser.id },
          select: { isBanned: true, emailVerifiedAt: true },
        })
        if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
          return { ok: false as const, error: '请先登录后创建队伍。' }
        }

        const open = assertTeamRegistrationOpen(lockedMatch.match)
        if (!open.ok) return { ok: false as const, error: open.error }

        const existingMembership = await tx.matchTeamMember.findUnique({
          where: {
            matchId_userId: {
              matchId,
              userId: currentUser.id,
            },
          },
          select: {
            id: true,
            teamId: true,
            team: { select: { status: true } },
          },
        })

        if (existingMembership) {
          if (existingMembership.team.status === TeamRegistrationStatus.cancelled) {
            await tx.matchTeamMember.delete({ where: { id: existingMembership.id } })
          } else {
            return { ok: false as const, error: '你已经加入了本场团体赛的队伍。' }
          }
        }

        const minMembers = lockedMatch.match.teamMinMembers ?? DEFAULT_TEAM_MIN_MEMBERS
        const created = await tx.matchTeam.create({
          data: {
            ...(v2Context ? { id: teamId } : {}),
            matchId,
            captainId: currentUser.id,
            name,
            inviteCode,
            contact,
            remark: remark || null,
            status: resolveAutoTeamStatus(1, minMembers),
            submittedAt: 1 >= minMembers ? new Date() : null,
            members: {
              create: {
                userId: currentUser.id,
              },
            },
          },
          select: { id: true },
        })

        await tx.auditLog.create({
          data: {
            actorId: currentUser.id,
            action: 'match.team.create',
            entityType: 'MatchTeam',
            entityId: created.id,
            details: {
              targetLabel: `${lockedMatch.match.title} / ${name}`,
              matchId,
              matchTitle: lockedMatch.match.title,
              teamName: name,
            },
            ip: auditContext.ip,
            userAgent: auditContext.userAgent,
          },
        })

        if (v2Context) {
          await reconcileV2TeamEntryRegistrationInTransaction(tx, v2Context)
        }

        return {
          ok: true as const,
          reachedMinMembers: 1 >= minMembers,
        }
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })

      if (!creationResult.ok) return { error: creationResult.error }

      revalidateTeamRegistrationViews(matchId)
      return {
        success:
          creationResult.reachedMinMembers
            ? `队伍已创建并自动报名成功，邀请码：${inviteCode}`
            : `队伍已创建，邀请码：${inviteCode}`,
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existingMembership = await prisma.matchTeamMember.findUnique({
          where: {
            matchId_userId: {
              matchId,
              userId: currentUser.id,
            },
          },
          select: { id: true },
        })
        if (existingMembership) {
          return { error: '你已经加入了本场团体赛的队伍。' }
        }
        if (attempt < 5) continue
        return { error: '邀请码生成失败，请重试。' }
      }
      if (isRetryableTeamSourceConflict(error)) {
        return { error: TEAM_SOURCE_CHANGED_MESSAGE }
      }

      console.error('createMatchTeamAction failed', error)
      return { error: '创建队伍失败，请稍后重试。' }
    }
  }

  return { error: '创建队伍失败，请重试。' }
}

export async function updateMatchTeamAction(teamId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const binding = await prisma.matchTeam.findUnique({
    where: { id: teamId },
    select: { matchId: true },
  })
  if (!binding) return { error: '队伍不存在。' }

  const name = cleanText(formData.get('name'), 40)
  const contact = cleanText(formData.get('contact'), 100)
  const remark = cleanText(formData.get('remark'), 500)

  let updateResult: { ok: false; error: string } | { ok: true; matchId: string }
  try {
    updateResult = await prisma.$transaction(async (tx) => {
      const lockedMatch = await lockTeamSourceMatch(tx, binding.matchId)
      if (!lockedMatch.ok) return lockedMatch

      let v2Context: V2LockedTeamEntryRegistrationContext | null = null
      if (lockedMatch.match.engineVersion === MatchEngineVersion.V2) {
        v2Context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId: binding.matchId,
          teamId,
          additionalUserIds: [currentUser.id],
        })
      } else {
        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: binding.matchId,
          teamIds: [teamId],
        })
        if (!lockedSource.teamIds.includes(teamId)) {
          return { ok: false as const, error: '队伍不存在。' }
        }
      }

      const teamSubject = await tx.matchTeam.findUnique({
        where: { id: teamId },
        select: {
          captainId: true,
          members: { select: { userId: true } },
        },
      })
      if (!teamSubject) return { ok: false as const, error: '队伍不存在。' }

      const userIds = [
        currentUser.id,
        teamSubject.captainId,
        ...teamSubject.members.map((member) => member.userId),
      ]
      if (!v2Context) await lockUsersForUpdate(tx, userIds)

      const [team, users] = await Promise.all([
        tx.matchTeam.findUnique({
          where: { id: teamId },
          select: {
            matchId: true,
            captainId: true,
            status: true,
            members: { select: { userId: true } },
          },
        }),
        tx.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, isBanned: true, emailVerifiedAt: true },
        }),
      ])
      if (!team || team.matchId !== binding.matchId) {
        return { ok: false as const, error: '队伍不存在。' }
      }

      const userById = new Map(users.map((user) => [user.id, user]))
      const actor = userById.get(currentUser.id)
      if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
        return { ok: false as const, error: '请先登录。' }
      }
      if (team.captainId !== currentUser.id) {
        return { ok: false as const, error: '只有队长可以修改队伍信息。' }
      }

      const open = assertTeamRegistrationOpen(lockedMatch.match)
      if (!open.ok) return { ok: false as const, error: open.error }
      if (!canEditTeamStatus(team.status)) {
        return { ok: false as const, error: '当前队伍状态不可修改信息。' }
      }
      if (team.members.some((member) => {
        const user = userById.get(member.userId)
        return !user || user.isBanned
      })) {
        return { ok: false as const, error: '队伍中存在已封禁用户，当前不可修改。' }
      }

      if (name.length < 2) {
        return { ok: false as const, error: '队伍名称至少需要 2 个字符。' }
      }
      if (!contact) return { ok: false as const, error: '请填写队伍联系方式。' }

      await tx.matchTeam.update({
        where: { id: teamId },
        data: {
          name,
          contact,
          remark: remark || null,
          reviewNote: null,
          status:
            team.status === TeamRegistrationStatus.rejected
              ? TeamRegistrationStatus.draft
              : team.status,
        },
      })

      if (v2Context) {
        await reconcileV2TeamEntryRegistrationInTransaction(tx, v2Context)
      }

      return { ok: true as const, matchId: binding.matchId }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
  } catch (error) {
    if (isRetryableTeamSourceConflict(error)) {
      return { error: TEAM_SOURCE_CHANGED_MESSAGE }
    }
    console.error('updateMatchTeamAction failed', error)
    return { error: '更新队伍失败，请稍后重试。' }
  }

  if (!updateResult.ok) return { error: updateResult.error }

  revalidateTeamRegistrationViews(updateResult.matchId)
  return { success: '队伍信息已更新。' }
}

export async function joinMatchTeamByInviteAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后加入队伍。' }

  const inviteCode = cleanText(formData.get('inviteCode'), 20).toUpperCase()
  if (!inviteCode) return { error: '请输入邀请码。' }

  type JoinResult =
    | { ok: false; error: string }
    | { ok: true; teamName: string; reachedMinMembers: boolean }
  let joinResult: JoinResult
  try {
    joinResult = await prisma.$transaction(async (tx): Promise<JoinResult> => {
      const lockedMatch = await lockTeamSourceMatch(tx, matchId)
      if (!lockedMatch.ok) return lockedMatch

      const targetBinding = await tx.matchTeam.findFirst({
        where: { matchId, inviteCode },
        select: { id: true },
      })
      if (!targetBinding) return { ok: false, error: '邀请码无效。' }

      const existingBinding = await tx.matchTeamMember.findUnique({
        where: { matchId_userId: { matchId, userId: currentUser.id } },
        select: { teamId: true },
      })
      const sourceTeamIds = [targetBinding.id, ...(existingBinding ? [existingBinding.teamId] : [])]
      let v2Context: V2LockedTeamEntryRegistrationContext | null = null
      let lockedSource: Awaited<ReturnType<typeof lockTeamSourceRows>>
      if (lockedMatch.match.engineVersion === MatchEngineVersion.V2) {
        v2Context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId: targetBinding.id,
          additionalTeamIds: existingBinding ? [existingBinding.teamId] : [],
          additionalUserIds: [currentUser.id],
        })
        lockedSource = {
          teamIds: [...v2Context.lockedTeamIds],
          members: [...v2Context.lockedSourceMembers],
        }
        if (existingBinding && existingBinding.teamId !== targetBinding.id) {
          const relatedEntry = await tx.matchEntry.findFirst({
            where: { matchId, sourceMatchTeamId: existingBinding.teamId },
            select: { id: true },
          })
          if (relatedEntry) {
            return { ok: false, error: '原队伍已生成新版比赛身份，不能隐式迁移成员。' }
          }
        }
      } else {
        lockedSource = await lockTeamSourceRows(tx, {
          matchId,
          teamIds: sourceTeamIds,
        })
        if (!lockedSource.teamIds.includes(targetBinding.id)) {
          return { ok: false, error: '邀请码无效。' }
        }
      }

      const teamSubjects = await tx.matchTeam.findMany({
        where: { id: { in: lockedSource.teamIds }, matchId },
        select: { captainId: true },
      })
      const userIds = [
        currentUser.id,
        ...teamSubjects.map((team) => team.captainId),
        ...lockedSource.members.map((member) => member.userId),
      ]
      if (!v2Context) await lockUsersForUpdate(tx, userIds)

      const [actor, team] = await Promise.all([
        tx.user.findUnique({
          where: { id: currentUser.id },
          select: { isBanned: true, emailVerifiedAt: true },
        }),
        tx.matchTeam.findUnique({
          where: { id: targetBinding.id },
          select: {
            id: true,
            matchId: true,
            name: true,
            status: true,
            submittedAt: true,
            captainId: true,
            captain: { select: { isBanned: true } },
            members: {
              select: {
                userId: true,
                user: { select: { isBanned: true } },
              },
            },
          },
        }),
      ])
      if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
        return { ok: false, error: '请先登录后加入队伍。' }
      }
      if (!team || team.matchId !== matchId) {
        return { ok: false, error: '邀请码无效。' }
      }

      const open = assertTeamRegistrationOpen(lockedMatch.match)
      if (!open.ok) return { ok: false, error: open.error }
      if (!canEditTeamStatus(team.status)) {
        return { ok: false, error: '该队伍当前不可加入。' }
      }
      if (
        team.captain.isBanned ||
        team.members.some((member) => member.user.isBanned)
      ) {
        return { ok: false, error: '队伍中存在已封禁用户，当前不可加入。' }
      }

      const existingMembership = await tx.matchTeamMember.findUnique({
        where: {
          matchId_userId: {
            matchId,
            userId: currentUser.id,
          },
        },
        select: {
          id: true,
          team: { select: { status: true } },
        },
      })
      if (existingMembership) {
        if (existingMembership.team.status === TeamRegistrationStatus.cancelled) {
          await tx.matchTeamMember.delete({ where: { id: existingMembership.id } })
        } else {
          return { ok: false, error: '你已经加入了本场团体赛的队伍。' }
        }
      }

      const maxMembers = lockedMatch.match.teamMaxMembers ?? DEFAULT_TEAM_MAX_MEMBERS
      const minMembers = lockedMatch.match.teamMinMembers ?? DEFAULT_TEAM_MIN_MEMBERS
      const memberCount = team.members.length
      if (memberCount >= maxMembers) {
        return { ok: false, error: '该队伍已满员。' }
      }

      await tx.matchTeamMember.create({
        data: {
          teamId: targetBinding.id,
          matchId,
          userId: currentUser.id,
        },
      })

      const nextMemberCount = memberCount + 1
      const reachedMinMembers = nextMemberCount >= minMembers
      const nextStatus = resolveAutoTeamStatus(nextMemberCount, minMembers)
      await tx.matchTeam.update({
        where: { id: targetBinding.id },
        data: {
          status: nextStatus,
          submittedAt:
            nextStatus === TeamRegistrationStatus.approved
              ? (team.submittedAt ?? new Date())
              : null,
          reviewNote: null,
        },
      })

      if (v2Context) {
        await reconcileV2TeamEntryRegistrationInTransaction(tx, v2Context)
      }

      return { ok: true, teamName: team.name, reachedMinMembers }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { error: '你已经加入了本场团体赛的队伍。' }
    }
    if (isRetryableTeamSourceConflict(error)) {
      return { error: TEAM_SOURCE_CHANGED_MESSAGE }
    }
    console.error('joinMatchTeamByInviteAction failed', error)
    return { error: '加入队伍失败，请稍后重试。' }
  }

  if (!joinResult.ok) return { error: joinResult.error }

  revalidateTeamRegistrationViews(matchId)
  return {
    success:
      joinResult.reachedMinMembers
        ? `已加入 ${joinResult.teamName}，队伍人数已达标并自动报名成功。`
        : `已加入 ${joinResult.teamName}。`,
  }
}

export async function leaveMatchTeamAction(teamId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const binding = await prisma.matchTeam.findUnique({
    where: { id: teamId },
    select: { matchId: true },
  })
  if (!binding) return { error: '队伍不存在。' }

  let leaveResult: { ok: false; error: string } | { ok: true; matchId: string }
  try {
    leaveResult = await prisma.$transaction(async (tx) => {
      const lockedMatch = await lockTeamSourceMatch(tx, binding.matchId)
      if (!lockedMatch.ok) return lockedMatch

      let v2Context: V2LockedTeamEntryRegistrationContext | null = null
      if (lockedMatch.match.engineVersion === MatchEngineVersion.V2) {
        v2Context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId: binding.matchId,
          teamId,
          additionalUserIds: [currentUser.id],
        })
      } else {
        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: binding.matchId,
          teamIds: [teamId],
        })
        if (!lockedSource.teamIds.includes(teamId)) {
          return { ok: false as const, error: '队伍不存在。' }
        }
      }

      const teamSubject = await tx.matchTeam.findUnique({
        where: { id: teamId },
        select: {
          captainId: true,
          members: { select: { userId: true } },
        },
      })
      if (!teamSubject) return { ok: false as const, error: '队伍不存在。' }

      if (!v2Context) {
        await lockUsersForUpdate(tx, [
          currentUser.id,
          teamSubject.captainId,
          ...teamSubject.members.map((member) => member.userId),
        ])
      }

      const [actor, team] = await Promise.all([
        tx.user.findUnique({
          where: { id: currentUser.id },
          select: { isBanned: true, emailVerifiedAt: true },
        }),
        tx.matchTeam.findUnique({
          where: { id: teamId },
          select: {
            matchId: true,
            captainId: true,
            status: true,
            submittedAt: true,
            members: { select: { userId: true } },
          },
        }),
      ])
      if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
        return { ok: false as const, error: '请先登录。' }
      }
      if (!team || team.matchId !== binding.matchId) {
        return { ok: false as const, error: '队伍不存在。' }
      }

      const open = assertTeamRegistrationOpen(lockedMatch.match)
      if (!open.ok) return { ok: false as const, error: open.error }
      if (!canEditTeamStatus(team.status)) {
        return { ok: false as const, error: '当前队伍状态不可退出。' }
      }
      if (!team.members.some((member) => member.userId === currentUser.id)) {
        return { ok: false as const, error: '你不在该队伍中。' }
      }
      if (team.captainId === currentUser.id) {
        return { ok: false as const, error: '队长请使用解散队伍。' }
      }

      await tx.matchTeamMember.delete({
        where: {
          matchId_userId: {
            matchId: binding.matchId,
            userId: currentUser.id,
          },
        },
      })

      const minMembers = lockedMatch.match.teamMinMembers ?? DEFAULT_TEAM_MIN_MEMBERS
      const nextMemberCount = team.members.length - 1
      const nextStatus = resolveAutoTeamStatus(nextMemberCount, minMembers)
      await tx.matchTeam.update({
        where: { id: teamId },
        data: {
          status: nextStatus,
          submittedAt:
            nextStatus === TeamRegistrationStatus.approved
              ? (team.submittedAt ?? new Date())
              : null,
          reviewNote: null,
        },
      })

      if (v2Context) {
        await reconcileV2TeamEntryRegistrationInTransaction(tx, v2Context)
      }

      return { ok: true as const, matchId: binding.matchId }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
  } catch (error) {
    if (isRetryableTeamSourceConflict(error)) {
      return { error: TEAM_SOURCE_CHANGED_MESSAGE }
    }
    console.error('leaveMatchTeamAction failed', error)
    return { error: '退出队伍失败，请稍后重试。' }
  }

  if (!leaveResult.ok) return { error: leaveResult.error }

  revalidateTeamRegistrationViews(leaveResult.matchId)
  return { success: '已退出队伍。' }
}

export async function removeMatchTeamMemberAction(teamId: string, userId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const binding = await prisma.matchTeam.findUnique({
    where: { id: teamId },
    select: { matchId: true },
  })
  if (!binding) return { error: '队伍不存在。' }

  let removalResult: { ok: false; error: string } | { ok: true; matchId: string }
  try {
    removalResult = await prisma.$transaction(async (tx) => {
      const lockedMatch = await lockTeamSourceMatch(tx, binding.matchId)
      if (!lockedMatch.ok) return lockedMatch

      let v2Context: V2LockedTeamEntryRegistrationContext | null = null
      if (lockedMatch.match.engineVersion === MatchEngineVersion.V2) {
        v2Context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId: binding.matchId,
          teamId,
          additionalUserIds: [currentUser.id, userId],
        })
      } else {
        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: binding.matchId,
          teamIds: [teamId],
        })
        if (!lockedSource.teamIds.includes(teamId)) {
          return { ok: false as const, error: '队伍不存在。' }
        }
      }

      const teamSubject = await tx.matchTeam.findUnique({
        where: { id: teamId },
        select: {
          captainId: true,
          members: { select: { userId: true } },
        },
      })
      if (!teamSubject) return { ok: false as const, error: '队伍不存在。' }

      if (!v2Context) {
        await lockUsersForUpdate(tx, [
          currentUser.id,
          userId,
          teamSubject.captainId,
          ...teamSubject.members.map((member) => member.userId),
        ])
      }

      const [actor, team] = await Promise.all([
        tx.user.findUnique({
          where: { id: currentUser.id },
          select: { isBanned: true, emailVerifiedAt: true },
        }),
        tx.matchTeam.findUnique({
          where: { id: teamId },
          select: {
            matchId: true,
            captainId: true,
            status: true,
            submittedAt: true,
            members: { select: { userId: true } },
          },
        }),
      ])
      if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
        return { ok: false as const, error: '请先登录。' }
      }
      if (!team || team.matchId !== binding.matchId) {
        return { ok: false as const, error: '队伍不存在。' }
      }
      if (team.captainId !== currentUser.id) {
        return { ok: false as const, error: '只有队长可以移除队员。' }
      }
      if (team.captainId === userId) {
        return { ok: false as const, error: '不能移除队长本人。' }
      }

      const open = assertTeamRegistrationOpen(lockedMatch.match)
      if (!open.ok) return { ok: false as const, error: open.error }
      if (!canEditTeamStatus(team.status)) {
        return { ok: false as const, error: '当前队伍状态不可移除队员。' }
      }
      if (!team.members.some((member) => member.userId === userId)) {
        return { ok: false as const, error: '该成员不在队伍中。' }
      }

      await tx.matchTeamMember.delete({
        where: {
          matchId_userId: {
            matchId: binding.matchId,
            userId,
          },
        },
      })

      const minMembers = lockedMatch.match.teamMinMembers ?? DEFAULT_TEAM_MIN_MEMBERS
      const nextMemberCount = team.members.length - 1
      const nextStatus = resolveAutoTeamStatus(nextMemberCount, minMembers)
      await tx.matchTeam.update({
        where: { id: teamId },
        data: {
          status: nextStatus,
          submittedAt:
            nextStatus === TeamRegistrationStatus.approved
              ? (team.submittedAt ?? new Date())
              : null,
          reviewNote: null,
        },
      })

      if (v2Context) {
        await reconcileV2TeamEntryRegistrationInTransaction(tx, v2Context)
      }

      return { ok: true as const, matchId: binding.matchId }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
  } catch (error) {
    if (isRetryableTeamSourceConflict(error)) {
      return { error: TEAM_SOURCE_CHANGED_MESSAGE }
    }
    console.error('removeMatchTeamMemberAction failed', error)
    return { error: '移除队员失败，请稍后重试。' }
  }

  if (!removalResult.ok) return { error: removalResult.error }

  revalidateTeamRegistrationViews(removalResult.matchId)
  return { success: '已移除队员。' }
}

export async function submitMatchTeamAction(teamId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const binding = await prisma.matchTeam.findUnique({
    where: { id: teamId },
    select: { matchId: true },
  })
  if (!binding) return { error: '队伍不存在。' }

  const auditContext = await getAuditContext()
  let submissionResult: { ok: false; error: string } | { ok: true; matchId: string }
  try {
    submissionResult = await prisma.$transaction(async (tx) => {
      const lockedMatch = await lockTeamSourceMatch(tx, binding.matchId)
      if (!lockedMatch.ok) return lockedMatch

      let v2Context: V2LockedTeamEntryRegistrationContext | null = null
      if (lockedMatch.match.engineVersion === MatchEngineVersion.V2) {
        v2Context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId: binding.matchId,
          teamId,
          additionalUserIds: [currentUser.id],
        })
      } else {
        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: binding.matchId,
          teamIds: [teamId],
        })
        if (!lockedSource.teamIds.includes(teamId)) {
          return { ok: false as const, error: '队伍不存在。' }
        }
      }

      const teamSubject = await tx.matchTeam.findUnique({
        where: { id: teamId },
        select: {
          captainId: true,
          members: { select: { userId: true } },
        },
      })
      if (!teamSubject) return { ok: false as const, error: '队伍不存在。' }

      const userIds = [
        currentUser.id,
        teamSubject.captainId,
        ...teamSubject.members.map((member) => member.userId),
      ]
      if (!v2Context) await lockUsersForUpdate(tx, userIds)

      const [actor, team] = await Promise.all([
        tx.user.findUnique({
          where: { id: currentUser.id },
          select: { isBanned: true, emailVerifiedAt: true },
        }),
        tx.matchTeam.findUnique({
          where: { id: teamId },
          select: {
            matchId: true,
            name: true,
            captainId: true,
            status: true,
            members: {
              select: {
                userId: true,
                user: { select: { isBanned: true } },
              },
            },
          },
        }),
      ])
      if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
        return { ok: false as const, error: '请先登录。' }
      }
      if (!team || team.matchId !== binding.matchId) {
        return { ok: false as const, error: '队伍不存在。' }
      }
      if (team.captainId !== currentUser.id) {
        return { ok: false as const, error: '只有队长可以提交报名。' }
      }

      const open = assertTeamRegistrationOpen(lockedMatch.match)
      if (!open.ok) return { ok: false as const, error: open.error }
      if (!canEditTeamStatus(team.status)) {
        return { ok: false as const, error: '当前队伍状态不可提交。' }
      }

      const memberCount = team.members.length
      const minMembers = lockedMatch.match.teamMinMembers ?? DEFAULT_TEAM_MIN_MEMBERS
      const maxMembers = lockedMatch.match.teamMaxMembers ?? DEFAULT_TEAM_MAX_MEMBERS
      if (team.members.some((member) => member.user.isBanned)) {
        return { ok: false as const, error: '队伍中存在已封禁用户，无法提交报名。' }
      }
      if (memberCount < minMembers) {
        return { ok: false as const, error: `队伍人数不足，至少需要 ${minMembers} 人。` }
      }
      if (memberCount > maxMembers) {
        return { ok: false as const, error: `队伍人数超过上限 ${maxMembers} 人。` }
      }

      await tx.matchTeam.update({
        where: { id: teamId },
        data: {
          status: TeamRegistrationStatus.approved,
          submittedAt: new Date(),
          reviewNote: null,
        },
      })
      await tx.auditLog.create({
        data: {
          actorId: currentUser.id,
          action: 'match.team.submit',
          entityType: 'MatchTeam',
          entityId: teamId,
          details: {
            targetLabel: `${lockedMatch.match.title} / ${team.name}`,
            matchId: binding.matchId,
            matchTitle: lockedMatch.match.title,
            teamName: team.name,
            memberCount,
          },
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
        },
      })

      if (v2Context) {
        await reconcileV2TeamEntryRegistrationInTransaction(tx, v2Context)
      }

      return { ok: true as const, matchId: binding.matchId }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })
  } catch (error) {
    if (isRetryableTeamSourceConflict(error)) {
      return { error: TEAM_SOURCE_CHANGED_MESSAGE }
    }
    console.error('submitMatchTeamAction failed', error)
    return { error: '提交队伍报名失败，请稍后重试。' }
  }

  if (!submissionResult.ok) return { error: submissionResult.error }

  revalidateTeamRegistrationViews(submissionResult.matchId)
  return { success: '队伍人数已达标，已自动报名成功。' }
}

export async function cancelMatchTeamAction(teamId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  // This read only discovers the Match aggregate lock key. Authorization and
  // every mutable business decision are repeated below after the locks.
  const binding = await prisma.matchTeam.findUnique({
    where: { id: teamId },
    select: {
      matchId: true,
      match: { select: { engineVersion: true } },
    },
  })
  if (!binding) return { error: '队伍不存在。' }

  const auditContext = await getAuditContext()
  type CancellationResult =
    | { ok: false; error: string }
    | { ok: true; matchId: string; isAdmin: boolean }

  let cancellationResult: CancellationResult
  if (binding.match.engineVersion === MatchEngineVersion.V2) {
    try {
      cancellationResult = await prisma.$transaction(
        async (tx): Promise<CancellationResult> => {
          const context = await lockV2TeamEntryRegistrationContext(tx, {
            matchId: binding.matchId,
            teamId,
            additionalUserIds: [currentUser.id],
          })
          const [actor, match, team, entry, fixtureCount] = await Promise.all([
            tx.user.findUnique({
              where: { id: currentUser.id },
              select: { role: true, isBanned: true, emailVerifiedAt: true },
            }),
            tx.match.findUnique({
              where: { id: binding.matchId },
              select: {
                id: true,
                title: true,
                status: true,
                engineVersion: true,
                isQuickMatch: true,
                type: true,
                groupingGeneratedAt: true,
              },
            }),
            tx.matchTeam.findFirst({
              where: { id: teamId, matchId: binding.matchId },
              select: { id: true, name: true, captainId: true, status: true },
            }),
            tx.matchEntry.findUnique({
              where: {
                matchId_sourceMatchTeamId: {
                  matchId: binding.matchId,
                  sourceMatchTeamId: teamId,
                },
              },
              select: { id: true, kind: true, status: true, version: true },
            }),
            tx.matchFixture.count({ where: { matchId: binding.matchId } }),
          ])
          if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
            return { ok: false, error: '请先登录。' }
          }
          if (
            !match ||
            match.id !== context.match.id ||
            match.engineVersion !== MatchEngineVersion.V2 ||
            match.isQuickMatch ||
            match.type !== MatchType.team ||
            !team
          ) {
            return { ok: false, error: '队伍或比赛状态已发生变化，请重试。' }
          }
          const isCaptain = team.captainId === currentUser.id
          const isAdmin = actor.role === 'admin'
          if (!isCaptain && !isAdmin) {
            return { ok: false, error: '只有队长或管理员可以解散队伍。' }
          }
          if (team.status === TeamRegistrationStatus.cancelled) {
            return { ok: false, error: '队伍已取消。' }
          }
          if (
            match.status === MatchStatus.finished ||
            match.groupingGeneratedAt !== null ||
            fixtureCount !== 0
          ) {
            return {
              ok: false,
              error: '分组发布后不能解散队伍，请联系比赛管理员执行取消资格。',
            }
          }
          if (entry) {
            if (
              entry.kind !== 'TEAM' ||
              (entry.status !== 'ACTIVE' && entry.status !== 'DRAFT')
            ) {
              return { ok: false, error: '队伍的 V2 参赛身份状态异常。' }
            }
            await transitionV2EntryStatusInTransaction(tx, {
              actor: { id: currentUser.id, role: actor.role },
              matchId: binding.matchId,
              entryId: entry.id,
              expectedVersion: entry.version,
              to: 'WITHDRAWN',
              ...(isAdmin && !isCaptain
                ? {
                    adminOverride: true,
                    overrideReason: '管理员在分组发布前解散团体队伍',
                  }
                : {}),
            })
          }
          const cancelled = await tx.matchTeam.updateMany({
            where: {
              id: team.id,
              matchId: binding.matchId,
              status: team.status,
            },
            data: {
              status: TeamRegistrationStatus.cancelled,
              submittedAt: null,
              reviewNote: 'V2 分组发布前解散',
            },
          })
          if (cancelled.count !== 1) {
            return { ok: false, error: '队伍状态已发生变化，请重试。' }
          }
          await tx.auditLog.create({
            data: {
              actorId: currentUser.id,
              action: 'v2_team_dissolve_before_grouping',
              entityType: 'MatchTeam',
              entityId: team.id,
              details: {
                targetLabel: `${match.title} / ${team.name}`,
                matchId: match.id,
                matchTitle: match.title,
                teamName: team.name,
                entryId: entry?.id ?? null,
                byAdmin: isAdmin,
              },
              ip: auditContext.ip,
              userAgent: auditContext.userAgent,
            },
          })
          return { ok: true, matchId: match.id, isAdmin }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      )
    } catch (error) {
      if (isRetryableTeamSourceConflict(error)) {
        return { error: TEAM_SOURCE_CHANGED_MESSAGE }
      }
      console.error('cancelMatchTeamAction V2 failed', error)
      return { error: '解散队伍失败，请稍后重试。' }
    }

    if (!cancellationResult.ok) return { error: cancellationResult.error }
    revalidateTeamRegistrationViews(cancellationResult.matchId)
    return { success: cancellationResult.isAdmin ? '队伍已取消并保留历史。' : '队伍已解散并退出报名。' }
  }

  return { error: '历史比赛已归档，不能修改报名。' }

}

export async function adminUpdateMatchTeamStatusAction(teamId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser || currentUser.role !== 'admin') return { error: '仅管理员可审核队伍。' }
  void teamId
  return { error: '团体赛报名按人数自动生效，无需管理员审核。管理员如需处理异常，请删除队伍。' }
}

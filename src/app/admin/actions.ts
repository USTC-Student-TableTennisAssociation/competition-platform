'use server'

import { getAuditContext,writeAuditLog } from '@/lib/audit-log'
import { getCurrentUser } from '@/lib/auth'
import { sendAzureEmail } from '@/lib/azure-email'
import { validateCsrfToken } from '@/lib/csrf'
import { hashPassword } from '@/lib/password'
import { prisma } from '@/lib/prisma'
import { lockMatchForEngine } from '@/lib/server/match/engine-guard'
import { deliverNotificationOutboxItems } from '@/lib/server/notification/outbox'
import { lockAdminRoleChangeMutex } from '@/lib/server/user/admin-role-mutex'
import { setUserBanState,setUsersBanState } from '@/lib/server/user/ban-user'
import {
getHardDeleteUsersBlockedMessage,
hardDeleteUsersWithoutBusinessHistory,
} from '@/lib/server/user/hard-delete-users'
import { lockUsersForUpdate } from '@/lib/server/user/lock-users'
import { shouldUseSecureCookies } from '@/lib/session'
import { createV2EntryInTransaction } from '@/modules/competitions-v2/application/entries'
import {
resolveAdminBulkRegistrationPolicy,
resolveMatchListRegistrationSummary,
} from '@/modules/competitions-v2/read-model/match-list-registration'
import { MatchStatus,TeamRegistrationStatus } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createHash,createHmac,randomBytes,randomInt,timingSafeEqual } from 'node:crypto'

const ADMIN_REAUTH_COOKIE = 'ustc_tta_admin_reauth'
const ADMIN_EMAIL_CHALLENGE_COOKIE = 'ustc_tta_admin_email_challenge'
const ADMIN_TRUSTED_DEVICE_COOKIE = 'ustc_tta_admin_trusted_device'
const ADMIN_REAUTH_TTL_SECONDS = 60 * 30
const ADMIN_EMAIL_CHALLENGE_TTL_SECONDS = 60 * 10
const ADMIN_TRUSTED_DEVICE_TTL_SECONDS = 60 * 60 * 24 * 7
const USTC_MAIL_SUFFIX = '@mail.ustc.edu.cn'

export type AdminDashboardUser = {
  id: string
  email: string
  nickname: string
  bio: string | null
  avatarUrl: string | null
  role: 'user' | 'admin'
  isBanned: boolean
  createdAt: string
  lastActivityAt: string
}

export type AdminDashboardMatch = {
  id: string
  title: string
  status: string
  engineVersion: 'LEGACY' | 'V2'
  isQuickMatch: boolean
  type: 'single' | 'double' | 'team'
  format: 'group_only' | 'group_then_knockout'
  dateTime: string
  registrationDeadline: string
  currentParticipants: number
  participantUnit: 'people' | 'pairs' | 'teams'
  canBulkRegister: boolean
  bulkRegisterDisabledReason: string | null
}

export type AdminDashboardAuditLog = {
  id: string
  action: string
  entityType: string
  entityId: string
  ip?: string | null
  userAgent?: string | null
  createdAt: string
  actor?: {
    id: string
    nickname: string
    email: string
  } | null
  details?: Record<string, unknown> | null
}

export type AdminDashboardState = {
  unlocked: boolean
  error?: string
  success?: string
  users: AdminDashboardUser[]
  matches: AdminDashboardMatch[]
  auditLogs: AdminDashboardAuditLog[]
  siteClosed: boolean
  createdTestAccounts?: string[]
}

type AdminDashboardUserRow = {
  id: string
  email: string
  nickname: string
  bio: string | null
  avatarUrl: string | null
  role: 'user' | 'admin'
  isBanned: boolean
  createdAt: Date
  updatedAt: Date
  registrations: Array<{ createdAt: Date }>
  reportedResults: Array<{ createdAt: Date }>
  resultRevisionsReported: Array<{ createdAt: Date }>
  createdMatches: Array<{ createdAt: Date }>
}

type AdminDashboardMatchRow = {
  id: string
  title: string
  type: 'single' | 'double' | 'team'
  status: MatchStatus
  engineVersion: 'LEGACY' | 'V2'
  isQuickMatch: boolean
  format: 'group_only' | 'group_then_knockout'
  groupingGeneratedAt: Date | null
  groupingResult: { payload: unknown } | null
  results: Array<{
    winnerTeamIds: string[]
    loserTeamIds: string[]
    confirmed: boolean
    score: unknown
    createdAt: Date
    resultVerifiedAt: Date | null
  }>
  dateTime: Date
  registrationDeadline: Date
  _count: {
    registrations: number
    entries: number
  }
  teamRegistrations: Array<{ id: string }>
}

type AdminEditableUserRow = {
  id: string
  role: 'user' | 'admin'
}



const INITIAL_ADMIN_DASHBOARD_STATE: AdminDashboardState = {
  unlocked: false,
  users: [],
  matches: [],
  auditLogs: [],
  siteClosed: false,
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function getBaseUrl() {
  const fallback =
    process.env.NODE_ENV === 'production'
      ? 'https://kedappclub.xyz'
      : 'http://localhost:3000'
  return process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? fallback
}

async function sendAdminReauthEmail(email: string, nickname: string, code: string) {
  await sendAzureEmail({
    to: email,
    subject: 'USTC TTA 管理员二次验证',
    html: `
      <div style="font-family: Arial, sans-serif;line-height:1.7;">
        <h2>你好，${nickname}</h2>
        <p>你正在进行 USTC TTA 管理员控制台二次验证。</p>
        <p>验证码为：</p>
        <p style="font-size:24px;font-weight:700;letter-spacing:4px;">${code}</p>
        <p>验证码 ${Math.floor(ADMIN_EMAIL_CHALLENGE_TTL_SECONDS / 60)} 分钟内有效，请勿泄露给他人。</p>
        <p>若非本人操作，请忽略此邮件并尽快修改账号密码。</p>
        <p style="color:#64748b;font-size:12px;">来源：${getBaseUrl()}</p>
      </div>
    `,
    context: 'sendAdminReauthEmail',
    fallbackMessage: '管理员验证邮件发送失败，请稍后重试。',
  })
}

function getReauthSecret() {
  const secret = process.env.ADMIN_REAUTH_SECRET ?? process.env.AUTH_SECRET
  if (!secret) {
    throw new Error('缺少 ADMIN_REAUTH_SECRET 或 AUTH_SECRET，无法进行管理员二次验证。')
  }
  return secret
}

function signReauthValue(userId: string, expiresAtMs: number) {
  const payload = `${userId}.${expiresAtMs}`
  const sig = createHmac('sha256', getReauthSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function signEmailChallengeValue(userId: string, codeHash: string, expiresAtMs: number) {
  const payload = `${userId}.${codeHash}.${expiresAtMs}`
  const sig = createHmac('sha256', getReauthSecret()).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function verifyReauthValue(rawValue: string, userId: string) {
  const [cookieUserId, expiresAtRaw, sig] = rawValue.split('.')
  if (!cookieUserId || !expiresAtRaw || !sig) return false
  if (cookieUserId !== userId) return false

  const expiresAt = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false

  const payload = `${cookieUserId}.${expiresAt}`
  const expectedSig = createHmac('sha256', getReauthSecret()).update(payload).digest('hex')
  const sigBuffer = Buffer.from(sig, 'hex')
  const expectedBuffer = Buffer.from(expectedSig, 'hex')

  if (sigBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(sigBuffer, expectedBuffer)
}

function parseEmailChallengeValue(rawValue: string, userId: string) {
  const [cookieUserId, codeHash, expiresAtRaw, sig] = rawValue.split('.')
  if (!cookieUserId || !codeHash || !expiresAtRaw || !sig) return null
  if (cookieUserId !== userId) return null

  const expiresAt = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null

  const payload = `${cookieUserId}.${codeHash}.${expiresAt}`
  const expectedSig = createHmac('sha256', getReauthSecret()).update(payload).digest('hex')
  const sigBuffer = Buffer.from(sig, 'hex')
  const expectedBuffer = Buffer.from(expectedSig, 'hex')
  if (sigBuffer.length !== expectedBuffer.length) return null
  if (!timingSafeEqual(sigBuffer, expectedBuffer)) return null

  return {
    codeHash,
    expiresAt,
  }
}

async function getAdminIdentity() {
  const currentUser = await getCurrentUser()
  if (!currentUser || currentUser.role !== 'admin') {
    return { ok: false as const, error: '仅管理员可访问该页面。' }
  }
  return { ok: true as const, userId: currentUser.id }
}

async function isAdminReauthed(userId: string) {
  const cookieStore = await cookies()
  const raw = cookieStore.get(ADMIN_REAUTH_COOKIE)?.value
  if (raw && verifyReauthValue(raw, userId)) return true

  const rawTrustedToken = cookieStore.get(ADMIN_TRUSTED_DEVICE_COOKIE)?.value
  if (!rawTrustedToken) return false
  if (!/^[0-9a-f]{64}$/i.test(rawTrustedToken)) return false

  const now = new Date()
  const tokenHash = hashToken(rawTrustedToken.toLowerCase())
  const record = await prisma.adminTrustedDevice.findFirst({
    where: {
      userId,
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true },
  })

  if (!record) return false

  prisma.adminTrustedDevice
    .update({
      where: { id: record.id },
      data: { lastUsedAt: now },
    })
    .catch(() => {})

  return true
}

async function issueAdminReauth(userId: string) {
  const cookieStore = await cookies()
  const expiresAt = Date.now() + ADMIN_REAUTH_TTL_SECONDS * 1000
  cookieStore.set(ADMIN_REAUTH_COOKIE, signReauthValue(userId, expiresAt), {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/admin',
    maxAge: ADMIN_REAUTH_TTL_SECONDS,
  })
}

async function clearAdminEmailChallengeCookie() {
  const cookieStore = await cookies()
  cookieStore.delete(ADMIN_EMAIL_CHALLENGE_COOKIE)
}

async function issueAdminTrustedDevice(userId: string) {
  const rawToken = randomBytes(32).toString('hex')
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + ADMIN_TRUSTED_DEVICE_TTL_SECONDS * 1000)

  await prisma.adminTrustedDevice.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  })

  const cookieStore = await cookies()
  cookieStore.set(ADMIN_TRUSTED_DEVICE_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/admin',
    maxAge: ADMIN_TRUSTED_DEVICE_TTL_SECONDS,
  })
}

async function issueAdminEmailChallenge(user: { id: string; email: string; nickname: string }) {
  const code = String(randomInt(100000, 1000000))
  const codeHash = hashToken(code)
  const expiresAt = Date.now() + ADMIN_EMAIL_CHALLENGE_TTL_SECONDS * 1000

  const cookieStore = await cookies()
  cookieStore.set(
    ADMIN_EMAIL_CHALLENGE_COOKIE,
    signEmailChallengeValue(user.id, codeHash, expiresAt),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: shouldUseSecureCookies(),
      path: '/admin',
      maxAge: ADMIN_EMAIL_CHALLENGE_TTL_SECONDS,
    },
  )

  await sendAdminReauthEmail(user.email, user.nickname, code)
}

async function fetchAdminDashboardData() {
  const [users, matches, auditLogs] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        nickname: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isBanned: true,
        createdAt: true,
        updatedAt: true,
        registrations: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        },
        reportedResults: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        },
        resultRevisionsReported: {
          where: {
            fixture: {
              stage: { in: ['GROUP', 'KNOCKOUT'] },
              match: {
                engineVersion: 'V2',
                isQuickMatch: false,
              },
            },
          },
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        },
        createdMatches: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        },
      },
    }),
    prisma.match.findMany({
      orderBy: { dateTime: 'desc' },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        engineVersion: true,
        isQuickMatch: true,
        format: true,
        groupingGeneratedAt: true,
        groupingResult: { select: { payload: true } },
        results: {
          where: { confirmed: true },
          select: {
            winnerTeamIds: true,
            loserTeamIds: true,
            confirmed: true,
            score: true,
            createdAt: true,
            resultVerifiedAt: true,
          },
        },
        dateTime: true,
        registrationDeadline: true,
        _count: {
          select: {
            registrations: { where: { user: { isBanned: false } } },
            entries: {
              where: { status: 'ACTIVE' },
            },
          },
        },
        teamRegistrations: {
          where: {
            status: TeamRegistrationStatus.approved,
            captain: { isBanned: false },
            members: { every: { user: { isBanned: false } } },
          },
          select: { id: true },
        },
      },
      take: 200,
    }),
    prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        details: true,
        actor: {
          select: { id: true, nickname: true, email: true },
        },
      },
    }),
  ])

  let siteClosed = false
  try {
    const siteSetting = await prisma.siteSetting.findUnique({
      where: { id: 1 },
      select: { isClosed: true },
    })
    siteClosed = siteSetting?.isClosed ?? false
  } catch (error) {
    console.error('fetchAdminDashboardData siteSetting failed', error)
  }

  const mappedUsers: AdminDashboardUser[] = users.map((user: AdminDashboardUserRow) => {
    const lastActivityCandidates = [
      user.updatedAt,
      user.registrations[0]?.createdAt,
      user.reportedResults[0]?.createdAt,
      user.resultRevisionsReported[0]?.createdAt,
      user.createdMatches[0]?.createdAt,
    ].filter((value): value is Date => Boolean(value))

    const lastActivityAt = new Date(
      Math.max(...lastActivityCandidates.map((date) => date.getTime())),
    )

    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      role: user.role,
      isBanned: user.isBanned,
      createdAt: user.createdAt.toISOString(),
      lastActivityAt: lastActivityAt.toISOString(),
    }
  })

  const mappedMatches: AdminDashboardMatch[] = matches.map((match: AdminDashboardMatchRow) => {
    const identity = {
      engineVersion: match.engineVersion,
      isQuickMatch: match.isQuickMatch,
      type: match.type,
      format: match.format,
    }
    const registrationSummary = resolveMatchListRegistrationSummary({
      ...identity,
      legacyParticipantCount:
        match.type === 'team' ? match.teamRegistrations.length : match._count.registrations,
      legacyCurrentUserRegistered: false,
      activeEntryCount: match._count.entries,
      currentUserActiveEntryKinds: [],
    })
    const bulkRegistrationPolicy = resolveAdminBulkRegistrationPolicy({
      ...identity,
      status: match.status,
      groupingGeneratedAt: match.groupingGeneratedAt,
    })

    return {
      id: match.id,
      title: match.title,
      engineVersion: match.engineVersion,
      isQuickMatch: match.isQuickMatch,
      type: match.type,
      format: match.format,
      status: match.engineVersion === 'LEGACY' ? MatchStatus.finished : match.status,
      dateTime: match.dateTime.toISOString(),
      registrationDeadline: match.registrationDeadline.toISOString(),
      currentParticipants: registrationSummary.participants,
      participantUnit: registrationSummary.participantUnit,
      canBulkRegister: bulkRegistrationPolicy.canBulkRegister,
      bulkRegisterDisabledReason: bulkRegistrationPolicy.disabledReason,
    }
  })

  const mappedAuditLogs: AdminDashboardAuditLog[] = auditLogs.map((log) => ({
    id: log.id,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    ip: log.ip,
    userAgent: log.userAgent,
    createdAt: log.createdAt.toISOString(),
    actor: log.actor,
    details:
      typeof log.details === 'object' && log.details ? (log.details as Record<string, unknown>) : null,
  }))

  return {
    users: mappedUsers,
    matches: mappedMatches,
    auditLogs: mappedAuditLogs,
    siteClosed,
  }
}

function splitEmails(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;\n\r]+/)
        .map((item: string) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  )
}

function splitSelectedUserIds(raw: string) {
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((item: string) => item.trim())
        .filter(Boolean),
    ),
  )
}

function summarizeTargets(items: Array<{ id: string; label: string }>) {
  const labels = items.map((item) => item.label).filter(Boolean)
  return {
    count: items.length,
    labels: labels.slice(0, 5),
  }
}

export async function adminDashboardAction(
  prev: AdminDashboardState,
  formData: FormData,
): Promise<AdminDashboardState> {
  const intent = String(formData.get('intent') ?? '')

  if (intent === 'bootstrap') {
    const admin = await getAdminIdentity()
    if (!admin.ok) {
      return {
        ...INITIAL_ADMIN_DASHBOARD_STATE,
        error: admin.error,
      }
    }

    const reauthed = await isAdminReauthed(admin.userId)
    if (!reauthed) {
      return {
        ...INITIAL_ADMIN_DASHBOARD_STATE,
      }
    }

    const data = await fetchAdminDashboardData()
    return {
      unlocked: true,
      users: data.users,
      matches: data.matches,
      auditLogs: data.auditLogs,
      siteClosed: data.siteClosed,
    }
  }

  const csrfError = await validateCsrfToken(formData)
  if (csrfError) {
    return {
      ...INITIAL_ADMIN_DASHBOARD_STATE,
      error: csrfError,
    }
  }

  const admin = await getAdminIdentity()
  if (!admin.ok) {
    return {
      ...INITIAL_ADMIN_DASHBOARD_STATE,
      error: admin.error,
    }
  }

  const auditContext = await getAuditContext()

  if (intent === 'sendEmailChallenge') {
    const adminRecord = await prisma.user.findUnique({
      where: { id: admin.userId },
      select: {
        id: true,
        email: true,
        nickname: true,
        emailVerifiedAt: true,
      },
    })

    if (!adminRecord) {
      return {
        ...prev,
        unlocked: false,
        error: '管理员账号不存在，请重新登录后重试。',
      }
    }

    if (!adminRecord.emailVerifiedAt) {
      return {
        ...prev,
        unlocked: false,
        error: '管理员账号邮箱未验证，无法进行邮箱二次验证。',
      }
    }

    try {
      await issueAdminEmailChallenge(adminRecord)
    } catch (error) {
      console.error('adminDashboardAction issueAdminEmailChallenge failed', error)
      return {
        ...prev,
        unlocked: false,
        error: '验证邮件发送失败，请稍后重试。',
      }
    }

    return {
      ...prev,
      unlocked: false,
      success: '验证码已发送至管理员邮箱，请输入 6 位验证码完成二次验证。',
      error: undefined,
    }
  }

  if (intent === 'reauth') {
    const code = String(formData.get('code') ?? '').trim()
    const trustDevice = String(formData.get('trustDevice') ?? '') === 'true'
    if (!/^\d{6}$/.test(code)) {
      return {
        ...prev,
        unlocked: false,
        error: '请输入 6 位邮箱验证码。',
      }
    }

    const cookieStore = await cookies()
    const rawChallenge = cookieStore.get(ADMIN_EMAIL_CHALLENGE_COOKIE)?.value
    if (!rawChallenge) {
      return {
        ...prev,
        unlocked: false,
        error: '邮箱验证码不存在或已过期，请先发送验证码。',
      }
    }

    const challenge = parseEmailChallengeValue(rawChallenge, admin.userId)
    if (!challenge) {
      await clearAdminEmailChallengeCookie()
      return {
        ...prev,
        unlocked: false,
        error: '邮箱验证码已失效，请重新发送。',
      }
    }

    const incomingHash = hashToken(code)
    if (!timingSafeEqual(Buffer.from(incomingHash), Buffer.from(challenge.codeHash))) {
      return {
        ...prev,
        unlocked: false,
        error: '邮箱验证码错误，请重试。',
      }
    }

    await issueAdminReauth(admin.userId)

    await writeAuditLog({
      actorId: admin.userId,
      action: 'admin.reauth',
      entityType: 'AdminAuth',
      entityId: admin.userId,
      details: { trustDevice },
      ip: auditContext.ip,
      userAgent: auditContext.userAgent,
    })

    let success = '邮箱二次认证通过，已解锁管理员能力。'
    if (trustDevice) {
      try {
        await issueAdminTrustedDevice(admin.userId)
        success = '邮箱二次认证通过，已信任此设备 7 天。'
      } catch (error) {
        console.error('issueAdminTrustedDevice failed', error)
        success = '邮箱二次认证通过，但信任设备设置失败（可正常使用本次解锁）。'
      }
    }
    await clearAdminEmailChallengeCookie()
    const data = await fetchAdminDashboardData()

    return {
      unlocked: true,
      success,
      users: data.users,
      matches: data.matches,
      auditLogs: data.auditLogs,
      siteClosed: data.siteClosed,
    }
  }

  const reauthed = await isAdminReauthed(admin.userId)
  if (!reauthed) {
    return {
      ...INITIAL_ADMIN_DASHBOARD_STATE,
      error: '管理员二次认证已失效，请重新验证后再操作。',
    }
  }

  const affectedMatchIds = new Set<string>()
  const notificationOutboxIds = new Set<string>()

  try {
    if (intent === 'toggleBan') {
      const userId = String(formData.get('userId') ?? '')
      const banned = String(formData.get('banned') ?? '') === 'true'

      if (!userId) throw new Error('缺少用户 ID。')
      if (banned && userId === admin.userId) {
        throw new Error('不能封禁当前管理员自己。')
      }

      const result = await prisma.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId,
            banned,
            actorId: admin.userId,
            auditContext,
          }),
        {
          isolationLevel: 'Serializable',
          maxWait: 5_000,
          timeout: 30_000,
        },
      )
      result.removedMatches.forEach((match) => {
        affectedMatchIds.add(match.id)
      })
      result.v2CorrectionCleanups.forEach((effect) => {
        affectedMatchIds.add(effect.matchId)
      })
      if (result.notificationOutboxId) {
        notificationOutboxIds.add(result.notificationOutboxId)
      }
    }

    if (intent === 'bulkToggleBan') {
      const selectedUserIdsRaw = String(formData.get('selectedUserIds') ?? '')
      const selectedUserIds = splitSelectedUserIds(selectedUserIdsRaw)
      const banned = String(formData.get('banned') ?? '') === 'true'

      if (selectedUserIds.length === 0) {
        throw new Error('请先选择要操作的用户。')
      }

      const targets = await prisma.user.findMany({
        where: {
          id: { in: selectedUserIds },
        },
        select: {
          id: true,
          role: true,
          nickname: true,
          email: true,
        },
      })

      const protectedIds = new Set<string>()
      if (banned) {
        protectedIds.add(admin.userId)
        targets.forEach((target: AdminEditableUserRow) => {
          if (target.role === 'admin') {
            protectedIds.add(target.id)
          }
        })
      }

      const editableIds = selectedUserIds
        .filter((id: string) => !protectedIds.has(id))
        .sort()
      if (editableIds.length === 0) {
        throw new Error('未找到可操作用户（管理员账号不可批量封禁）。')
      }

      const summary = summarizeTargets(
        targets
          .filter((target) => editableIds.includes(target.id))
          .map((target) => ({
            id: target.id,
            label: `${target.nickname} (${target.email})`,
          })),
      )

      const results = await prisma.$transaction(
        async (tx) => {
          const changed = await setUsersBanState(tx, {
            userIds: editableIds,
            banned,
            actorId: admin.userId,
            auditContext,
          })

          await tx.auditLog.create({
            data: {
              actorId: admin.userId,
              action: banned ? 'user.bulk.ban' : 'user.bulk.unban',
              entityType: 'User',
              entityId: 'bulk',
              details: {
                banned,
                count: editableIds.length,
                userIds: editableIds,
                targetLabels: summary.labels,
              },
              ip: auditContext.ip,
              userAgent: auditContext.userAgent,
            },
          })

          return changed
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 5_000,
          timeout: 30_000,
        },
      )
      results.forEach((result) => {
        result.removedMatches.forEach((match) => affectedMatchIds.add(match.id))
        result.v2CorrectionCleanups.forEach((effect) => {
          affectedMatchIds.add(effect.matchId)
        })
        if (result.notificationOutboxId) {
          notificationOutboxIds.add(result.notificationOutboxId)
        }
      })
    }

    if (intent === 'deleteUser') {
      const userId = String(formData.get('userId') ?? '')
      if (!userId) throw new Error('缺少用户 ID。')

      await prisma.$transaction(
        (tx) =>
          hardDeleteUsersWithoutBusinessHistory(tx, {
            actorId: admin.userId,
            userIds: [userId],
            mode: 'single',
            auditContext,
          }),
        { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 },
      )
    }

    if (intent === 'bulkDeleteUsers') {
      const selectedUserIdsRaw = String(formData.get('selectedUserIds') ?? '')
      const selectedUserIds = splitSelectedUserIds(selectedUserIdsRaw)

      if (selectedUserIds.length === 0) {
        throw new Error('请先选择要删除的用户。')
      }

      await prisma.$transaction(
        (tx) =>
          hardDeleteUsersWithoutBusinessHistory(tx, {
            actorId: admin.userId,
            userIds: selectedUserIds,
            mode: 'bulk',
            auditContext,
          }),
        { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 },
      )
    }

    if (intent === 'updateUser') {
      const userId = String(formData.get('userId') ?? '')
      const nickname = String(formData.get('nickname') ?? '').trim()
      const avatarUrlRaw = String(formData.get('avatarUrl') ?? '').trim()

      if (!userId) throw new Error('缺少用户 ID。')
      if (!nickname) throw new Error('昵称不能为空。')

      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { nickname: true, email: true },
      })

      await prisma.user.update({
        where: { id: userId },
        data: {
          nickname,
          avatarUrl: avatarUrlRaw || null,
        },
      })

      await writeAuditLog({
        actorId: admin.userId,
        action: 'user.update',
        entityType: 'User',
        entityId: userId,
        details: {
          nickname,
          avatarUrl: avatarUrlRaw || null,
          targetLabel: target ? `${target.nickname} (${target.email})` : userId,
        },
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      })
    }

    if (intent === 'updateUserRole') {
      const userId = String(formData.get('userId') ?? '')
      const roleRaw = String(formData.get('role') ?? '')
      const role = roleRaw === 'admin' ? 'admin' : roleRaw === 'user' ? 'user' : null

      if (!userId) throw new Error('缺少用户 ID。')
      if (!role) throw new Error('用户角色不合法。')
      if (userId === admin.userId && role !== 'admin') {
        throw new Error('不能取消自己的管理员权限。')
      }

      await prisma.$transaction(
        async (tx) => {
          // Every role change takes the same transaction-scoped mutex. This
          // serializes the "last administrator" check without a schema change.
          await lockAdminRoleChangeMutex(tx)
          await lockUsersForUpdate(tx, [admin.userId, userId])

          const [actor, target] = await Promise.all([
            tx.user.findUnique({
              where: { id: admin.userId },
              select: { role: true, isBanned: true, emailVerifiedAt: true },
            }),
            tx.user.findUnique({
              where: { id: userId },
              select: { role: true, nickname: true, email: true },
            }),
          ])

          if (
            !actor ||
            actor.role !== 'admin' ||
            actor.isBanned ||
            !actor.emailVerifiedAt
          ) {
            throw new Error('管理员权限已发生变化，请重新登录后重试。')
          }
          if (!target) throw new Error('用户不存在。')
          if (userId === admin.userId && role !== 'admin') {
            throw new Error('不能取消自己的管理员权限。')
          }

          if (target.role === 'admin' && role === 'user') {
            const otherAdminCount = await tx.user.count({
              where: {
                role: 'admin',
                id: { not: userId },
              },
            })
            if (otherAdminCount === 0) {
              throw new Error('至少保留一个管理员账号。')
            }
          }

          if (target.role === role) return

          await tx.user.update({
            where: { id: userId },
            data: { role },
          })
          await tx.auditLog.create({
            data: {
              actorId: admin.userId,
              action: 'user.role.change',
              entityType: 'User',
              entityId: userId,
              details: {
                from: target.role,
                to: role,
                targetLabel: `${target.nickname} (${target.email})`,
              },
              ip: auditContext.ip,
              userAgent: auditContext.userAgent,
            },
          })
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 5_000,
          timeout: 30_000,
        },
      )
    }

    let createdTestAccounts: string[] | undefined

    if (intent === 'createTestAccounts') {
      const prefixRaw = String(formData.get('prefix') ?? 'test').trim()
      const prefix = prefixRaw.replace(/[^a-zA-Z0-9_-]/g, '') || 'test'
      const count = Number(formData.get('count') ?? 0)
      const password = String(formData.get('password') ?? '')

      if (!Number.isInteger(count) || count < 1 || count > 200) {
        throw new Error('测试账号数量需为 1-200 的整数。')
      }
      if (password.length < 6) {
        throw new Error('测试账号密码至少 6 位。')
      }

      const created: string[] = []

      if (count === 1) {
        const email = `${prefix}${USTC_MAIL_SUFFIX}`.toLowerCase()
        const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
        if (existing) {
          throw new Error('测试账号邮箱已存在，请更换前缀后重试。')
        }

        await prisma.user.create({
          data: {
            email,
            nickname: `${prefix}_${email.split('@')[0]}`,
            hashedPassword: hashPassword(password),
            emailVerifiedAt: new Date(),
          },
        })

        created.push(email)
      } else {
        let seq = 1
        let attempts = 0

        while (created.length < count && attempts < count * 30) {
          attempts += 1
          const email = `${prefix}${seq}${USTC_MAIL_SUFFIX}`.toLowerCase()
          seq += 1

          const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
          if (existing) continue

          await prisma.user.create({
            data: {
              email,
              nickname: `${prefix}_${email.split('@')[0]}`,
              hashedPassword: hashPassword(password),
              emailVerifiedAt: new Date(),
            },
          })

          created.push(email)
        }
      }

      if (created.length === 0) {
        throw new Error('未成功创建测试账号，请更换前缀或减少数量后重试。')
      }

      createdTestAccounts = created

      await writeAuditLog({
        actorId: admin.userId,
        action: 'user.test.create',
        entityType: 'User',
        entityId: 'bulk',
        details: { prefix, count: created.length, sample: created.slice(0, 5) },
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      })
    }

    if (intent === 'bulkRegisterMatch') {
      const matchId = String(formData.get('matchId') ?? '')
      const selectedUserIdsRaw = String(formData.get('selectedUserIds') ?? '')
      const selectedUserIds = splitSelectedUserIds(selectedUserIdsRaw)
      const emailsRaw = String(formData.get('emails') ?? '')
      const emails = splitEmails(emailsRaw)

      if (!matchId) throw new Error('请选择比赛。')
      if (selectedUserIds.length === 0 && emails.length === 0) {
        throw new Error('请至少选择一个用户。')
      }

      const { match, toRegister, createdCount } = await prisma.$transaction(
        async (tx) => {
          const matchIdentity = await tx.match.findUnique({
            where: { id: matchId },
            select: { engineVersion: true },
          })
          if (!matchIdentity) throw new Error('比赛不存在。')
          if (matchIdentity.engineVersion !== 'V2') throw new Error('历史比赛已归档，不能追加报名。')

          await lockMatchForEngine(tx, {
            matchId,
            expectedEngine: matchIdentity.engineVersion,
            expectedQuickMatch: false,
          })

          const lockedMatch = await tx.match.findUnique({
            where: { id: matchId },
            select: {
              id: true,
              title: true,
              type: true,
              engineVersion: true,
              status: true,
              groupingGeneratedAt: true,
            },
          })
          if (!lockedMatch) throw new Error('比赛不存在。')
          if (lockedMatch.type === 'double') {
            throw new Error('双打比赛请先完成组队邀请并由小队成员自行报名。')
          }
          if (lockedMatch.type === 'team') {
            throw new Error('团体赛请在比赛详情页通过队伍报名与审核管理。')
          }
          if (
            lockedMatch.engineVersion === 'V2' &&
            (lockedMatch.status !== 'registration' ||
              lockedMatch.groupingGeneratedAt !== null)
          ) {
            throw new Error('V2 比赛分组发布后不能追加报名。')
          }

          const candidates = selectedUserIds.length > 0
            ? await tx.user.findMany({
                where: { id: { in: selectedUserIds }, isBanned: false },
                select: { id: true },
              })
            : await tx.user.findMany({
                where: { email: { in: emails }, isBanned: false },
                select: { id: true },
              })

          await lockUsersForUpdate(tx, [
            admin.userId,
            ...candidates.map((user) => user.id),
          ])
          const lockedAdmin = await tx.user.findUnique({
            where: { id: admin.userId },
            select: { role: true, isBanned: true, emailVerifiedAt: true },
          })
          if (
            !lockedAdmin ||
            lockedAdmin.role !== 'admin' ||
            lockedAdmin.isBanned ||
            !lockedAdmin.emailVerifiedAt
          ) {
            throw new Error('管理员权限已发生变化，请重新登录后重试。')
          }

          const users = await tx.user.findMany({
            where: {
              id: { in: candidates.map((user) => user.id) },
              isBanned: false,
              ...(lockedMatch.engineVersion === 'V2'
                ? { emailVerifiedAt: { not: null } }
                : {}),
              ...(selectedUserIds.length > 0 ? {} : { email: { in: emails } }),
            },
            select: { id: true },
          })

          if (users.length === 0) {
            throw new Error('未找到可加入比赛的有效用户（可能不存在或已被封禁）。')
          }

          let createdCount = 0
          if (lockedMatch.engineVersion === 'V2') {
            for (const user of users) {
              const result = await createV2EntryInTransaction(tx, {
                actor: { id: admin.userId, role: 'admin' },
                matchId,
                kind: 'INDIVIDUAL',
                sourceId: user.id,
                status: 'ACTIVE',
                adminOverride: true,
                overrideReason: '管理员控制台批量代报名',
              })
              if (result.created) createdCount += 1
            }
          }

          return { match: lockedMatch, toRegister: users, createdCount }
        },
        {
          isolationLevel: 'Serializable',
          maxWait: 5_000,
          timeout: 30_000,
        },
      )

      await writeAuditLog({
        actorId: admin.userId,
        action: 'match.bulk.register',
        entityType: 'Match',
        entityId: matchId,
        details: {
          count: toRegister.length,
          createdCount,
          engineVersion: match.engineVersion,
          userIds: toRegister.map((u) => u.id),
          matchTitle: match.title,
          targetLabel: match.title,
        },
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      })

      createdTestAccounts = undefined

      const data = await fetchAdminDashboardData()

      return {
        unlocked: true,
        success: `操作成功，已尝试将 ${toRegister.length} 个用户加入所选比赛，新加入 ${createdCount} 人。`,
        users: data.users,
        matches: data.matches,
        auditLogs: data.auditLogs,
        siteClosed: data.siteClosed,
      }
    }

    if (intent === 'toggleSiteClosed') {
      const nextClosed = String(formData.get('closed') ?? '') === 'true'

      await prisma.siteSetting.upsert({
        where: { id: 1 },
        create: { id: 1, isClosed: nextClosed },
        update: { isClosed: nextClosed },
      })

      await writeAuditLog({
        actorId: admin.userId,
        action: nextClosed ? 'site.close' : 'site.open',
        entityType: 'SiteSetting',
        entityId: '1',
        details: { isClosed: nextClosed },
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      })
    }

    if (intent === 'toggleBan' || intent === 'bulkToggleBan') {
      if (notificationOutboxIds.size > 0) {
        await deliverNotificationOutboxItems([...notificationOutboxIds])
      }
      revalidatePath('/')
      revalidatePath('/matchs')
      revalidatePath('/rankings')
      revalidatePath('/team-invites')
      affectedMatchIds.forEach((matchId) => revalidatePath(`/matchs/${matchId}`))
    }

    const data = await fetchAdminDashboardData()

    return {
      unlocked: true,
      success:
        intent === 'createTestAccounts'
          ? `操作成功，已创建 ${createdTestAccounts?.length ?? 0} 个测试账号。`
          : '操作成功。',
      users: data.users,
      matches: data.matches,
      auditLogs: data.auditLogs,
      siteClosed: data.siteClosed,
      createdTestAccounts,
    }
  } catch (error) {
    const hardDeleteBlockedMessage = getHardDeleteUsersBlockedMessage(error)
    if (!hardDeleteBlockedMessage) {
      console.error('adminDashboardAction failed', error)
    }
    const data = await fetchAdminDashboardData()
    return {
      unlocked: true,
      error: hardDeleteBlockedMessage ?? '管理员操作失败，请重试。',
      users: data.users,
      matches: data.matches,
      auditLogs: data.auditLogs,
      siteClosed: data.siteClosed,
    }
  }
}

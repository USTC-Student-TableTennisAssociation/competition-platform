'use server'

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { MatchStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/lib/auth'
import { validateCsrfToken } from '@/lib/csrf'
import { hashPassword } from '@/lib/password'
import { shouldUseSecureCookies } from '@/lib/session'
import { sendAzureEmail } from '@/lib/azure-email'
import { getAuditContext, writeAuditLog } from '@/lib/audit-log'
import { isMatchAllResultsFinished } from '@/lib/match-status'

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
  dateTime: string
  registrationDeadline: string
  currentParticipants: number
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
  createdMatches: Array<{ createdAt: Date }>
}

type AdminDashboardMatchRow = {
  id: string
  title: string
  status: MatchStatus
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
  }
}

type AdminEditableUserRow = {
  id: string
  role: 'user' | 'admin'
}

type AdminRegisterUserRow = {
  id: string
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

  return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
}

function parseEmailChallengeValue(rawValue: string, userId: string) {
  const [cookieUserId, codeHash, expiresAtRaw, sig] = rawValue.split('.')
  if (!cookieUserId || !codeHash || !expiresAtRaw || !sig) return null
  if (cookieUserId !== userId) return null

  const expiresAt = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null

  const payload = `${cookieUserId}.${codeHash}.${expiresAt}`
  const expectedSig = createHmac('sha256', getReauthSecret()).update(payload).digest('hex')
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null

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
        status: true,
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
          select: { registrations: true },
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

  const matchesToFinish = matches.filter(
    (match: AdminDashboardMatchRow) =>
      match.status !== MatchStatus.finished &&
      isMatchAllResultsFinished({
        format: match.format,
        groupingGeneratedAt: match.groupingGeneratedAt,
        groupingResult: match.groupingResult,
        results: match.results,
      }),
  )

  if (matchesToFinish.length > 0) {
    await prisma.$transaction(
      matchesToFinish.map((match) =>
        prisma.match.update({
          where: { id: match.id },
          data: { status: MatchStatus.finished },
        }),
      ),
    )
  }

  const finishedMatchIds = new Set(matchesToFinish.map((match) => match.id))

  const mappedUsers: AdminDashboardUser[] = users.map((user: AdminDashboardUserRow) => {
    const lastActivityCandidates = [
      user.updatedAt,
      user.registrations[0]?.createdAt,
      user.reportedResults[0]?.createdAt,
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

  const mappedMatches: AdminDashboardMatch[] = matches.map((match: AdminDashboardMatchRow) => ({
    id: match.id,
    title: match.title,
    status: finishedMatchIds.has(match.id) ? MatchStatus.finished : match.status,
    dateTime: match.dateTime.toISOString(),
    registrationDeadline: match.registrationDeadline.toISOString(),
    currentParticipants: match._count.registrations,
  }))

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

  try {
    if (intent === 'toggleBan') {
      const userId = String(formData.get('userId') ?? '')
      const banned = String(formData.get('banned') ?? '') === 'true'

      if (!userId) throw new Error('缺少用户 ID。')
      if (userId === admin.userId) throw new Error('不能封禁当前管理员自己。')

      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { nickname: true, email: true },
      })

      await prisma.user.update({
        where: { id: userId },
        data: { isBanned: banned },
      })

      await writeAuditLog({
        actorId: admin.userId,
        action: banned ? 'user.ban' : 'user.unban',
        entityType: 'User',
        entityId: userId,
        details: {
          banned,
          targetLabel: target ? `${target.nickname} (${target.email})` : userId,
        },
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      })
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

      const protectedIds = new Set<string>([admin.userId])
      targets.forEach((target: AdminEditableUserRow) => {
        if (target.role === 'admin') {
          protectedIds.add(target.id)
        }
      })

      const editableIds = selectedUserIds.filter((id: string) => !protectedIds.has(id))
      if (editableIds.length === 0) {
        throw new Error('未找到可操作用户（管理员账号不可批量封禁）。')
      }

      await prisma.user.updateMany({
        where: {
          id: { in: editableIds },
        },
        data: {
          isBanned: banned,
        },
      })

      const summary = summarizeTargets(
        targets
          .filter((target) => editableIds.includes(target.id))
          .map((target) => ({
            id: target.id,
            label: `${target.nickname} (${target.email})`,
          })),
      )

      await writeAuditLog({
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
      })
    }

    if (intent === 'deleteUser') {
      const userId = String(formData.get('userId') ?? '')
      if (!userId) throw new Error('缺少用户 ID。')
      if (userId === admin.userId) throw new Error('不能删除当前管理员自己。')

      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, nickname: true, email: true },
      })

      if (target?.role === 'admin') {
        throw new Error('不允许直接删除管理员账号。')
      }

      await prisma.user.delete({ where: { id: userId } })

      await writeAuditLog({
        actorId: admin.userId,
        action: 'user.delete',
        entityType: 'User',
        entityId: userId,
        details: {
          targetLabel: target ? `${target.nickname} (${target.email})` : userId,
        },
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      })
    }

    if (intent === 'bulkDeleteUsers') {
      const selectedUserIdsRaw = String(formData.get('selectedUserIds') ?? '')
      const selectedUserIds = splitSelectedUserIds(selectedUserIdsRaw)

      if (selectedUserIds.length === 0) {
        throw new Error('请先选择要删除的用户。')
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

      const protectedIds = new Set<string>([admin.userId])
      targets.forEach((target: AdminEditableUserRow) => {
        if (target.role === 'admin') {
          protectedIds.add(target.id)
        }
      })

      const deletableIds = selectedUserIds.filter((id: string) => !protectedIds.has(id))
      if (deletableIds.length === 0) {
        throw new Error('未找到可删除用户（管理员账号不可批量删除）。')
      }

      await prisma.user.deleteMany({
        where: {
          id: { in: deletableIds },
        },
      })

      const summary = summarizeTargets(
        targets
          .filter((target) => deletableIds.includes(target.id))
          .map((target) => ({
            id: target.id,
            label: `${target.nickname} (${target.email})`,
          })),
      )

      await writeAuditLog({
        actorId: admin.userId,
        action: 'user.bulk.delete',
        entityType: 'User',
        entityId: 'bulk',
        details: {
          count: deletableIds.length,
          userIds: deletableIds,
          targetLabels: summary.labels,
        },
        ip: auditContext.ip,
        userAgent: auditContext.userAgent,
      })
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

      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, nickname: true, email: true },
      })

      if (!target) {
        throw new Error('用户不存在。')
      }

      if (target.role === 'admin' && role === 'user') {
        const otherAdminCount = await prisma.user.count({
          where: {
            role: 'admin',
            id: { not: userId },
          },
        })
        if (otherAdminCount === 0) {
          throw new Error('至少保留一个管理员账号。')
        }
      }

      if (target.role !== role) {
        await prisma.user.update({
          where: { id: userId },
          data: { role },
        })

        await writeAuditLog({
          actorId: admin.userId,
          action: 'user.role.change',
          entityType: 'User',
          entityId: userId,
          details: {
            from: target.role,
            to: role,
            targetLabel: target ? `${target.nickname} (${target.email})` : userId,
          },
          ip: auditContext.ip,
          userAgent: auditContext.userAgent,
        })
      }
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

      const match = await prisma.match.findUnique({
        where: { id: matchId },
        select: {
          id: true,
          title: true,
          type: true,
          _count: { select: { registrations: true } },
        },
      })

      if (!match) throw new Error('比赛不存在。')
      if (match.type === 'double') {
        throw new Error('双打比赛请先完成组队邀请并由小队成员自行报名。')
      }

      const users = selectedUserIds.length > 0
        ? await prisma.user.findMany({
            where: {
              id: { in: selectedUserIds },
              isBanned: false,
            },
            select: { id: true },
          })
        : await prisma.user.findMany({
            where: {
              email: { in: emails },
              isBanned: false,
            },
            select: { id: true },
          })

      if (users.length === 0) {
        throw new Error('未找到可加入比赛的有效用户（可能不存在或已被封禁）。')
      }

      const toRegister = users

      await prisma.registration.createMany({
        data: toRegister.map((user: AdminRegisterUserRow) => ({
          matchId,
          userId: user.id,
          status: 'registered',
          role: 'player',
        })),
        skipDuplicates: true,
      })

      await writeAuditLog({
        actorId: admin.userId,
        action: 'match.bulk.register',
        entityType: 'Match',
        entityId: matchId,
        details: {
          count: toRegister.length,
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
        success: `操作成功，已尝试将 ${toRegister.length} 个用户加入所选比赛。`,
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
    console.error('adminDashboardAction failed', error)
    const data = await fetchAdminDashboardData()
    return {
      unlocked: true,
      error: '管理员操作失败，请重试。',
      users: data.users,
      matches: data.matches,
      auditLogs: data.auditLogs,
      siteClosed: data.siteClosed,
    }
  }
}

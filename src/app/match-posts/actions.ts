'use server'

import {
  MatchApplicationStatus,
  MatchPostStatus,
  type Prisma,
} from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/lib/auth'
import { validateCsrfToken } from '@/lib/csrf'
import { isVenueOption } from '@/lib/locations'

export type MatchPostFormState = {
  error?: string
  success?: string
}

function parseLocalDateTimeInput(input: string, timezoneOffsetMinutes = 0) {
  const [date, timeWithSeconds] = input.split('T')
  const time = (timeWithSeconds ?? '').slice(0, 5)
  if (!date || !time) return new Date(NaN)

  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return new Date(NaN)
  }

  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, 0) +
    timezoneOffsetMinutes * 60 * 1000
  return new Date(utcMillis)
}

function parseOptionalInt(value: FormDataEntryValue | null) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed)) return NaN
  return parsed
}

function isPrismaKnownError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  )
}

export async function expireOpenMatchPosts() {
  await prisma.matchPost.updateMany({
    where: {
      status: MatchPostStatus.OPEN,
      playAt: { lt: new Date() },
    },
    data: { status: MatchPostStatus.EXPIRED },
  })
}

export async function createMatchPostAction(
  _: MatchPostFormState,
  formData: FormData,
): Promise<MatchPostFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后再发布约球。' }

  const description = String(formData.get('description') ?? '').trim()
  const playAtRaw = String(formData.get('playAt') ?? '').trim()
  const location = String(formData.get('location') ?? '').trim()
  const timezoneOffset = Number(formData.get('timezoneOffset') ?? 0)
  const durationMinutes = Number(formData.get('durationMinutes') ?? 0)
  const minElo = parseOptionalInt(formData.get('minElo'))
  const maxElo = parseOptionalInt(formData.get('maxElo'))
  const isRatedPreferred = formData.get('isRatedPreferred') === 'on'

  if (!description) return { error: '请填写约球简介。' }
  if (description.length > 300) return { error: '简介不能超过 300 字。' }
  if (!isVenueOption(location)) return { error: '请选择有效的约球地点。' }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 30 || durationMinutes > 240) {
    return { error: '时长需要在 30 到 240 分钟之间。' }
  }
  if (Number.isNaN(minElo) || Number.isNaN(maxElo)) {
    return { error: 'ELO 要求必须是整数。' }
  }
  if (minElo !== null && (minElo < 0 || minElo > 4000)) {
    return { error: '最低 ELO 范围不合理。' }
  }
  if (maxElo !== null && (maxElo < 0 || maxElo > 4000)) {
    return { error: '最高 ELO 范围不合理。' }
  }
  if (minElo !== null && maxElo !== null && minElo > maxElo) {
    return { error: '最低 ELO 不能高于最高 ELO。' }
  }

  const playAt = parseLocalDateTimeInput(
    playAtRaw,
    Number.isFinite(timezoneOffset) ? timezoneOffset : 0,
  )
  if (Number.isNaN(playAt.getTime())) return { error: '约球时间格式不正确。' }
  if (playAt <= new Date()) return { error: '约球时间必须是未来时间。' }

  await prisma.matchPost.create({
    data: {
      creatorId: currentUser.id,
      description,
      playAt,
      durationMinutes,
      location,
      minElo,
      maxElo,
      isRatedPreferred,
      status: MatchPostStatus.OPEN,
    },
  })

  revalidatePath('/')
  return { success: '约球帖已发布。' }
}

export async function applyMatchPostAction(
  postId: string,
  _: MatchPostFormState,
  formData: FormData,
): Promise<MatchPostFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后再申请约球。' }

  const message = String(formData.get('message') ?? '').trim()
  if (message.length > 200) return { error: '申请留言不能超过 200 字。' }

  const post = await prisma.matchPost.findUnique({
    where: { id: postId },
    select: {
      id: true,
      creatorId: true,
      status: true,
      playAt: true,
    },
  })

  if (!post) return { error: '约球帖不存在。' }
  if (post.creatorId === currentUser.id) return { error: '不能申请自己的约球帖。' }
  if (post.status !== MatchPostStatus.OPEN) return { error: '这个约球帖当前不可申请。' }
  if (post.playAt <= new Date()) {
    await prisma.matchPost.updateMany({
      where: { id: post.id, status: MatchPostStatus.OPEN },
      data: { status: MatchPostStatus.EXPIRED },
    })
    revalidatePath('/')
    return { error: '这个约球帖已过期。' }
  }

  try {
    await prisma.matchApplication.create({
      data: {
        postId,
        applicantId: currentUser.id,
        message: message || null,
      },
    })
  } catch (error) {
    if (isPrismaKnownError(error) && error.code === 'P2002') {
      return { error: '你已经申请过这个约球帖。' }
    }
    throw error
  }

  revalidatePath('/')
  return { success: '申请已提交。' }
}

export async function acceptMatchApplicationAction(
  postId: string,
  applicationId: string,
  _: MatchPostFormState,
  formData: FormData,
): Promise<MatchPostFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后再处理申请。' }

  try {
    await prisma.$transaction(async (tx) => {
      const application = await tx.matchApplication.findUnique({
        where: { id: applicationId },
        select: {
          id: true,
          postId: true,
          applicantId: true,
          status: true,
          post: {
            select: {
              id: true,
              creatorId: true,
              status: true,
              playAt: true,
            },
          },
        },
      })

      if (!application || application.postId !== postId) {
        throw new Error('申请不存在。')
      }
      if (application.post.creatorId !== currentUser.id) {
        throw new Error('只有发布者可以接受申请。')
      }
      if (application.status !== MatchApplicationStatus.PENDING) {
        throw new Error('这个申请当前不可接受。')
      }
      if (application.post.status !== MatchPostStatus.OPEN) {
        throw new Error('这个约球帖当前不可匹配。')
      }
      if (application.post.playAt <= new Date()) {
        await tx.matchPost.updateMany({
          where: { id: postId, status: MatchPostStatus.OPEN },
          data: { status: MatchPostStatus.EXPIRED },
        })
        throw new Error('这个约球帖已过期。')
      }

      const updatedPost = await tx.matchPost.updateMany({
        where: {
          id: postId,
          status: MatchPostStatus.OPEN,
          matchedUserId: null,
          playAt: { gt: new Date() },
        },
        data: {
          status: MatchPostStatus.MATCHED,
          matchedUserId: application.applicantId,
        },
      })

      if (updatedPost.count !== 1) {
        throw new Error('这个约球帖已经被处理，请刷新后查看。')
      }

      await tx.matchApplication.update({
        where: { id: application.id },
        data: { status: MatchApplicationStatus.ACCEPTED },
      })

      await tx.matchApplication.updateMany({
        where: {
          postId,
          id: { not: application.id },
          status: MatchApplicationStatus.PENDING,
        },
        data: { status: MatchApplicationStatus.REJECTED },
      })
    })
  } catch (error) {
    if (error instanceof Error) return { error: error.message }
    throw error
  }

  revalidatePath('/')
  return { success: '已接受申请，约球匹配成功。' }
}

export async function cancelMatchPostAction(
  postId: string,
  _: MatchPostFormState,
  formData: FormData,
): Promise<MatchPostFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后再取消约球。' }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.matchPost.updateMany({
      where: {
        id: postId,
        creatorId: currentUser.id,
        status: { in: [MatchPostStatus.OPEN, MatchPostStatus.MATCHED] },
      },
      data: { status: MatchPostStatus.CANCELLED },
    })

    if (result.count === 1) {
      await tx.matchApplication.updateMany({
        where: {
          postId,
          status: MatchApplicationStatus.PENDING,
        },
        data: { status: MatchApplicationStatus.CANCELLED },
      })
    }

    return result
  })

  if (updated.count !== 1) {
    return { error: '只能取消自己发布的开放或已匹配约球。' }
  }

  revalidatePath('/')
  return { success: '约球帖已取消。' }
}

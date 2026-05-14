import { timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import { headers } from 'next/headers'
import { CSRF_COOKIE_NAME, CSRF_FORM_FIELD } from '@/lib/csrf-constants'

function hostFromUrl(rawUrl: string | null) {
  if (!rawUrl) return null
  try {
    return new URL(rawUrl).host
  } catch {
    return null
  }
}

async function isSameOriginRequest() {
  const headerStore = await headers()
  const requestHost =
    headerStore.get('x-forwarded-host') ??
    headerStore.get('host') ??
    hostFromUrl(process.env.APP_URL ?? null) ??
    hostFromUrl(process.env.NEXT_PUBLIC_APP_URL ?? null)

  if (!requestHost) return false

  const originHost = hostFromUrl(headerStore.get('origin'))
  if (originHost && originHost === requestHost) {
    return true
  }

  const refererHost = hostFromUrl(headerStore.get('referer'))
  if (refererHost && refererHost === requestHost) {
    return true
  }

  return false
}

export async function validateCsrfToken(formData: FormData): Promise<string | null> {
  const submittedToken = String(formData.get(CSRF_FORM_FIELD) ?? '')
  const cookieStore = await cookies()
  const cookieToken = cookieStore.get(CSRF_COOKIE_NAME)?.value ?? ''
  const sameOrigin = await isSameOriginRequest()

  if (!submittedToken || !cookieToken) {
    return sameOrigin ? null : '安全校验失败，请刷新页面后重试。'
  }

  const submittedBuffer = Buffer.from(submittedToken)
  const cookieBuffer = Buffer.from(cookieToken)

  if (submittedBuffer.length !== cookieBuffer.length) {
    return sameOrigin ? null : '安全校验失败，请刷新页面后重试。'
  }

  if (!timingSafeEqual(submittedBuffer, cookieBuffer)) {
    return sameOrigin ? null : '安全校验失败，请刷新页面后重试。'
  }

  return null
}
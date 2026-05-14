import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { CSRF_COOKIE_NAME } from '@/lib/csrf-constants'

function generateToken() {
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
}

export async function GET() {
  const cookieStore = await cookies()
  let token = cookieStore.get(CSRF_COOKIE_NAME)?.value ?? ''

  if (!token) {
    token = generateToken()
  }

  const response = NextResponse.json(
    { token },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )

  response.cookies.set(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  })

  return response
}
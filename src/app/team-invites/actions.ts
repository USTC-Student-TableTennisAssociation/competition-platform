'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth'
import {
  acceptDoublesInvite,
  revokeDoublesInvite,
  sendDoublesInvite,
} from '@/lib/doubles'
import { validateCsrfToken } from '@/lib/csrf'

export async function sendDoublesInviteAction(matchId: string, formData: FormData) {
  if (await validateCsrfToken(formData)) return

  const currentUser = await getCurrentUser()
  if (!currentUser) return

  const inviteeId = String(formData.get('inviteeId') ?? '').trim()
  if (!inviteeId) return

  await sendDoublesInvite({
    matchId,
    inviterId: currentUser.id,
    inviteeId,
  })

  revalidatePath(`/matchs/${matchId}`)
  revalidatePath('/team-invites')
}

export async function acceptDoublesInviteAction(formData: FormData) {
  if (await validateCsrfToken(formData)) return

  const currentUser = await getCurrentUser()
  if (!currentUser) return

  const inviteId = String(formData.get('inviteId') ?? '').trim()
  if (!inviteId) return

  const result = await acceptDoublesInvite({
    inviteId,
    currentUserId: currentUser.id,
  })

  if (result.ok) {
    revalidatePath('/matchs')
    revalidatePath('/team-invites')
  }
}

export async function revokeDoublesInviteAction(formData: FormData) {
  if (await validateCsrfToken(formData)) return

  const currentUser = await getCurrentUser()
  if (!currentUser) return

  const inviteId = String(formData.get('inviteId') ?? '').trim()
  if (!inviteId) return

  const result = await revokeDoublesInvite({
    inviteId,
    currentUserId: currentUser.id,
  })

  if (result.ok) {
    revalidatePath('/team-invites')
  }
}

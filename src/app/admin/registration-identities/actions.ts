'use server'

import { validateCsrfToken } from '@/lib/csrf'
import { prisma } from '@/lib/prisma'
import { getAdminIdentity, isAdminReauthed } from '@/lib/server/admin/guard'
import { decryptRegistrationIdentity } from '@/lib/server/registration-identity'

export type RevealState = { error?: string; details?: { realName: string; idNumber: string } }
export async function revealIdentity(_: RevealState, form: FormData): Promise<RevealState> {
  const actor = await getAdminIdentity()
  if (!actor.ok || !(await isAdminReauthed(actor.userId))) return { error: '请先在管理后台完成身份验证。' }
  const csrfError = await validateCsrfToken(form)
  if (csrfError) return { error: csrfError }
  const matchId = form.get('matchId'), userId = form.get('userId')
  if (typeof matchId !== 'string' || typeof userId !== 'string') return { error: '请选择比赛和参赛者。' }
  try {
    return await prisma.$transaction(async tx => {
      const record = await tx.matchRegistrationIdentity.findFirst({
        where: { matchId, userId, match: { collectIdentityInfo: true },
          user: { matchEntryMembers: { some: { matchId, status: 'ACTIVE', entry: { status: 'ACTIVE' } } } } },
        select: { encryptedData: true },
      })
      if (!record) return { error: '没有可查看的报名身份资料。' }
      const details = decryptRegistrationIdentity({ matchId, userId }, record.encryptedData)
      await tx.auditLog.create({ data: { actorId: actor.userId, action: 'match.registration-identity.read',
        entityType: 'Match', entityId: matchId, details: { participantId: userId } }, select: { id: true } })
      return { details }
    })
  } catch { return { error: '读取失败，请检查加密配置或稍后重试。' } }
}

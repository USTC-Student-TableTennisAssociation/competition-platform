import { NotificationDeliveryStatus, Prisma } from '@prisma/client'
import { sendAzureEmail } from '@/lib/azure-email'
import { prisma } from '@/lib/prisma'

type DeliveryResult = {
  id: string
  status: 'sent' | 'failed' | 'skipped'
  error?: string
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000)
}

async function writeDeliveryAudit(
  notificationId: string,
  status: 'sent' | 'failed',
  details: Prisma.InputJsonObject,
) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: `notification.email.${status}`,
        entityType: 'NotificationOutbox',
        entityId: notificationId,
        details,
      },
    })
  } catch (error) {
    console.error('writeDeliveryAudit failed', error)
  }
}

export async function deliverNotificationOutboxItem(id: string): Promise<DeliveryResult> {
  try {
    const claimed = await prisma.notificationOutbox.updateMany({
      where: {
        id,
        status: {
          in: [NotificationDeliveryStatus.pending, NotificationDeliveryStatus.failed],
        },
      },
      data: {
        status: NotificationDeliveryStatus.sending,
        attempts: { increment: 1 },
        lastError: null,
      },
    })

    if (claimed.count !== 1) return { id, status: 'skipped' }

    const notification = await prisma.notificationOutbox.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        kind: true,
        recipientEmail: true,
        subject: true,
        htmlBody: true,
      },
    })
    if (!notification) return { id, status: 'skipped' }

    try {
      await sendAzureEmail({
        to: notification.recipientEmail,
        subject: notification.subject,
        html: notification.htmlBody,
        context: 'deliverAccountBanNotification',
        fallbackMessage: '账号封禁通知邮件发送失败。',
      })

      await prisma.notificationOutbox.update({
        where: { id },
        data: {
          status: NotificationDeliveryStatus.sent,
          sentAt: new Date(),
          lastError: null,
        },
      })
      await writeDeliveryAudit(id, 'sent', {
        userId: notification.userId,
        kind: notification.kind,
        recipientEmail: notification.recipientEmail,
      })
      return { id, status: 'sent' }
    } catch (error) {
      const message = errorMessage(error)
      await prisma.notificationOutbox.update({
        where: { id },
        data: {
          status: NotificationDeliveryStatus.failed,
          lastError: message,
        },
      })
      await writeDeliveryAudit(id, 'failed', {
        userId: notification.userId,
        kind: notification.kind,
        recipientEmail: notification.recipientEmail,
        error: message,
      })
      console.error('deliverNotificationOutboxItem failed', { id, error: message })
      return { id, status: 'failed', error: message }
    }
  } catch (error) {
    const message = errorMessage(error)
    console.error('deliverNotificationOutboxItem failed before delivery', { id, error: message })
    return { id, status: 'failed', error: message }
  }
}

export async function deliverNotificationOutboxItems(ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  return Promise.all(uniqueIds.map((id) => deliverNotificationOutboxItem(id)))
}

export async function deliverPendingNotificationOutbox(limit = 50) {
  const notifications = await prisma.notificationOutbox.findMany({
    where: {
      status: {
        in: [NotificationDeliveryStatus.pending, NotificationDeliveryStatus.failed],
      },
    },
    orderBy: { createdAt: 'asc' },
    take: Math.max(1, Math.min(limit, 200)),
    select: { id: true },
  })

  return deliverNotificationOutboxItems(notifications.map((notification) => notification.id))
}

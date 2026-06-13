import type { Prisma } from '@prisma/client'

const ACCOUNT_BAN_SUBJECT = 'USTCTTA 比赛系统账号封禁通知'

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function getAppealContact() {
  const email = process.env.APPEAL_CONTACT_EMAIL?.trim()
  if (!email) {
    return {
      text: '请联系赛事管理员提交申诉。',
      html: '请联系赛事管理员提交申诉。',
    }
  }

  const escapedEmail = escapeHtml(email)
  return {
    text: `请发送邮件至 ${email} 提交申诉。`,
    html: `请发送邮件至 <a href="mailto:${escapedEmail}">${escapedEmail}</a> 提交申诉。`,
  }
}

export function buildAccountBanNotification() {
  const appealContact = getAppealContact()
  const textBody = `您好：

经管理员核查，您的 USTCTTA 比赛系统账号存在异常注册或异常报名风险，疑似存在非本人使用或不符合参赛资格的情况。为维护校内比赛报名秩序、参赛资格公平性及系统数据安全，系统已对该账号采取临时封禁处理。

封禁后，您将无法登录系统、报名比赛、退出比赛、提交或确认赛果、创建或操作队伍。对于尚未结束的比赛，系统可能已自动取消您的相关报名、队伍成员关系、待确认赛果或分组记录。已结束比赛的历史赛果和统计记录不会因此被主动删除。

如果您认为该处理存在误判，${appealContact.text}

申诉时请提供以下信息：

1. 注册账号使用的邮箱；
2. 真实姓名和校内身份信息；
3. 相关比赛名称；
4. 对账号使用情况的说明；
5. 能够证明本人使用账号和符合参赛资格的材料。

管理员将在核查后决定是否解除封禁。提交申诉不代表一定会恢复账号，也不保证恢复原有比赛报名。

USTCTTA 比赛系统管理团队`

  const htmlBody = `
    <div style="font-family:Arial,sans-serif;line-height:1.8;color:#1f2937;">
      <p>您好：</p>
      <p>经管理员核查，您的 USTCTTA 比赛系统账号存在异常注册或异常报名风险，疑似存在非本人使用或不符合参赛资格的情况。为维护校内比赛报名秩序、参赛资格公平性及系统数据安全，系统已对该账号采取临时封禁处理。</p>
      <p>封禁后，您将无法登录系统、报名比赛、退出比赛、提交或确认赛果、创建或操作队伍。对于尚未结束的比赛，系统可能已自动取消您的相关报名、队伍成员关系、待确认赛果或分组记录。已结束比赛的历史赛果和统计记录不会因此被主动删除。</p>
      <p>如果您认为该处理存在误判，${appealContact.html}</p>
      <p>申诉时请提供以下信息：</p>
      <ol>
        <li>注册账号使用的邮箱；</li>
        <li>真实姓名和校内身份信息；</li>
        <li>相关比赛名称；</li>
        <li>对账号使用情况的说明；</li>
        <li>能够证明本人使用账号和符合参赛资格的材料。</li>
      </ol>
      <p>管理员将在核查后决定是否解除封禁。提交申诉不代表一定会恢复账号，也不保证恢复原有比赛报名。</p>
      <p>USTCTTA 比赛系统管理团队</p>
    </div>
  `.trim()

  return {
    subject: ACCOUNT_BAN_SUBJECT,
    textBody,
    htmlBody,
  }
}

export async function enqueueAccountBanNotification(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    recipientEmail: string
  },
) {
  const content = buildAccountBanNotification()
  return tx.notificationOutbox.create({
    data: {
      userId: params.userId,
      kind: 'account_banned',
      recipientEmail: params.recipientEmail,
      subject: content.subject,
      textBody: content.textBody,
      htmlBody: content.htmlBody,
    },
    select: { id: true },
  })
}

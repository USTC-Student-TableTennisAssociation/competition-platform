import { EmailClient } from '@azure/communication-email'

type AzureEmailConfig = {
  connectionString: string
  from: string
}

type SendAzureEmailInput = {
  to: string
  subject: string
  html: string
  context: string
  fallbackMessage: string
}

function isAscii(value: string) {
  return /^[\x00-\x7F]*$/.test(value)
}

function sanitizeFromAddress(rawFrom: string) {
  const trimmed = rawFrom.trim()
  if (trimmed && isAscii(trimmed)) {
    return trimmed
  }

  const match = trimmed.match(/<([^>]+)>/)
  const email = match ? match[1].trim() : trimmed
  return isAscii(email) ? email : email.replace(/[^\x00-\x7F]/g, '')
}

export function getAzureEmailConfig(): AzureEmailConfig {
  const connectionString = process.env.AZURE_COMMUNICATION_CONNECTION_STRING
  const rawFrom = process.env.AZURE_EMAIL_FROM

  if (!connectionString || !rawFrom) {
    throw new Error('邮件服务未配置：请设置 AZURE_COMMUNICATION_CONNECTION_STRING 与 AZURE_EMAIL_FROM')
  }

  return {
    connectionString,
    from: sanitizeFromAddress(rawFrom),
  }
}

let cachedClient: EmailClient | null = null
let cachedConnectionString: string | null = null

function getEmailClient() {
  const { connectionString } = getAzureEmailConfig()
  if (!cachedClient || cachedConnectionString !== connectionString) {
    cachedClient = new EmailClient(connectionString)
    cachedConnectionString = connectionString
  }

  return cachedClient
}

export async function sendAzureEmail({
  to,
  subject,
  html,
  context,
  fallbackMessage,
}: SendAzureEmailInput) {
  const { from } = getAzureEmailConfig()
  const client = getEmailClient()

  try {
    const poller = await client.beginSend({
      senderAddress: from,
      content: {
        subject,
        html,
      },
      recipients: {
        to: [{ address: to }],
      },
    })

    const result = await poller.pollUntilDone()
    if (result.status !== 'Succeeded') {
      console.error(`${context} failed`, {
        status: result.status,
        error: result.error,
      })
      throw new Error(fallbackMessage)
    }
  } catch (error) {
    console.error(`${context} failed`, error)
    throw new Error(fallbackMessage)
  }
}
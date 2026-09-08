import { getAlertSettings, getSmtpSettings } from "#/lib/db"
import { sendMail } from "#/lib/smtp"

/**
 * Alert delivery channels (webhook + email) shared by the health
 * transition pipeline and the certificate expiry checker.
 */

/** Whether at least one delivery channel is configured and enabled. */
export function alertChannelsEnabled(): boolean {
  const webhook = getAlertSettings()
  const smtp = getSmtpSettings()
  return (
    (webhook.enabled && Boolean(webhook.webhookUrl)) ||
    (smtp.enabled && Boolean(smtp.host) && smtp.toAddrs.length > 0)
  )
}

/** POST a JSON payload to the configured webhook. Returns delivery success. */
export async function notifyWebhook(
  text: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const { webhookUrl, enabled } = getAlertSettings()
  if (!enabled || !webhookUrl) return false
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...extra }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Send a plain-text email through the configured SMTP server. */
export async function notifyEmail(subject: string, body: string): Promise<boolean> {
  const s = getSmtpSettings()
  if (!s.enabled || !s.host || s.toAddrs.length === 0) return false
  try {
    await sendMail(
      {
        host: s.host,
        port: s.port,
        secure: s.secure,
        username: s.username || undefined,
        password: s.password || undefined,
        from: s.fromAddr || "haproxy-ui@localhost",
        to: s.toAddrs,
      },
      subject,
      body,
    )
    return true
  } catch {
    return false
  }
}

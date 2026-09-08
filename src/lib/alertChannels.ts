import { getAlertSettings, getSmtpSettings, insertAlertHistory } from "#/lib/db"
import { sendMail } from "#/lib/smtp"

/**
 * Alert delivery channels (webhook + email) shared by the health
 * transition pipeline, the certificate checker and anomaly detection.
 * Every send is recorded in the notification history.
 */

export type NotifyMeta = {
  kind: string
  nodeId?: string | null
}

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
  meta: NotifyMeta = { kind: "generic" },
): Promise<boolean> {
  const { webhookUrl, enabled } = getAlertSettings()
  if (!enabled || !webhookUrl) return false
  let delivered = false
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ...extra }),
      signal: AbortSignal.timeout(5000),
    })
    delivered = res.ok
  } catch {
    delivered = false
  }
  insertAlertHistory({
    ts: Date.now(),
    channel: "webhook",
    kind: meta.kind,
    subject: text.slice(0, 200),
    delivered,
    nodeId: meta.nodeId ?? null,
  })
  return delivered
}

/** Send a plain-text email through the configured SMTP server. */
export async function notifyEmail(
  subject: string,
  body: string,
  meta: NotifyMeta = { kind: "generic" },
): Promise<boolean> {
  const s = getSmtpSettings()
  if (!s.enabled || !s.host || s.toAddrs.length === 0) return false
  let delivered = false
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
    delivered = true
  } catch {
    delivered = false
  }
  insertAlertHistory({
    ts: Date.now(),
    channel: "email",
    kind: meta.kind,
    subject: subject.slice(0, 200),
    delivered,
    nodeId: meta.nodeId ?? null,
  })
  return delivered
}

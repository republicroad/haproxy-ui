import net from "node:net"
import tls from "node:tls"

/**
 * Minimal SMTP client for alert emails (RFC 5321 subset):
 * EHLO, optional STARTTLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT.
 * No attachments, no HTML — alert texts are plain UTF-8.
 */

export type SmtpConfig = {
  host: string
  port: number
  /** Implicit TLS from the start (typical port 465). */
  secure?: boolean
  username?: string
  password?: string
  from: string
  to: string[]
}

type Reply = { code: number; lines: string[] }

export function encodeHeaderValue(v: string): string {
  if (/^[\x20-\x7e]*$/.test(v)) return v
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`
}

/** RFC 5322 message with CRLF line endings and dot-stuffed body. */
export function buildMessage(
  from: string,
  to: string[],
  subject: string,
  text: string,
): string {
  const body = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n")
  return [
    `From: ${encodeHeaderValue(from)}`,
    `To: ${to.map(encodeHeaderValue).join(", ")}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n")
}

function addrOf(v: string): string {
  return v.trim().replace(/^.*</, "").replace(/>.*$/, "")
}

class SmtpConnection {
  private socket: net.Socket | tls.TLSSocket
  private buf = ""

  constructor(
    private config: SmtpConfig,
    private timeoutMs: number,
  ) {
    this.socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port })
  }

  private arm<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SMTP timeout")), this.timeoutMs)
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
    })
  }

  /** Wait for a complete (possibly multiline) reply. */
  readReply(): Promise<Reply> {
    return this.arm(
      new Promise<Reply>((resolve, reject) => {
        const onData = (chunk: Buffer | string) => {
          this.buf += chunk.toString()
          const lines = this.buf.split("\r\n")
          if (lines.length >= 2 && /^\d{3}(\s|$)/.test(lines[lines.length - 2])) {
            const complete = lines.slice(0, -1)
            this.buf = lines[lines.length - 1]
            this.socket.off("data", onData)
            this.socket.off("error", onError)
            const last = complete[complete.length - 1]
            const code = Number(last.slice(0, 3))
            resolve({ code, lines: complete })
          }
        }
        const onError = (e: Error) => {
          this.socket.off("data", onData)
          this.socket.off("error", onError)
          reject(e)
        }
        this.socket.on("data", onData)
        this.socket.on("error", onError)
      }),
    )
  }

  async connect(): Promise<Reply> {
    await this.arm(
      new Promise<void>((resolve, reject) => {
        this.socket.once(this.config.secure ? "secureConnect" : "connect", () => resolve())
        this.socket.once("error", reject)
      }),
    )
    const reply = await this.readReply()
    if (reply.code !== 220) throw new Error(`SMTP greeting ${reply.code}`)
    return reply
  }

  async command(cmd: string, expect: number[]): Promise<Reply> {
    this.socket.write(`${cmd}\r\n`)
    const reply = await this.readReply()
    if (!expect.includes(reply.code)) {
      throw new Error(`SMTP ${reply.code}: ${reply.lines.join(" / ")}`)
    }
    return reply
  }

  /** Upgrade the plaintext connection to TLS (RFC 3207). */
  async startTls(): Promise<void> {
    await this.command("STARTTLS", [220])
    const plain = this.socket as net.Socket
    const upgraded = tls.connect({ socket: plain, servername: this.config.host })
    await this.arm(
      new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", () => resolve())
        upgraded.once("error", reject)
      }),
    )
    this.buf = ""
    this.socket = upgraded
  }

  async data(message: string): Promise<void> {
    await this.command("DATA", [354])
    this.socket.write(`${message}\r\n.\r\n`)
    const reply = await this.readReply()
    if (reply.code !== 250) throw new Error(`SMTP ${reply.code}: ${reply.lines.join(" / ")}`)
  }

  close(): void {
    this.socket.destroy()
  }
}

/** Send one plain-text mail. Throws on any protocol failure. */
export async function sendMail(
  config: SmtpConfig,
  subject: string,
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  const conn = new SmtpConnection(config, timeoutMs)
  try {
    await conn.connect()
    await conn.command("EHLO haproxy-ui", [250])
    if (!config.secure) {
      try {
        await conn.startTls()
        await conn.command("EHLO haproxy-ui", [250])
      } catch (e) {
        // protocol refusal (502/454): keep the plaintext session going;
        // connection-level failures abort the send
        if (!/^SMTP \d{3}/.test((e as Error).message)) throw e
      }
    }
    if (config.username) {
      const plain = Buffer.from(`\0${config.username}\0${config.password ?? ""}`).toString("base64")
      try {
        await conn.command(`AUTH PLAIN ${plain}`, [235])
      } catch {
        await conn.command("AUTH LOGIN", [334])
        await conn.command(Buffer.from(config.username).toString("base64"), [334])
        await conn.command(Buffer.from(config.password ?? "").toString("base64"), [235])
      }
    }
    await conn.command(`MAIL FROM:<${addrOf(config.from)}>`, [250])
    for (const rcpt of config.to) {
      await conn.command(`RCPT TO:<${addrOf(rcpt)}>`, [250, 251])
    }
    await conn.data(buildMessage(config.from, config.to, subject, text))
    await conn.command("QUIT", [221]).catch(() => {})
  } finally {
    conn.close()
  }
}

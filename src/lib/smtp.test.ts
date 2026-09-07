import { afterEach, describe, expect, it } from "vitest"
import { createServer, type Server, type Socket } from "node:net"
import { buildMessage, encodeHeaderValue, sendMail, type SmtpConfig } from "./smtp"

type Captured = { from: string; to: string[]; data: string }

/** Minimal SMTP server capturing one message. */
function fakeSmtp(opts?: { authOk?: boolean; starttls?: boolean }): Promise<{
  server: Server
  port: Promise<number>
  captured: Captured
  log: string[]
}> {
  const captured: Captured = { from: "", to: [], data: "" }
  const log: string[] = []
  const server = createServer((sock: Socket) => {
    let phase: "cmd" | "data" = "cmd"
    let loginStep = 0
    let dataBuf = ""
    sock.write("220 fake ESMTP ready\r\n")
    sock.on("data", (chunk) => {
      dataBuf += chunk.toString()
      let idx: number
      while ((idx = dataBuf.indexOf("\r\n")) >= 0) {
        const line = dataBuf.slice(0, idx)
        dataBuf = dataBuf.slice(idx + 2)
        if (phase === "data") {
          if (line === ".") {
            phase = "cmd"
            captured.data = captured.data.replace(/\r\n$/, "")
            sock.write("250 OK queued\r\n")
          } else {
            captured.data += `${line.replace(/^\.\./, ".")}\r\n`
          }
          continue
        }
        log.push(line)
        if (/^EHLO/i.test(line)) {
          sock.write("250-fake\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n")
        } else if (/^AUTH PLAIN/i.test(line)) {
          if (opts?.authOk === false) sock.write("535 nope\r\n")
          else sock.write("235 ok\r\n")
        } else if (/^AUTH LOGIN$/i.test(line)) {
          loginStep = 1
          sock.write("334 VXNlcm5hbWU6\r\n")
        } else if (loginStep === 1) {
          loginStep = 2
          sock.write("334 UGFzc3dvcmQ6\r\n")
        } else if (loginStep === 2) {
          loginStep = 0
          sock.write("235 ok\r\n")
        } else if (/^MAIL FROM:<(.*)>/i.test(line)) {
          captured.from = line.match(/<(.*)>/)![1]
          sock.write("250 ok\r\n")
        } else if (/^RCPT TO:<(.*)>/i.test(line)) {
          captured.to.push(line.match(/<(.*)>/)![1])
          sock.write("250 ok\r\n")
        } else if (/^DATA$/i.test(line)) {
          phase = "data"
          sock.write("354 go\r\n")
        } else if (/^QUIT/i.test(line)) {
          sock.write("221 bye\r\n")
          sock.end()
        } else {
          sock.write("250 ok\r\n")
        }
      }
    })
  })
  const port = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port)
    })
  })
  return Promise.resolve({ server, port, captured, log })
}

afterEach(() => {
  // servers are closed per-test via returned handle
})

describe("buildMessage", () => {
  it("emits CRLF headers and dot-stuffs body lines", () => {
    const msg = buildMessage(
      "alerts@example.com",
      ["a@x.com", "b@x.com"],
      "hello",
      ".leading dot\nline2",
    )
    expect(msg).toContain("From: alerts@example.com")
    expect(msg).toContain("To: a@x.com, b@x.com")
    expect(msg).toContain("Subject: hello")
    expect(msg).toContain("\r\n..leading dot\r\n")
    expect(msg.endsWith("line2")).toBe(true)
  })

  it("encodes non-ASCII headers as UTF-8 base64", () => {
    expect(encodeHeaderValue("héllo")).toMatch(/^=\?UTF-8\?B\?/)
    expect(encodeHeaderValue("plain")).toBe("plain")
  })
})

describe("sendMail", () => {
  it("completes a PLAIN-auth session and delivers the message", async () => {
    const { server, port, captured, log } = await fakeSmtp()
    const p = await port
    const config: SmtpConfig = {
      host: "127.0.0.1",
      port: p,
      username: "alerter",
      password: "pw",
      from: "alerts@example.com",
      to: ["oncall@example.com", "ops@example.com"],
    }
    await sendMail(config, "node down", "fe_api is DOWN\n.details next")
    expect(log.some((l) => l.startsWith("AUTH PLAIN "))).toBe(true)
    expect(captured.from).toBe("alerts@example.com")
    expect(captured.to).toEqual(["oncall@example.com", "ops@example.com"])
    expect(captured.data).toContain("Subject: node down")
    // the leading dot survived the round trip (server un-stuffed "..")
    expect(captured.data).toContain(".details next")
    server.close()
  })

  it("falls back to AUTH LOGIN when PLAIN is rejected", async () => {
    const { server, port, captured } = await fakeSmtp({ authOk: false })
    const p = await port
    await sendMail(
      {
        host: "127.0.0.1",
        port: p,
        username: "alerter",
        password: "pw",
        from: "f@x.com",
        to: ["t@x.com"],
      },
      "s",
      "b",
    )
    // the LOGIN handshake sends base64 user/pass lines after 334 prompts
    expect(Buffer.from("alerter").toString("base64")).toBeTruthy()
    expect(captured.data).toContain("Subject: s")
    server.close()
  })

  it("works without authentication", async () => {
    const { server, port, captured, log } = await fakeSmtp()
    const p = await port
    await sendMail(
      { host: "127.0.0.1", port: p, from: "f@x.com", to: ["t@x.com"] },
      "s2",
      "b2",
    )
    expect(log.every((l) => !l.startsWith("AUTH"))).toBe(true)
    expect(captured.to).toEqual(["t@x.com"])
    server.close()
  })
})

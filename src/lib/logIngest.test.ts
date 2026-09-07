import { describe, expect, it } from "vitest"
import { parseHaProxyLogLine, stripSyslogHeader } from "./logIngest"

describe("stripSyslogHeader", () => {
  it("strips RFC3164 prefixes", () => {
    expect(
      stripSyslogHeader(
        "Sep  7 12:00:00 host haproxy[1234]: 10.0.0.1:5 repetitive",
      ),
    ).toBe("10.0.0.1:5 repetitive")
    expect(
      stripSyslogHeader("<134>Sep  7 12:00:00 host haproxy[1234]: GET /"),
    ).toBe("GET /")
  })

  it("leaves bare lines alone", () => {
    expect(stripSyslogHeader("10.0.0.1:5 [x] fe be/s 0/0 200 5 - - ---- 1/1 0/0 \"GET / HTTP/1.1\"")).toContain("10.0.0.1:5")
  })
})

describe("parseHaProxyLogLine", () => {
  const syslog = (payload: string) => `<134>Sep  7 12:00:00 host haproxy[21587]: ${payload}`

  it("parses a standard HTTP log line", () => {
    const rec = parseHaProxyLogLine(
      syslog(
        '127.0.0.1:33320 [07/Sep/2026:12:00:56.655] fnt bck/srv1 10/0/30/1/41 200 66012 - - ---- 3/3/1/1/0 0/0 "GET /index.html HTTP/1.1"',
      ),
    )
    expect(rec).not.toBeNull()
    expect(rec!.clientIp).toBe("127.0.0.1")
    expect(rec!.frontend).toBe("fnt")
    expect(rec!.backend).toBe("bck")
    expect(rec!.server).toBe("srv1")
    expect(rec!.status).toBe(200)
    expect(rec!.bytesRead).toBe(66012)
    expect(rec!.totalTimeMs).toBe(41)
    expect(rec!.method).toBe("GET")
    expect(rec!.path).toBe("/index.html")
  })

  it("parses lines without a syslog prefix and NOSRV backends", () => {
    const rec = parseHaProxyLogLine(
      '10.1.2.3:443 [07/Sep/2026:12:00:00.000] fe_api - NOSRV 0/0/0/0/0 503 212 - - SC-- 1/1/0/0/0 0/0 "GET /api/x HTTP/1.1"',
    )
    expect(rec).not.toBeNull()
    expect(rec!.backend).toBeNull()
    expect(rec!.server).toBeNull()
    expect(rec!.status).toBe(503)
    expect(rec!.path).toBe("/api/x")
  })

  it("keeps '-' byte counts as null and parses timers with TR only", () => {
    const rec = parseHaProxyLogLine(
      '10.9.9.9:1000 [07/Sep/2026:00:00:00.000] fe be/srv 0/0/0/0/5 404 - - - ---- 0/0/0/0/0 0/0 "HEAD /missing HTTP/1.0"',
    )
    expect(rec!.bytesRead).toBeNull()
    expect(rec!.totalTimeMs).toBe(5)
    expect(rec!.method).toBe("HEAD")
  })

  it("rejects non-HTTP payloads", () => {
    expect(parseHaProxyLogLine("random garbage from the network")).toBeNull()
    expect(parseHaProxyLogLine("")).toBeNull()
    // TCP-mode log (no request line)
    expect(
      parseHaProxyLogLine(
        syslog("10.0.0.5:2222 [07/Sep/2026:10:00:00.000] fe_tcp be/srv 1/0/0/0/3 0 0 - - ---- 1/1/0/0/0 0/0"),
      ),
    ).toBeNull()
  })
})

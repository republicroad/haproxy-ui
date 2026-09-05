/**
 * Production HTTP server for the TanStack Start build.
 *
 * `dist/server/server.js` only exports a fetch handler ({ fetch }); this
 * wrapper turns it into a real HTTP server:
 *   - serves static client assets from dist/client (immutable cache)
 *   - forwards everything else to the server entry's fetch
 *
 * Env: PORT (default 3000), HOST (default 0.0.0.0)
 */
import { createServer } from "node:http"
import { createReadStream, existsSync, statSync } from "node:fs"
import { extname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? "0.0.0.0"
const HERE = resolve(fileURLToPath(import.meta.url), "../..")
const CLIENT_DIR = join(HERE, "dist", "client")

const { default: entry } = await import(
  pathToFileURL(join(HERE, "dist", "server", "server.js")).href
)

const MIME = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
}

function serveStatic(urlPath, res) {
  if (urlPath.includes("..")) return false
  const rel = normalize(urlPath).replace(/^([/\\])+/, "")
  const filePath = join(CLIENT_DIR, rel)
  if (!filePath.startsWith(CLIENT_DIR + sep) && filePath !== CLIENT_DIR) return false
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return false
  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream"
  const immutable = rel.startsWith(`assets${sep}`) || rel.startsWith("assets/")
  res.writeHead(200, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  })
  createReadStream(filePath).pipe(res)
  return true
}

function toWebRequest(req, origin) {
  const url = new URL(req.url ?? "/", origin).toString()
  const headers = new Headers()
  for (const [name, values] of Object.entries(req.headers)) {
    if (values === undefined) continue
    for (const v of Array.isArray(values) ? values : [values]) headers.append(name, v)
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD"
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? new ReadableStream({
      start(controller) {
        req.on("data", (c) => controller.enqueue(new Uint8Array(c)))
        req.on("end", () => controller.close())
        req.on("error", (e) => controller.error(e))
      },
    }) : undefined,
    // @ts-expect-error - duplex is required by undici for streaming bodies
    duplex: "half",
  })
}

async function sendResponse(nodeRes, webRes) {
  const headers = {}
  webRes.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") headers[k] = [headers[k], v].flat().filter(Boolean)
    else headers[k] = v
  })
  nodeRes.writeHead(webRes.status, headers)
  if (!webRes.body) {
    nodeRes.end()
    return
  }
  const reader = webRes.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    nodeRes.write(value)
  }
  nodeRes.end()
}

const server = createServer(async (req, res) => {
  try {
    const origin = `http://${req.headers.host ?? `localhost:${PORT}`}`
    const url = new URL(req.url ?? "/", origin)

    if ((req.method === "GET" || req.method === "HEAD") && serveStatic(url.pathname, res)) {
      return
    }

    const request = toWebRequest(req, origin)
    const response = await entry.fetch(request)
    await sendResponse(res, response)
  } catch (e) {
    console.error("[prod-server] request failed:", e)
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" })
    }
    res.end(JSON.stringify({ error: "internal server error" }))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`haproxy-ui production server on http://${HOST}:${PORT}`)
})

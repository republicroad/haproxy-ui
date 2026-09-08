const BASE = "http://localhost:3000"
const DP_PORT = process.env.DP_PORT ?? 9090
const j = async (r) => {
  const t = await r.text()
  try {
    return t ? JSON.parse(t) : null
  } catch {
    return t
  }
}
const run = async () => {
  const created = await j(
    await fetch(`${BASE}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "real-1", apiUrl: `http://localhost:${DP_PORT}` }),
    }),
  )
  const id = created.id
  console.log("NODE created:", id)

  const dp = (method, path, body) =>
    fetch(`${BASE}/api/dp/${id}/${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  const newTx = async () => {
    const version = await j(await dp("GET", "services/haproxy/configuration/version"))
    return (await j(await dp("POST", `services/haproxy/transactions?version=${version}`))).id
  }
  const commit = (txid) => dp("PUT", `services/haproxy/transactions/${txid}`)

  let r = await dp("GET", "services/haproxy/runtime/info")
  console.log("runtime/info:", r.status, (await j(r))?.info?.version)

  // backend first
  let tx = await newTx()
  r = await dp("POST", `services/haproxy/configuration/backends?transaction_id=${tx}`, {
    name: "be_int",
    mode: "http",
    balance: { algorithm: "roundrobin" },
  })
  console.log("create backend:", r.status)
  await commit(tx)

  // frontend referencing the backend
  tx = await newTx()
  r = await dp("POST", `services/haproxy/configuration/frontends?transaction_id=${tx}`, {
    name: "fe_int",
    mode: "http",
    default_backend: "be_int",
    bind: [{ address: "*", port: 8085 }],
  })
  console.log("create frontend:", r.status, JSON.stringify(await j(r)))
  await commit(tx)

  // server inside the backend
  tx = await newTx()
  r = await dp(
    "POST",
    `services/haproxy/configuration/backends/be_int/servers?transaction_id=${tx}`,
    { name: "srv_int", address: "10.0.0.1", port: 8080, weight: 100, check: "enabled" },
  )
  console.log("create server:", r.status, JSON.stringify(await j(r)))
  await commit(tx)

  r = await dp("GET", "services/haproxy/configuration/frontends")
  console.log("frontends:", r.status, JSON.stringify(await j(r)))
  r = await dp("GET", "services/haproxy/configuration/backends")
  console.log("backends:", r.status, JSON.stringify(await j(r)))
  r = await dp("GET", "services/haproxy/configuration/backends/be_int/servers")
  console.log("servers:", r.status, JSON.stringify(await j(r)))

  r = await dp("GET", "services/haproxy/configuration/raw")
  const raw = await r.text()
  console.log("raw config:", r.status, "fe_int:", raw.includes("fe_int"), "srv_int:", raw.includes("srv_int"))

  // delete server
  tx = await newTx()
  await dp(
    "DELETE",
    `services/haproxy/configuration/backends/be_int/servers/srv_int?transaction_id=${tx}`,
  )
  await commit(tx)
  r = await dp("GET", "services/haproxy/configuration/backends/be_int/servers")
  console.log("servers after delete:", r.status, JSON.stringify(await j(r)))

  r = await fetch(`${BASE}/api/nodes/${id}/test`, { method: "POST" })
  console.log("connection test:", r.status, JSON.stringify(await j(r)))
  const nodeAfter = await j(await fetch(`${BASE}/api/nodes/${id}`))
  console.log("node status after test:", nodeAfter.status, "version:", nodeAfter.haproxyVersion)
  if (nodeAfter.status !== "up" || !nodeAfter.haproxyVersion) throw new Error("status not persisted")

  // ---- rules: switching rule + health check + rate limit preset ----
  tx = await newTx()
  // real dataplaneapi rejects collection POSTs (405) — create at an index
  r = await dp(
    "POST",
    `services/haproxy/configuration/frontends/fe_int/backend_switching_rules/0?transaction_id=${tx}`,
    { name: "be_int", cond: "if", cond_test: "{ path_beg /api }" },
  )
  console.log("switching rule:", r.status, r.ok ? "" : await r.clone().text())
  await commit(tx)

  tx = await newTx()
  r = await dp(
    "POST",
    `services/haproxy/configuration/backends/be_int/http_checks/0?transaction_id=${tx}`,
    { type: "expect", value: "status 200" },
  )
  console.log("http check:", r.status, r.ok ? "" : await r.clone().text())
  await commit(tx)

  tx = await newTx()
  r = await dp(
    "PUT",
    `services/haproxy/configuration/backends/be_int?transaction_id=${tx}`,
    {
      name: "be_int",
      stick_table: {
        type: "ip",
        size: 100000,
        expire: 10,
        store: ["http_req_rate(10s)"],
      },
    },
  )
  console.log("stick_table:", r.status, r.ok ? "" : await r.clone().text())
  r = await dp(
    "POST",
    `services/haproxy/configuration/backends/be_int/http_request_rules/0?transaction_id=${tx}`,
    { type: "track-sc", track_sc_stick_counter: 0, track_sc_key: "src" },
  )
  console.log("track rule:", r.status, r.ok ? "" : await r.clone().text())
  r = await dp(
    "POST",
    `services/haproxy/configuration/backends/be_int/http_request_rules/1?transaction_id=${tx}`,
    {
      type: "deny",
      deny_status: 429,
      http_rule_condition: { cond: "if", val: "{ src http_req_rate(10s) gt 50 }" },
    },
  )
  console.log("deny rule:", r.status, r.ok ? "" : await r.clone().text())
  await commit(tx)

  r = await dp("GET", "services/haproxy/configuration/frontends/fe_int/backend_switching_rules")
  const switchRules = await j(r)
  console.log("switching rules:", r.status, JSON.stringify(switchRules))
  if (!JSON.stringify(switchRules).includes("be_int")) throw new Error("switching rule not persisted")
  r = await dp("GET", "services/haproxy/configuration/backends/be_int/http_checks")
  const checks = await j(r)
  console.log("http checks:", r.status, JSON.stringify(checks))
  if (!JSON.stringify(checks).includes("expect")) throw new Error("http check not persisted")
  r = await dp("GET", "services/haproxy/configuration/backends/be_int/http_request_rules")
  const reqRules = await j(r)
  console.log("backend request rules:", r.status, JSON.stringify(reqRules))
  if (!JSON.stringify(reqRules).includes("track-sc")) throw new Error("track rule not persisted")

  // observability endpoints
  r = await fetch(`${BASE}/api/metrics`)
  const metrics = await r.text()
  console.log("metrics:", r.status, "content-type:", r.headers.get("content-type"))
  if (r.status !== 200) throw new Error("metrics endpoint failed")
  if (!metrics.includes("haproxy_ui_node_up") || !metrics.includes("haproxy_ui_log_records_last_5m")) {
    throw new Error("metrics payload missing expected series")
  }
  r = await fetch(`${BASE}/api/logs?limit=10`)
  const logs = await j(r)
  console.log("logs:", r.status, Array.isArray(logs) ? `${logs.length} records` : JSON.stringify(logs))
  if (r.status !== 200 || !Array.isArray(logs)) throw new Error("logs endpoint failed")
  r = await fetch(`${BASE}/api/openapi`)
  const spec = await j(r)
  console.log("openapi:", r.status, spec?.openapi)
  if (r.status !== 200 || spec?.openapi !== "3.1.0") throw new Error("openapi endpoint failed")

  await fetch(`${BASE}/api/nodes/${id}`, { method: "DELETE" })
  console.log("DONE")
}
run().catch((e) => {
  console.log("TEST ERROR:", e.message)
  process.exit(1)
})

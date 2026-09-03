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

  await fetch(`${BASE}/api/nodes/${id}`, { method: "DELETE" })
  console.log("DONE")
}
run().catch((e) => {
  console.log("TEST ERROR:", e.message)
  process.exit(1)
})

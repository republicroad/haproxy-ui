import { createFileRoute } from "@tanstack/react-router"
import { proxyToNode } from "#/lib/dataplane/proxy"

export const Route = createFileRoute("/api/dp/$nodeId/$")({
  server: {
    handlers: {
      GET: ({ request, params }) => proxyToNode(params.nodeId, request),
      POST: ({ request, params }) => proxyToNode(params.nodeId, request),
      PUT: ({ request, params }) => proxyToNode(params.nodeId, request),
      DELETE: ({ request, params }) => proxyToNode(params.nodeId, request),
      PATCH: ({ request, params }) => proxyToNode(params.nodeId, request),
    },
  },
})

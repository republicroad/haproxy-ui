"use client"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { useAppEvents } from "#/hooks/useAppEvents"
import { TransactionReviewGate } from "#/components/TransactionReviewGate"

/** Renders nothing; lives inside QueryClientProvider so it can use the client. */
function AppEventsBridge() {
  useAppEvents()
  return null
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      }),
  )
  return (
    <QueryClientProvider client={client}>
      <AppEventsBridge />
      {children}
      {/* after children: the review dialog must stack above page dialogs */}
      <TransactionReviewGate />
    </QueryClientProvider>
  )
}

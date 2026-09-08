"use client"

import { useEffect, useState } from "react"
import { Button } from "#/components/ui/button"
import { Modal } from "#/components/Modal"
import { setTransactionPreviewGate, type TransactionDiff } from "#/lib/dataplane/client"

export const REVIEW_CHANGES_KEY = "hui-review-changes"

export function reviewChangesEnabled(): boolean {
  try {
    return localStorage.getItem(REVIEW_CHANGES_KEY) === "1"
  } catch {
    return false
  }
}

export function setReviewChangesEnabled(on: boolean): void {
  try {
    localStorage.setItem(REVIEW_CHANGES_KEY, on ? "1" : "0")
  } catch {
    // private mode — toggle just won't persist
  }
}

type PendingReview = {
  diff: TransactionDiff
  resolve: (approved: boolean) => void
}

/**
 * Mounted once in the app shell. Registers the transaction preview gate:
 * when "Review changes" is enabled, every config transaction pauses
 * before commit and shows the staged raw-config diff for approval.
 */
export function TransactionReviewGate() {
  const [pending, setPending] = useState<PendingReview | null>(null)

  useEffect(() => {
    setTransactionPreviewGate(async (diff) => {
      if (!reviewChangesEnabled()) return true
      return new Promise<boolean>((resolve) => {
        setPending({ diff, resolve })
      })
    })
    return () => setTransactionPreviewGate(null)
  }, [])

  if (!pending) return null
  const { diff, resolve } = pending
  const settle = (ok: boolean) => {
    setPending(null)
    resolve(ok)
  }

  return (
    <Modal open onClose={() => settle(false)} title="Review changes before apply">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          The staged configuration is validated by <code>haproxy -c</code> on
          commit either way. Apply these lines?
        </p>
        <div className="max-h-[45vh] overflow-auto rounded-md border border-border bg-card text-xs">
          {diff.removed.length === 0 && diff.added.length === 0 && (
            <p className="p-3 text-muted-foreground">No configuration lines change.</p>
          )}
          {diff.removed.map((l, i) => (
            <div
              key={`rm-${i}`}
              className="whitespace-pre-wrap bg-destructive/10 px-3 py-0.5 text-destructive"
            >
              - {l}
            </div>
          ))}
          {diff.added.map((l, i) => (
            <div
              key={`ad-${i}`}
              className="whitespace-pre-wrap bg-success/10 px-3 py-0.5 text-success"
            >
              + {l}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button onClick={() => settle(true)}>Apply change</Button>
        </div>
      </div>
    </Modal>
  )
}

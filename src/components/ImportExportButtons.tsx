"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "#/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"
import { ConfirmDialog } from "./ConfirmDialog"

function pickFile(onPicked: (file: File) => void) {
  const input = document.createElement("input")
  input.type = "file"
  input.accept = "application/json,.json"
  input.onchange = () => {
    const f = input.files?.[0]
    if (f) onPicked(f)
  }
  input.click()
}

async function readJson(file: File): Promise<unknown> {
  const text = await file.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("not a valid JSON file")
  }
}

export function NodesImportExportButtons({
  onChanged,
}: {
  onChanged: () => void
}) {
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          window.location.href = "/api/nodes/export"
        }}
      >
        Export nodes
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          pickFile(async (file) => {
            try {
              const body = await readJson(file)
              const res = await fetch("/api/nodes/import", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(
                  Array.isArray(body) ? { nodes: body } : body,
                ),
              })
              const j = await res.json().catch(() => ({}))
              if (!res.ok) throw new Error(j.error ?? "import failed")
              const imported = (j.imported as string[])?.length ?? 0
              const skipped = (j.skipped as unknown[])?.length ?? 0
              toast.success(`Imported ${imported} node(s), skipped ${skipped}`)
              onChanged()
            } catch (e) {
              toast.error("Import failed", { description: (e as Error).message })
            }
          })
        }
      >
        Import nodes
      </Button>
    </>
  )
}

export function NodeConfigImportExportButtons({ nodeId }: { nodeId: string }) {
  const [conflict, setConflict] = useState<"skip" | "overwrite">("skip")
  const [pending, setPending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const fileRef = useRef<File | null>(null)

  return (
    <>
      <Select value={conflict} onValueChange={(v) => setConflict(v as "skip" | "overwrite")}>
        <SelectTrigger className="h-8 w-[150px]" aria-label="import conflict strategy">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="skip">Skip existing</SelectItem>
          <SelectItem value="overwrite">Overwrite</SelectItem>
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          window.location.href = `/api/nodes/${nodeId}/config`
        }}
      >
        Export config
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          pickFile(async (file) => {
            fileRef.current = file
            setConfirmOpen(true)
          })
        }
      >
        {pending ? "Importing…" : "Import config"}
      </Button>
      <ConfirmDialog
        open={confirmOpen}
        title="Import configuration"
        message={
          conflict === "overwrite"
            ? `Apply "${fileRef.current?.name ?? "bundle"}" to this node? Existing frontends/backends with the same name will be DELETED and recreated.`
            : `Apply "${fileRef.current?.name ?? "bundle"}" to this node? Existing items with the same name will be skipped.`
        }
        confirmLabel="Import"
        pending={pending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={async () => {
          const file = fileRef.current
          if (!file) return
          setPending(true)
          try {
            const bundle = (await readJson(file)) as Record<string, unknown>
            const res = await fetch(`/api/nodes/${nodeId}/config`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...bundle, conflict }),
            })
            const j = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(j.error ?? "import failed")
            const created = (j.created as string[])?.length ?? 0
            const skipped = (j.skipped as string[])?.length ?? 0
            toast.success(
              `Imported ${created} item(s), skipped ${skipped}`,
              {
                description: (j.created as string[])
                  ?.slice(0, 6)
                  .join(", "),
              },
            )
            setConfirmOpen(false)
          } catch (e) {
            toast.error("Import failed", { description: (e as Error).message })
          } finally {
            setPending(false)
          }
        }}
      />
    </>
  )
}

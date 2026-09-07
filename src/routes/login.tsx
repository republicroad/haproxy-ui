import { createFileRoute, useNavigate, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"

function LoginPage() {
  const navigate = useNavigate()
  const { from } = Route.useSearch()
  const [user, setUser] = useState("")
  const [pass, setPass] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [sso, setSso] = useState<boolean | null>(null)

  useEffect(() => {
    fetch("/api/auth/oidc/status")
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((j: { configured: boolean }) => setSso(j.configured))
      .catch(() => setSso(false))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, pass }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "login failed")
      navigate({ to: from ?? "/" })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <div>
          <h1 className="text-xl font-bold">Sign in to HAProxy UI</h1>
          <p className="text-sm text-muted-foreground">
            Use the credentials configured via HAPROXY_UI_USER / HAPROXY_UI_PASS
          </p>
        </div>
        {sso && (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              window.location.href = "/api/auth/oidc/start"
            }}
          >
            Sign in with SSO
          </Button>
        )}
        {sso && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or with a local account
            <span className="h-px flex-1 bg-border" />
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="login-user">Username</Label>
          <Input
            id="login-user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="login-pass">Password</Label>
          <Input
            id="login-pass"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          No password configured?{" "}
          <Link to="/" className="underline">
            Go to the dashboard
          </Link>
        </p>
      </form>
    </div>
  )
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    from: typeof search.from === "string" ? search.from : undefined,
  }),
  component: LoginPage,
})

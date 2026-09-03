import { Link } from "@tanstack/react-router"
import { Button, buttonVariants } from "#/components/ui/button"

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">This page does not exist.</p>
      <Link to="/" className={buttonVariants({})}>
        Back to overview
      </Link>
    </div>
  )
}

export function ErrorPage({
  error,
  reset,
}: {
  error: Error
  reset?: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <h1 className="text-2xl font-bold text-destructive">Something went wrong</h1>
      <p className="max-w-lg text-sm text-muted-foreground">
        {error.message || "Unexpected error"}
      </p>
      {reset && (
        <Button variant="outline" onClick={reset}>
          Try again
        </Button>
      )}
    </div>
  )
}

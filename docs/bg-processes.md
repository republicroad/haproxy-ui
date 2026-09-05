# Best Practice: Starting Long-Running Processes from Automation

Starting a long-running process (dev server, mock API, webhook receiver)
from a shell tool, CI step, or agent session can hang the calling
session forever. This document records the root cause and the project's
standard way to avoid it.

## Root cause

When a child process inherits the parent's stdout/stderr **pipe handles**,
the calling shell keeps waiting for those pipes to close (EOF). A
long-running process never closes them, so any tool that waits for the
command to finish — and for all output streams to reach EOF — hangs until
its timeout. The process itself is usually running fine; only the session
is stuck.

Two aggravating patterns seen in this project:

- `spawn` / `Start-Process` **without** detached + `stdio: "ignore"`
  (pipes get inherited)
- starting the process **and** probing for readiness in the *same* shell
  command (long window, any slow step triggers the timeout)

## The rule

> A child started from automation must not hold any inherited pipe.
> Detach it, ignore its stdio, record its PID, and verify readiness in a
> **separate** step.

## Standard pattern (this project)

Use `scripts/start-bg.mjs`, which wraps `spawn(cmd, args, { detached:
true, stdio: "ignore" })`:

```bash
# Start (returns immediately)
node scripts/start-bg.mjs --pidfile "$TEMP/mock.pid" --name mock -- \
  node scripts/mock-dataplaneapi.mjs

# Then, in a SEPARATE command, wait for readiness with a deadline
# (port probe loop), never a blind sleep inside the same invocation.
```

Properties:

- `stdio: "ignore"` → no pipes exist, nothing to wait on, the launcher
  exits at once
- `detached: true` (+ `windowsHide`) → the child survives the launcher
  session; on POSIX it gets its own process group
- PID file → lets a later step stop the process and prevents accidental
  double-start (`start-bg` refuses when the recorded PID is alive)
- readiness checks belong in a **different** invocation: poll the port
  or an HTTP endpoint with a deadline

### Stopping

```bash
# Windows
taskkill /PID $(cat "$TEMP/mock.pid") /F /T
# POSIX
kill "$(cat "$TEMP/mock.pid")"
```

`tests/global-teardown.mjs` implements exactly this for the Playwright
suite.

## Alternatives considered (and when they fit)

| Approach | Verdict |
| --- | --- |
| `docker compose up -d` | Best option for dependency services (our hap1/hap2). Detached semantics built in. |
| Process supervisors (pm2, NSSM/WinSW, systemd) | Right choice for long-lived official services; overkill for ephemeral dev/test processes. |
| Playwright `webServer` config | Best for E2E suites; the runner owns lifecycle. |
| MSYS2/Git-Bash `& disown` | Mitigates (bash doesn't wait for background jobs) but the child still inherits handles unless redirected (`>log 2>&1 </dev/null`); switching the whole toolchain's shell for this is not worth it. |
| `Start-Job` (PowerShell) | Avoid: the job dies with the parent session. |
| Plain `&` in pwsh / `Start-Process` with `-RedirectStandardOutput` | Avoid: pipes are inherited; the calling session waits. |

## Summary checklist

1. Detach the child (`detached: true`, `stdio: "ignore"`, `windowsHide`).
2. Write a PID file; refuse double-start.
3. Verify readiness in a separate step via a bounded probe loop.
4. Stop via the PID file (never `taskkill /IM node.exe` — that kills
   unrelated processes).

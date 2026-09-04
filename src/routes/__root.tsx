import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { Toaster } from "sonner"
import { Providers } from "../components/Providers"
import { Sidebar } from "../components/Sidebar"
import ThemeToggle from "../components/ThemeToggle"
import { NotFoundPage, ErrorPage } from "../components/PageStates"

import appCss from "../styles.css?url"

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`

const UI_USER = process.env.HAPROXY_UI_USER
const UI_PASS = process.env.HAPROXY_UI_PASS

function checkBasicAuth(request: Request): boolean {
  if (!UI_USER || !UI_PASS) return true
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Basic ")) return false
  try {
    const decoded = atob(header.slice(6))
    const [user, pass] = decoded.split(":")
    return user === UI_USER && pass === UI_PASS
  } catch {
    return false
  }
}

async function serverAuthCheck() {
  if (typeof window !== "undefined") return
  if (!UI_USER || !UI_PASS) return
  try {
    const { getRequest } = await import("@tanstack/react-start/server")
    const request = getRequest()
    if (!checkBasicAuth(request)) {
      throw new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="haproxy-ui"' },
      })
    }
  } catch (e) {
    if (e instanceof Response) throw e
  }
}

export const Route = createRootRoute({
  beforeLoad: async () => {
    await serverAuthCheck()
  },
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "HAProxy UI" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  notFoundComponent: NotFoundPage,
  errorComponent: ({ error }) => <ErrorPage error={error} />,
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere]">
        <Providers>
          <div className="flex min-h-screen">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex h-14 items-center justify-end border-b border-border bg-card/40 px-4">
                <ThemeToggle />
              </header>
              <main className="flex-1 p-4 md:p-6">{children}</main>
            </div>
          </div>
          <Toaster position="bottom-right" richColors closeButton />
          <TanStackDevtools
            config={{ position: "bottom-right" }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
          <Scripts />
        </Providers>
      </body>
    </html>
  )
}

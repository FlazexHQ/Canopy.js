import type { TokenSource } from "./client-types.ts"

/** The longest delay timers keep (2147483647 ms, about 24.8 days); longer ones fire after 1 ms instead. */
const MAX_TIMER_MS = 2_147_483_647

/** The unverified claims of a JWT; the server verifies, the client only reads `exp` and `sub`. */
function claims(token: string | null | undefined): { exp?: unknown; sub?: unknown } {
  const part = token?.split(".")[1]
  if (part === undefined) return {}
  try {
    return JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/"))) as {
      exp?: unknown
      sub?: unknown
    }
  } catch {
    return {}
  }
}

/** The subject a token names, or `anon` without one; it scopes what the client persists. */
export function subjectOf(token: string | null | undefined): string {
  const sub = claims(token).sub
  return typeof sub === "string" ? sub : "anon"
}

function tokenExpiry(token: string): number | undefined {
  const exp = claims(token).exp
  return typeof exp === "number" ? exp * 1000 : undefined
}

/**
 * Keeps the connection's token fresh: reads the token for each `hello` (refreshing it first when the
 * server rejected the last one as expired), and sends `auth` with a new token at 80% of its lifetime.
 */
export class TokenRefresher {
  private readonly source: TokenSource | undefined
  private readonly sendAuth: (token: string) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private stale = false

  constructor(source: TokenSource | undefined, sendAuth: (token: string) => void) {
    this.source = source
    this.sendAuth = sendAuth
  }

  /** Makes the next {@link TokenRefresher.token} call refresh the token instead of reading it. */
  markStale(): void {
    this.stale = true
  }

  /**
   * The token for a `hello`, refreshed when the last one was marked stale and the source can refresh.
   * Returned as the source gave it, so the caller awaits it once.
   */
  token(): ReturnType<TokenSource["getToken"]> {
    const source = this.source
    const stale = this.stale && source?.refresh !== undefined
    this.stale = false
    return stale ? source?.refresh?.() : source?.getToken()
  }

  /** Plans the next `auth` for a token that expires; any earlier plan is replaced. */
  schedule(token: string | undefined): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (token === undefined || this.source === undefined) return
    const expiry = tokenExpiry(token)
    if (expiry === undefined) return
    this.refreshAt(Date.now() + Math.max(1000, (expiry - Date.now()) * 0.8))
  }

  private refreshAt(at: number): void {
    const remaining = at - Date.now()
    if (remaining > MAX_TIMER_MS) {
      this.timer = setTimeout(() => this.refreshAt(at), MAX_TIMER_MS)
      return
    }
    this.timer = setTimeout(
      () => {
        Promise.resolve(this.source?.getToken())
          .then((next) => {
            this.sendAuth(next ?? "")
            this.schedule(next ?? undefined)
          })
          .catch(() => {})
      },
      Math.max(0, remaining),
    )
  }

  /** Cancels the planned refresh. */
  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

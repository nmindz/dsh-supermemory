/**
 * Shared error utilities for mapping Supermemory API errors to user-friendly
 * messages. Errors raised by {@link ./api.ts} carry a numeric `status`, so the
 * mapping relies on that rather than `instanceof` checks.
 */

interface StatusError {
  readonly name?: string
  readonly message?: string
  readonly status?: number
}

/** Map an API error (or any Error) to a concise, actionable message. */
export function getUserFriendlyError(err: unknown): string {
  const error = (err ?? {}) as StatusError
  const status = error.status

  if (
    error.name === 'TimeoutError'
    || error.name === 'AbortError'
    || error.message === 'fetch failed'
  ) {
    return 'Supermemory unreachable (network) — continuing without memory.'
  }
  if (status === 400) {
    return 'Bad request \u2014 your API key or request format may be invalid. Check your key at https://console.supermemory.ai'
  }
  if (status === 401) {
    return 'Authentication failed \u2014 your API key may be expired or revoked. Re-authenticate with the supermemory login command or check https://console.supermemory.ai'
  }
  if (status === 403) {
    return 'Permission denied \u2014 this feature may require a different Supermemory plan. Check https://supermemory.ai/pricing'
  }
  if (status === 429) {
    return 'Rate limited \u2014 too many requests. Will retry next session.'
  }
  if (typeof status === 'number' && status >= 500) {
    return 'Supermemory service is temporarily unavailable. Will retry next session.'
  }

  return error.message || 'Unknown error'
}

/**
 * Should the caller consider retrying this request later? True for rate limits
 * (429), server errors (5xx), and network/connection errors (no HTTP status).
 */
export function isRetryableError(err: unknown): boolean {
  const status = (err as StatusError | undefined)?.status
  if (status === 429) return true
  if (typeof status === 'number' && status >= 500) return true
  // Connection / timeout errors have no status
  if (status === undefined || status === null) return true
  return false
}

/**
 * Is this error expected / harmless? 404 means the user simply has no data yet.
 * Connection and timeout errors (no HTTP status) are transient network blips.
 */
export function isBenignError(err: unknown): boolean {
  const status = (err as StatusError | undefined)?.status
  if (status === 404) return true
  // No status usually means a connection or timeout error
  if (status === undefined || status === null) return true
  return false
}

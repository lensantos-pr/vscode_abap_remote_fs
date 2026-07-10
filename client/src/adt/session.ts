/**
 * Session-expiry detection, deliberately free of vscode and configuration imports so it can be
 * reasoned about and tested on its own.
 *
 * There is intentionally no retry or auto-renewal helper here. An ADTClient freezes its auth
 * headers at construction, so a retry re-sends the credentials the server just rejected. Under
 * browser_sso those credentials include the "browser-sso" sentinel as a basic-auth password,
 * which SAP records as a wrong-password logon for the real user — so retrying an expired session
 * walks the account toward login/fails_to_user_lock. Recovery belongs to an explicit reconnect,
 * which harvests a fresh session. See invalidateSession in ./conections.
 */

const statusOf = (e: any): number | undefined => e?.status ?? e?.response?.status

/**
 * True for the HTTP 401 that ADT returns once a session is no longer valid.
 * 403 is excluded on purpose: it means the ADT service is blocked or not activated,
 * which re-authenticating cannot fix.
 */
export const isAuthExpired = (e: unknown): boolean => {
  const status = statusOf(e)
  if (typeof status === "number") return status === 401
  return /status code 401/i.test(String((e as any)?.message ?? e))
}

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

/**
 * True for a session that has silently lapsed WITHOUT a clean 401 — what an SSO reverse proxy / IdP
 * produces when it answers an expired session with a 200 HTML re-login page (or a SAML redirect)
 * instead of 401. isAuthExpired (401-only) misses this, so the ADT XML parser is handed the login
 * HTML where it expects the asx:abap/asx:values envelope and throws — leaving the object tree
 * silently empty. The tell is either that parser crash or the HTML/SAML body itself.
 *
 * Callers MUST gate this on isSsoConnection: only browser_sso/kerberos carry a frozen credential a
 * retry cannot recover. For basic/cert/oauth a stray parse error is not an expiry, and tearing the
 * session down on it would strand a recoverable connection.
 */
export const isSessionLikelyExpired = (e: unknown): boolean => {
  const err = e as any
  const haystack = [err?.message, err?.response?.body, err?.body, typeof e === "string" ? e : ""]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
  return (
    /asx:(abap|values)/i.test(haystack) || // ADT envelope missing -> login HTML fed to the XML parser
    /<!doctype html|<html[\s>]/i.test(haystack) || // IdP / SAML re-login page in the body
    /\/sap\/saml2\//i.test(haystack) // redirect to the SAML endpoint
  )
}

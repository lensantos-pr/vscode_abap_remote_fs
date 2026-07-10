import { ADTClient } from "abap-adt-api"

/**
 * Session recovery policy, deliberately free of vscode and configuration imports so it
 * can be reasoned about and tested on its own.
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
 * Re-establish a stateful ADT session on an existing client, reusing its credentials.
 *
 * Stateful sessions expire server-side after roughly 10 minutes. The language server stays
 * ahead of that by rebuilding its client every 4 minutes (see server/src/clientManager.ts);
 * the filesystem client has no such timer and recovers on demand instead. Keeping the same
 * ADTClient instance matters: Root and AFsService hold a reference to it.
 */
export async function renewSession(client: ADTClient): Promise<void> {
  // The session being dropped is already dead, so a failure here is expected and harmless.
  await client.dropSession().catch(() => undefined)
  await client.login()
  const clone = client.statelessClone
  if (!clone.loggedin) await clone.login()
}

/** Run `op`, recovering from an expired session exactly once. */
export async function retryOnExpiredSession<T>(
  op: () => Promise<T>,
  recover: () => Promise<boolean>
): Promise<T> {
  try {
    return await op()
  } catch (e) {
    if (!isAuthExpired(e)) throw e
    if (!(await recover())) throw e
    return op()
  }
}

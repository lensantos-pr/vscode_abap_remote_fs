import { RemoteManager, createClient, createAuthenticatedClient } from "../config"
import { AFsService, Root } from "abapfs"
import { Uri, FileSystemError, workspace } from "vscode"
import { ADTClient } from "abap-adt-api"
import { LogOutPendingDebuggers } from "./debugger"
import { SapSystemValidator } from "../services/sapSystemValidator"
import { LocalFsProvider } from "../fs/LocalFsProvider"
import { log } from "../lib"
import { clearSsoCookies } from "../auth"
export { isAuthExpired } from "./session"
export const ADTSCHEME = "adt"
export const ADTURIPATTERN = /\/sap\/bc\/adt\//

const roots = new Map<string, Root>()
const clients = new Map<string, ADTClient>()
const creations = new Map<string, Promise<void>>()

const missing = (connId: string) => {
  return FileSystemError.FileNotFound(`No ABAP server defined for ${connId}`)
}

/**
 * Throw away everything cached for a connection whose credentials the server rejected.
 *
 * Retrying is not an option here. Under browser_sso the ADTClient carries the "browser-sso"
 * sentinel as its basic-auth password, so any request made with a rejected cookie is recorded
 * by SAP as a wrong-password logon for the real user and counts toward login/fails_to_user_lock.
 * The stored cookies are dropped so the next connect harvests a fresh session rather than
 * replaying the dead one, and the connection is marked failed so background filesystem calls
 * stop hitting the server until the user reconnects.
 */
export function invalidateSession(connId: string): void {
  const client = clients.get(connId)
  clients.delete(connId)
  roots.delete(connId)

  void clearSsoCookies(connId).catch(() => undefined)
  if (client) void client.logout().catch(() => undefined)

  failedConnections.set(
    connId,
    `Session expired for ${connId}. Reconnect to sign in again.`
  )
  log(`Invalidated expired session for ${connId} — stored SSO cookies dropped`)
}

export const abapUri = (u?: Uri) => u?.scheme === ADTSCHEME && !LocalFsProvider.useLocalStorage(u)

async function create(connId: string) {
  const manager = RemoteManager.get()
  const connection = await manager.byIdAsync(connId)
  if (!connection) throw Error(`Connection not found ${connId}`)

  // 🔐 VALIDATE SYSTEM ACCESS BEFORE CLIENT CREATION
  log(`🔍 Validating SAP system access for connection: ${connId}`)
  const validator = SapSystemValidator.getInstance()
  await validator.validateSystemAccess(
    connection.url,
    connection.sapGui?.server,
    connection.username
  )
  log(`✅ SAP system validation passed for: ${connId}`)

  const authMethod = (connection as any).authMethod || "basic"
  const validAuthMethods = ["basic", "cert", "kerberos", "browser_sso", "oauth_onprem"]
  if (!validAuthMethods.includes(authMethod)) {
    log(`⚠️ Unknown authMethod '${authMethod}' for ${connId} — falling back to basic auth`)
  }
  log.debug(
    `[connect] Creating client for ${connId}: authMethod=${authMethod}, hasOAuth=${!!connection.oauth}, hasPassword=${!!connection.password}`
  )
  let client: ADTClient

  if (authMethod !== "basic" && validAuthMethods.includes(authMethod)) {
    log.debug(`[connect] Using createAuthenticatedClient for ${connId} (${authMethod})`)
    client = await createAuthenticatedClient(connection)
    await client.login()
    log.debug(`[connect] client.login() succeeded for ${connId}`)
    await client.statelessClone.login()
    log.debug(`[connect] statelessClone.login() succeeded for ${connId}`)
  } else if (connection.oauth || connection.password) {
    client = createClient(connection)
    await client.login() // raise exception for login issues
    await client.statelessClone.login()
  } else {
    const password = (await manager.askPassword(connection.name)) || ""
    if (!password) throw Error("Can't connect without a password")
    client = await createClient({ ...connection, password })
    await client.login() // raise exception for login issues
    await client.statelessClone.login()
    connection.password = password
    const { name, username } = connection
    await manager.savePassword(name, username, password)
  }

  // @ts-ignore
  const service = new AFsService(client)
  const newRoot = new Root(connId, service)
  roots.set(connId, newRoot)
  clients.set(connId, client)
}

// Track connections that failed with non-retryable errors (e.g. SSO timeout, auth rejection)
// to prevent VS Code filesystem from triggering infinite retry loops
const failedConnections = new Map<string, string>() // connId → error message

function createIfMissing(connId: string) {
  if (roots.get(connId)) return
  // If connection previously failed with a non-retryable error, don't retry
  const failReason = failedConnections.get(connId)
  if (failReason) {
    return Promise.reject(new Error(failReason))
  }
  let creation = creations.get(connId)
  if (!creation) {
    creation = create(connId).catch(err => {
      // Mark as permanently failed if it's an interactive/auth error
      // so VS Code filesystem doesn't keep triggering retry loops
      const msg = String(err?.message || err)
      if (
        msg.includes("timed out") ||
        msg.includes("SSO") ||
        msg.includes("authentication") ||
        msg.includes("OAuth") ||
        msg.includes("401") ||
        msg.includes("403") ||
        msg.includes("cancelled") ||
        msg.includes("Can't connect without a password")
      ) {
        log.debug(`[connect] Marking ${connId} as failed (no auto-retry): ${msg.substring(0, 100)}`)
        failedConnections.set(
          connId,
          `Connection failed: ${msg}. Disconnect and reconnect to retry.`
        )
      }
      throw err
    })
    creations.set(connId, creation)
    creation.finally(() => creations.delete(connId))
  }
  return creation
}

/** Clear the failed state for a connection (called on disconnect/reconnect). */
export function clearConnectionFailure(connId: string) {
  failedConnections.delete(connId)
}

export async function getOrCreateClient(connId: string, clone = true) {
  if (!clients.has(connId)) {
    try {
      await createIfMissing(connId)
    } catch (error) {
      // Re-throw validation errors with original message instead of generic "missing" error
      throw error // Preserve the original validation error message
    }
  }
  return getClient(connId, clone)
}

export function getClient(connId: string, clone = true) {
  const client = clients.get(connId)
  if (client) return clone ? client.statelessClone : client

  // If client doesn't exist, this means validation failed or connection was never established
  // Instead of generic "missing" error, provide more helpful feedback
  throw new Error(
    `SAP system '${connId}' is not accessible. This may be due to whitelist restrictions or connection issues. Check the extension logs for validation details.`
  )
}

export const getRoot = (connId: string) => {
  const root = roots.get(connId)
  if (root) return root
  throw missing(connId)
}

export const uriRoot = (uri: Uri) => {
  if (abapUri(uri)) return getRoot(uri.authority)
  throw missing(uri.toString())
}

export const getOrCreateRoot = async (connId: string) => {
  if (!roots.has(connId)) await createIfMissing(connId)
  return getRoot(connId)
}

export function hasLocks() {
  for (const root of roots.values()) if (root.lockManager.lockedPaths().next().value) return true
}
export async function disconnect() {
  const connected = [...clients.values()]
  const main = connected.map(c => c.logout())
  const clones = connected
    .map(c => c.statelessClone)
    .filter(c => c.loggedin)
    .map(c => c.logout())
  await Promise.all([...main, ...clones, ...LogOutPendingDebuggers()])
  // Clear all failure states so reconnect is possible
  failedConnections.clear()
  // Drop the cached clients and roots too. Without this, reconnecting silently reuses the
  // client we just logged out: getOrCreateRoot short-circuits on the surviving root, and
  // every later request fails with 401 until the window is reloaded.
  clients.clear()
  roots.clear()
  return
}

export const rootIsConnected = (connId: string) =>
  !!workspace.workspaceFolders?.find(
    f => f.uri.scheme === ADTSCHEME && f.uri.authority === connId?.toLowerCase()
  )

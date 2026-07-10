import { RemoteManager, createClient, createAuthenticatedClient } from "../config"
import { AFsService, Root } from "abapfs"
import { Uri, FileSystemError, workspace } from "vscode"
import { ADTClient } from "abap-adt-api"
import { LogOutPendingDebuggers } from "./debugger"
import { SapSystemValidator } from "../services/sapSystemValidator"
import { LocalFsProvider } from "../fs/LocalFsProvider"
import { log } from "../lib"
import { recoverSession } from "./session"
export { isAuthExpired, recoverSession, renewSession, retryOnExpiredSession } from "./session"
export const ADTSCHEME = "adt"
export const ADTURIPATTERN = /\/sap\/bc\/adt\//

const roots = new Map<string, Root>()
const clients = new Map<string, ADTClient>()
const creations = new Map<string, Promise<void>>()

const missing = (connId: string) => {
  return FileSystemError.FileNotFound(`No ABAP server defined for ${connId}`)
}

/**
 * Forget everything cached for a connection so the next access builds it from scratch.
 * The old client is logged out on a best-effort basis: its session is usually already dead.
 */
async function disposeConnection(connId: string) {
  const client = clients.get(connId)
  clients.delete(connId)
  roots.delete(connId)
  failedConnections.delete(connId)
  if (client) {
    await client.logout().catch(() => undefined)
    if (client.statelessClone.loggedin) await client.statelessClone.logout().catch(() => undefined)
  }
}

/** Discard the dead client and reconnect, which re-harvests the SSO cookies. */
async function rebuildConnection(connId: string): Promise<boolean> {
  await disposeConnection(connId)
  try {
    await create(connId)
    log(`Rebuilt connection ${connId} with fresh credentials`)
    return true
  } catch (e) {
    // Leave the maps empty rather than marking the connection permanently failed,
    // so a later access is free to try again.
    log(`Could not rebuild connection ${connId}: ${caughtMessage(e)}`)
    await disposeConnection(connId)
    return false
  }
}

const caughtMessage = (e: any) => String(e?.message ?? e)

// Collapses the burst of parallel 401s that VS Code produces when several
// filesystem operations hit an expired session at once.
const reauths = new Map<string, Promise<boolean>>()

/** Recover the session behind `connId`. Returns false when it cannot be restored. */
export function reauthenticate(connId: string): Promise<boolean> {
  const pending = reauths.get(connId)
  if (pending) return pending

  const attempt = recoverSession(clients.get(connId), () => rebuildConnection(connId))
    .then(ok => {
      if (ok) log(`Recovered expired session for ${connId}`)
      return ok
    })
    .catch(e => {
      log(`Could not recover session for ${connId}: ${caughtMessage(e)}`)
      return false
    })
  reauths.set(connId, attempt)
  attempt.finally(() => reauths.delete(connId))
  return attempt
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

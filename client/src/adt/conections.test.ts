jest.mock(
  "vscode",
  () => ({
    FileSystemError: {
      FileNotFound: (msg: string) => new Error(`FileNotFound: ${msg}`)
    },
    workspace: {
      workspaceFolders: undefined
    },
    Uri: {
      parse: jest.fn((s: string) => ({
        scheme: s.split("://")[0],
        authority: s.split("://")[1]?.split("/")[0],
        toString: () => s
      }))
    }
  }),
  { virtual: true }
)

jest.mock("../config", () => ({
  RemoteManager: { get: jest.fn() },
  createClient: jest.fn()
}))

jest.mock("./debugger", () => ({ LogOutPendingDebuggers: jest.fn().mockResolvedValue([]) }))
jest.mock("../services/sapSystemValidator", () => ({
  SapSystemValidator: {
    getInstance: jest
      .fn()
      .mockReturnValue({ validateSystemAccess: jest.fn().mockResolvedValue(undefined) })
  }
}))
jest.mock("../fs/LocalFsProvider", () => ({
  LocalFsProvider: { useLocalStorage: jest.fn().mockReturnValue(false) }
}))
jest.mock("../lib", () => ({ log: jest.fn() }))
jest.mock("abapfs", () => ({}))
jest.mock("../auth", () => ({ clearSsoCookies: jest.fn().mockResolvedValue(undefined) }))

import {
  ADTSCHEME,
  ADTURIPATTERN,
  abapUri,
  getClient,
  getRoot,
  rootIsConnected,
  isSsoConnection,
  invalidateSession,
  getOrCreateRoot
} from "./conections"
import { isAuthExpired } from "./session"

describe("ADTSCHEME", () => {
  it("is 'adt'", () => {
    expect(ADTSCHEME).toBe("adt")
  })
})

describe("ADTURIPATTERN", () => {
  it("matches ADT URI paths", () => {
    expect(ADTURIPATTERN.test("/sap/bc/adt/programs/programs/zprog")).toBe(true)
    expect(ADTURIPATTERN.test("/sap/bc/adt/classes/classes/zcl_test/source/main")).toBe(true)
  })

  it("does not match non-ADT paths", () => {
    expect(ADTURIPATTERN.test("/some/other/path")).toBe(false)
    expect(ADTURIPATTERN.test("/sap/bc/gui")).toBe(false)
  })
})

describe("abapUri", () => {
  it("returns true for adt:// URIs", () => {
    const uri = { scheme: "adt" } as any
    expect(abapUri(uri)).toBe(true)
  })

  it("returns false for file:// URIs", () => {
    const uri = { scheme: "file" } as any
    expect(abapUri(uri)).toBe(false)
  })

  it("returns false/undefined for undefined", () => {
    expect(abapUri(undefined)).toBeFalsy()
  })

  it("returns false for untitled scheme", () => {
    const uri = { scheme: "untitled" } as any
    expect(abapUri(uri)).toBeFalsy()
  })
})

describe("getClient", () => {
  it("throws when connection not established", () => {
    expect(() => getClient("nonexistent_conn")).toThrow()
  })

  it("throws with helpful message about inaccessible system", () => {
    expect(() => getClient("nonexistent_conn")).toThrow(/not accessible|not found/i)
  })
})

describe("getRoot", () => {
  it("throws FileNotFound when root not established", () => {
    expect(() => getRoot("nonexistent_conn")).toThrow(/FileNotFound/)
  })
})

describe("rootIsConnected", () => {
  it("returns false when workspaceFolders is undefined", () => {
    const { workspace } = require("vscode")
    workspace.workspaceFolders = undefined
    expect(rootIsConnected("myconn")).toBe(false)
  })

  it("returns false when no matching ADT folder", () => {
    const { workspace } = require("vscode")
    workspace.workspaceFolders = [{ uri: { scheme: "file", authority: "myconn" } }]
    expect(rootIsConnected("myconn")).toBe(false)
  })

  it("returns true when matching ADT folder exists", () => {
    const { workspace } = require("vscode")
    workspace.workspaceFolders = [{ uri: { scheme: "adt", authority: "myconn" } }]
    expect(rootIsConnected("myconn")).toBe(true)
  })

  it("is case-insensitive for connId", () => {
    const { workspace } = require("vscode")
    workspace.workspaceFolders = [{ uri: { scheme: "adt", authority: "myconn" } }]
    expect(rootIsConnected("MYCONN")).toBe(true)
  })
})

describe("isAuthExpired", () => {
  it("detects an AdtHttpException carrying status 401", () => {
    expect(isAuthExpired({ status: 401 })).toBe(true)
  })

  it("detects a nested axios-style response status", () => {
    expect(isAuthExpired({ response: { status: 401 } })).toBe(true)
  })

  it("detects the legacy 'status code 401' message", () => {
    expect(isAuthExpired(new Error("Request failed with status code 401"))).toBe(true)
  })

  it("ignores 403, which is a proxy/SICF problem rather than an expired session", () => {
    expect(isAuthExpired({ status: 403 })).toBe(false)
  })

  it("ignores DNS failures", () => {
    expect(isAuthExpired(new Error("getaddrinfo ENOTFOUND sap.example.com"))).toBe(false)
  })
})

describe("isSsoConnection", () => {
  const { RemoteManager } = require("../config")
  const withAuthMethod = (authMethod?: string) =>
    (RemoteManager.get as jest.Mock).mockReturnValue({
      byId: () => (authMethod ? { authMethod } : undefined)
    })

  it("is true for browser_sso — its cookie is frozen at construction, a retry cannot recover", () => {
    withAuthMethod("browser_sso")
    expect(isSsoConnection("c")).toBe(true)
  })

  it("is true for kerberos — its ticket header is likewise frozen", () => {
    withAuthMethod("kerberos")
    expect(isSsoConnection("c")).toBe(true)
  })

  it("is false for basic auth — it keeps a password and re-authenticates itself", () => {
    withAuthMethod("basic")
    expect(isSsoConnection("c")).toBe(false)
  })

  it("is false for oauth_onprem — it holds a token fetcher, not a frozen credential", () => {
    withAuthMethod("oauth_onprem")
    expect(isSsoConnection("c")).toBe(false)
  })

  it("is false when the connection is unknown", () => {
    withAuthMethod(undefined)
    expect(isSsoConnection("c")).toBe(false)
  })
})

describe("invalidateSession", () => {
  it("marks the connection failed so a background reconnect cannot replay a dead session", async () => {
    const { clearSsoCookies } = require("../auth")
    invalidateSession("sso_expired_conn")

    // The stored SSO cookies are dropped so the next connect harvests a fresh session…
    expect(clearSsoCookies).toHaveBeenCalledWith("sso_expired_conn")
    // …and the connection is marked failed, so filesystem calls short-circuit (no retry storm,
    // no replayed dead session) until the user explicitly reconnects.
    await expect(getOrCreateRoot("sso_expired_conn")).rejects.toThrow(/expired|reconnect/i)
  })

  it("is safe to call when nothing is cached for the connection", () => {
    expect(() => invalidateSession("never_connected")).not.toThrow()
  })
})

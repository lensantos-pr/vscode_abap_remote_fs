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
jest.mock("../lib", () => ({ log: Object.assign(jest.fn(), { debug: jest.fn() }) }))
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
  getOrCreateRoot,
  renewSsoSession
} from "./conections"
import { isAuthExpired, isSessionLikelyExpired } from "./session"

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

describe("isSessionLikelyExpired", () => {
  it("detects the ADT XML-parser crash when an IdP page is fed to it instead of asx:abap", () => {
    // The exact TypeError thrown by abap-adt-api's parsePackageResponse when the nodestructure
    // response is an SSO login page (no asx:abap envelope) — the reported System Library symptom.
    expect(
      isSessionLikelyExpired(
        new Error("Cannot read properties of undefined (reading 'asx:values')")
      )
    ).toBe(true)
  })

  it("detects a 200 response whose body is an IdP/SAML HTML login page", () => {
    expect(
      isSessionLikelyExpired({
        response: { status: 200, body: "<!DOCTYPE html><html><head><title>Sign in</title>" }
      })
    ).toBe(true)
  })

  it("detects a redirect to the SAML endpoint", () => {
    expect(isSessionLikelyExpired(new Error("redirected to /sap/saml2/sp/acs"))).toBe(true)
  })

  it("does not fire on a plain 401 — that is isAuthExpired's job, not this one", () => {
    expect(isSessionLikelyExpired({ status: 401 })).toBe(false)
  })

  it("does not fire on ordinary ADT errors (no false positive teardown)", () => {
    expect(isSessionLikelyExpired(new Error("Request failed with status code 404"))).toBe(false)
    expect(isSessionLikelyExpired(new Error("getaddrinfo ENOTFOUND sap.example.com"))).toBe(false)
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

describe("renewSsoSession", () => {
  const { RemoteManager } = require("../config")
  const asAuthMethod = (authMethod: string) =>
    (RemoteManager.get as jest.Mock).mockReturnValue({ byId: () => ({ authMethod }) })

  it("does nothing (and never harvests) for a non-SSO connection", async () => {
    asAuthMethod("basic")
    const harvest = jest.fn()
    const rebuild = jest.fn()
    expect(await renewSsoSession("renew_basic", { harvest, rebuild })).toBe(false)
    expect(harvest).not.toHaveBeenCalled()
    expect(rebuild).not.toHaveBeenCalled()
  })

  it("harvests a fresh session then rebuilds the client on success", async () => {
    asAuthMethod("browser_sso")
    const harvest = jest.fn().mockResolvedValue(undefined)
    const rebuild = jest.fn().mockResolvedValue(undefined)
    expect(await renewSsoSession("renew_ok", { harvest, rebuild })).toBe(true)
    expect(harvest).toHaveBeenCalledWith("renew_ok")
    expect(rebuild).toHaveBeenCalledWith("renew_ok")
  })

  it("degrades to invalidateSession and never rebuilds when the IdP needs interaction", async () => {
    asAuthMethod("browser_sso")
    const { clearSsoCookies } = require("../auth")
    ;(clearSsoCookies as jest.Mock).mockClear()
    const harvest = jest.fn().mockRejectedValue(new Error("Silent SSO renewal needs interaction"))
    const rebuild = jest.fn()
    expect(await renewSsoSession("renew_needs_ui", { harvest, rebuild })).toBe(false)
    // Safety-critical: a failed harvest must NEVER lead to a client rebuild…
    expect(rebuild).not.toHaveBeenCalled()
    // …and it degrades to the safe reconnect path (invalidateSession drops the stored cookies).
    expect(clearSsoCookies).toHaveBeenCalledWith("renew_needs_ui")
  })

  it("degrades when the rebuild itself fails", async () => {
    asAuthMethod("browser_sso")
    const harvest = jest.fn().mockResolvedValue(undefined)
    const rebuild = jest.fn().mockRejectedValue(new Error("login failed"))
    expect(await renewSsoSession("renew_rebuild_fail", { harvest, rebuild })).toBe(false)
  })

  it("coalesces concurrent renewals into a single harvest", async () => {
    asAuthMethod("browser_sso")
    let harvests = 0
    const harvest = jest.fn().mockImplementation(
      () =>
        new Promise<void>(res => {
          harvests++
          setTimeout(res, 10)
        })
    )
    const rebuild = jest.fn().mockResolvedValue(undefined)
    const results = await Promise.all([
      renewSsoSession("renew_coalesce", { harvest, rebuild }),
      renewSsoSession("renew_coalesce", { harvest, rebuild })
    ])
    expect(results).toEqual([true, true])
    expect(harvests).toBe(1)
  })
})

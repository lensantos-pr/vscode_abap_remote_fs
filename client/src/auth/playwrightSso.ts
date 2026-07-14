/**
 * Playwright-driven automated SSO cookie harvest.
 *
 * Launches an already-installed browser (Edge/Chrome) via `playwright-core`
 * — no browser binary is downloaded — navigates to the ADT discovery endpoint,
 * lets the corporate SAML redirect chain (e.g. Entra ID -> SAP IAS -> SAP ACS)
 * complete interactively in a visible window, then reads the SAP session
 * cookies straight out of the browser context. No DevTools copy/paste.
 *
 * Ported from leap-object-registry's `srv/lib/adt-client/sso-login.js`.
 *
 * `playwright-core` is an OPTIONAL dependency loaded lazily: if it (or the
 * chosen browser channel) is missing, this throws PlaywrightUnavailableError
 * so the caller can fall back to the manual cookie-capture helper.
 */

import * as os from "os"
import * as path from "path"
import { log } from "../lib"
import { errorMessage } from "./utils"
import type { BrowserSsoConfig } from "vscode-abap-remote-fs-sharedapi"

/** Thrown when automated capture cannot run and the caller should fall back to manual. */
export class PlaywrightUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlaywrightUnavailableError"
  }
}

/**
 * Thrown when a headless/silent harvest cannot complete without the user — the IdP presented a
 * login form or a client-certificate prompt, or its own session has expired. The caller should
 * degrade to an interactive reconnect rather than retry silently.
 */
export class InteractionRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InteractionRequiredError"
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_PROFILE_DIR = path.join(os.homedir(), ".abapfs-sso-profile")
const DEFAULT_CHANNEL = "msedge"
/** Exact SAP cookie names always harvested (SAP_SESSIONID* is matched by prefix). */
const SAP_COOKIE_NAMES = ["MYSAPSSO2", "sap-usercontext"]

const isSapSessionCookie = (name: string): boolean => name.startsWith("SAP_SESSIONID")

/**
 * Lazy, webpack-safe require of playwright-core. It is listed in webpack
 * `externals`, so this resolves it from node_modules at runtime rather than
 * bundling it. Absence is turned into a typed error for graceful fallback.
 */
function loadPlaywright(): typeof import("playwright-core") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("playwright-core")
  } catch {
    throw new PlaywrightUnavailableError(
      "playwright-core is not installed. Install it for automated browser SSO " +
        "(`npm install playwright-core`), or set abapfs remote browserSso.mode to " +
        '"manual" to paste cookies instead.'
    )
  }
}

/**
 * Drive an installed browser through the SAP SSO flow and return the harvested
 * SAP session cookies as `name=value` strings.
 *
 * @throws PlaywrightUnavailableError when playwright-core or the browser channel
 *         is not available (caller should fall back to manual capture).
 * @throws Error when the flow completes but no SAP session cookie is found.
 */
export async function capturePlaywrightCookies(
  sapUrl: string,
  sapClient: string,
  config?: BrowserSsoConfig
): Promise<string[]> {
  const pw = loadPlaywright()

  const timeout = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const channel = config?.channel ?? DEFAULT_CHANNEL
  const profileDir = config?.profileDir || DEFAULT_PROFILE_DIR
  const headless = config?.headless ?? false
  const extraNames = config?.cookieNames ?? []

  const targetUrl = `${sapUrl}/sap/bc/adt/discovery?sap-client=${encodeURIComponent(sapClient)}`
  const sapHost = new URL(sapUrl).hostname
  // Last three labels (e.g. sap.pernod-ricard.app) as an intranet proxy-bypass hint.
  const sapDomain = sapHost.split(".").slice(-3).join(".")

  log.debug(`[browser-sso] Launching "${channel}" via Playwright for automated SSO: ${targetUrl}`)

  let context: import("playwright-core").BrowserContext
  try {
    context = await pw.chromium.launchPersistentContext(profileDir, {
      channel,
      headless,
      args: [
        "--no-first-run",
        "--disable-blink-features=AutomationControlled",
        // Match corporate GPO: allow Negotiate/Kerberos to all hosts.
        "--auth-server-allowlist=*",
        "--auth-negotiate-delegate-allowlist=*",
        // SAP is on the intranet — bypass the corporate proxy for it.
        `--proxy-bypass-list=*.${sapDomain};*.sap.${sapDomain};<local>`
      ],
      ignoreHTTPSErrors: true,
      viewport: { width: 640, height: 480 }
    })
  } catch (e) {
    throw new PlaywrightUnavailableError(
      `Could not launch browser channel "${channel}" for SSO: ${errorMessage(e)}. ` +
        "Ensure the browser is installed or set abapfs remote browserSso.channel."
    )
  }

  try {
    const page = context.pages()[0] || (await context.newPage())
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout })

    // Wait for the SAML chain to land back on an ADT (or SAML ACS) URL.
    if (!page.url().includes("/sap/bc/adt/")) {
      await page
        .waitForURL(
          url => url.toString().includes("/sap/bc/adt/") || url.toString().includes("/sap/saml2/"),
          { timeout }
        )
        .catch(() => undefined)
      // ACS still processing the assertion — give it a moment to set cookies.
      if (page.url().includes("/sap/saml2/")) await page.waitForTimeout(3000)
    }

    const allCookies = await context.cookies()
    const wanted = new Set([...SAP_COOKIE_NAMES, ...extraNames])
    const sapCookies = allCookies.filter(c => isSapSessionCookie(c.name) || wanted.has(c.name))

    if (!sapCookies.some(c => isSapSessionCookie(c.name) || c.name === "MYSAPSSO2")) {
      if (headless)
        throw new InteractionRequiredError(
          "Silent SSO renewal could not complete headlessly — the IdP needs interaction " +
            "(login or client-certificate selection), or its session has expired."
        )
      throw new Error(
        "SSO completed but no SAP session cookie (SAP_SESSIONID*/MYSAPSSO2) was found. " +
          "Check the system's ICF/SAML2 configuration."
      )
    }

    const cookies = sapCookies.map(c => `${c.name}=${c.value}`)
    log.debug(
      `[browser-sso] Harvested ${cookies.length} SAP cookies: ${sapCookies
        .map(c => c.name)
        .join(", ")}`
    )
    return cookies
  } finally {
    await context.close().catch(() => undefined)
  }
}

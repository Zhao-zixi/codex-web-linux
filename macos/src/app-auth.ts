import { session, shell } from "electron"
import { SESSION_COOKIE } from "./fleet"
import { readPrefs, writePrefs } from "./prefs"
import { newKeyPair, openSealed } from "./seal"

/**
 * The URL scheme this app answers on, registered in electron-builder.yml.
 * kanna.sh only hands a session to the schemes in APP_AUTH_SCHEMES
 * (kanna-site src/worker/cloud/app-handoff.ts).
 */
export const URL_SCHEME = "kanna-app"

/**
 * Signs the window in to kanna.sh with the default browser's session.
 *
 * The app never shows a sign-in of its own. Putting this Mac online is the
 * web wizard's claim link, in the browser, like the CLI. A session in the app
 * is needed only to open another machine in the Fleet (the kanna.sh proxy
 * gates its page on the session cookie), so it's asked for then:
 *
 * 1. The app makes a P-256 key and opens kanna.sh/app-auth?key=…&scheme=…
 *    in the default browser, where the user is usually signed in already.
 * 2. They click Open Kanna. kanna.sh makes a new session and seals it to the
 *    key (seal.ts).
 * 3. The browser opens <scheme>://auth?session=…, and the app opens the seal
 *    and sets the session cookie in the window's cookie store.
 *
 * The sealed session can ride a URL any app could catch, because only the
 * key kept here opens it.
 */
let onSignedIn: (() => void) | null = null

export function signIn(site: string, then: () => void) {
  onSignedIn = then
  const keys = newKeyPair()
  // Kept across a relaunch so a sign-in finished afterwards still lands.
  writePrefs({ appAuthKey: keys.privateKey })
  const url = new URL("/app-auth", site)
  url.searchParams.set("key", keys.publicKey)
  url.searchParams.set("scheme", URL_SCHEME)
  void shell.openExternal(url.toString())
}

/** <scheme>://auth?session=… from the browser. */
export async function handleAuthCallback(url: URL, site: string) {
  const sealed = url.searchParams.get("session")
  const key = readPrefs().appAuthKey
  if (!sealed || !key) return
  const token = openSealed(sealed, key)
  if (!token) return
  writePrefs({ appAuthKey: undefined })
  // The session cookie kanna.sh would set: every machine subdomain sees it.
  const host = new URL(site).hostname
  await session.defaultSession.cookies.set({
    url: `https://${host}/`,
    domain: `.${host}`,
    path: "/",
    name: SESSION_COOKIE,
    value: token,
    secure: true,
    httpOnly: true,
    expirationDate: Date.now() / 1000 + 400 * 24 * 60 * 60,
  })
  onSignedIn?.()
  onSignedIn = null
}

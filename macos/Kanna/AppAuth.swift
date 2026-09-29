import AppKit
import CryptoKit
import WebKit

/// Signs the window in to kanna.sh with the default browser's session.
///
/// The app never shows a sign-in of its own. Putting this Mac online is the
/// web wizard's claim link, in the browser, like the CLI. A session in the
/// app is needed only to open another machine in the Fleet (the kanna.sh
/// proxy gates its page on the session cookie), so it's asked for then:
///
/// 1. The app makes a P-256 key and opens kanna.sh/app-auth?key=…&scheme=…
///    in the default browser, where the user is usually signed in already.
/// 2. They click Open Kanna. kanna.sh makes a new session and seals it to
///    the key (kanna-site src/worker/cloud/app-handoff.ts): ECDH with a
///    throwaway key, HKDF-SHA256 with info "kanna-app-auth", AES-256-GCM.
/// 3. The browser opens <scheme>://auth?session=…, the app opens the seal
///    and sets the session cookie in the window's cookie store.
///
/// The sealed session can ride a URL any app could catch, because only the
/// key kept here opens it.
@MainActor
final class AppAuth {
  static let shared = AppAuth()

  /// Kept across a relaunch (Full Disk Access's Quit & Reopen, say) so a
  /// sign-in finished afterwards still lands.
  private static let keyDefaultsKey = "appAuthKey"
  private var onSignedIn: (() -> Void)?

  /// The URL scheme this build answers on: kanna-app, or kanna-app-dev for
  /// Kanna Dev (KANNA_URL_SCHEME in project.yml).
  static var urlScheme: String {
    let types = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]]
    return (types?.first?["CFBundleURLSchemes"] as? [String])?.first ?? "kanna-app"
  }

  func signIn(site: URL, then onSignedIn: @escaping () -> Void) {
    self.onSignedIn = onSignedIn
    let key = P256.KeyAgreement.PrivateKey()
    UserDefaults.standard.set(key.rawRepresentation, forKey: Self.keyDefaultsKey)
    var components = URLComponents(url: site.appendingPathComponent("app-auth"), resolvingAgainstBaseURL: false)!
    components.queryItems = [
      URLQueryItem(name: "key", value: Self.base64URL(key.publicKey.x963Representation)),
      URLQueryItem(name: "scheme", value: Self.urlScheme),
    ]
    NSWorkspace.shared.open(components.url!)
  }

  /// <scheme>://auth?session=… from the browser.
  func handleCallback(_ components: URLComponents, site: URL) {
    guard let sealed = components.queryItems?.first(where: { $0.name == "session" })?.value,
          let raw = UserDefaults.standard.data(forKey: Self.keyDefaultsKey),
          let key = try? P256.KeyAgreement.PrivateKey(rawRepresentation: raw),
          let token = Self.open(sealed, with: key) else { return }
    UserDefaults.standard.removeObject(forKey: Self.keyDefaultsKey)
    Task {
      await Self.setSessionCookie(token, site: site)
      onSignedIn?()
      onSignedIn = nil
    }
  }

  /// The session cookie kanna.sh would set: every machine subdomain sees it.
  private static func setSessionCookie(_ token: String, site: URL) async {
    guard let host = site.host,
          let cookie = HTTPCookie(properties: [
            .domain: ".\(host)",
            .path: "/",
            .name: Fleet.sessionCookieName,
            .value: token,
            .secure: "TRUE",
            .expires: Date().addingTimeInterval(400 * 24 * 60 * 60),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
          ]) else { return }
    await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
  }

  /// `ephemeralPublicKey (65) ‖ iv (12) ‖ ciphertext ‖ tag (16)`, base64url.
  nonisolated static func open(_ sealed: String, with key: P256.KeyAgreement.PrivateKey) -> String? {
    guard let data = base64URLDecode(sealed), data.count > 65 + 12 + 16,
          let ephemeral = try? P256.KeyAgreement.PublicKey(x963Representation: data.prefix(65)),
          let shared = try? key.sharedSecretFromKeyAgreement(with: ephemeral) else { return nil }
    let symmetric = shared.hkdfDerivedSymmetricKey(
      using: SHA256.self,
      salt: Data(),
      sharedInfo: Data("kanna-app-auth".utf8),
      outputByteCount: 32
    )
    let body = data.dropFirst(65)
    guard let nonce = try? AES.GCM.Nonce(data: body.prefix(12)),
          let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: body.dropFirst(12).dropLast(16), tag: body.suffix(16)),
          let plain = try? AES.GCM.open(box, using: symmetric) else { return nil }
    return String(data: plain, encoding: .utf8)
  }

  nonisolated static func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  nonisolated static func base64URLDecode(_ value: String) -> Data? {
    var base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)
  }
}

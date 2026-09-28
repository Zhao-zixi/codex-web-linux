import AuthenticationServices
import Foundation
import Security

/// Puts this Mac on Kanna Cloud (https://<login>-<name>.kanna.sh) from the
/// setup sheet, without a browser tab.
///
/// Sign-in is ASWebAuthenticationSession, as in the iOS app: the system
/// sheet shares Safari's GitHub session and passwords, and the app never sees
/// them. kanna.sh hands the session token back on kanna://auth, and the app
/// keeps it in the Keychain.
///
/// Pairing reuses the machine's device-code flow: the local server asks
/// kanna.sh for a claim code and polls it (src/server/cloud/pair-session.ts),
/// and the app, signed in, claims that code the way the kanna.sh/machine page
/// would. The server writes ~/.kanna/cloud.json and brings the tunnel up on
/// its own.
@MainActor
final class CloudSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
  enum CloudError: LocalizedError {
    case unsupported
    case server(String)
    case signInExpired

    var errorDescription: String? {
      switch self {
      case .unsupported:
        return "This Kanna server can't be paired right now. If Kanna Cloud was turned off, run `kanna pair --enable`. If it was started with --no-cloud, --share or --host, restart it without them."
      case .server(let message):
        return message
      case .signInExpired:
        return "Your kanna.sh sign-in expired. Sign in again."
      }
    }
  }

  struct Account {
    let githubLogin: String
  }

  private let server: URL
  private weak var window: NSWindow?
  private var session: ASWebAuthenticationSession?

  init(server: URL, window: NSWindow?) {
    self.server = server
    self.window = window
  }

  // MARK: Pairing state

  /// The machine's public address, from cloud.json in the current mode's
  /// data root (~/.kanna, or ~/.kanna-dev in Development). The file also
  /// holds the machine's secrets; only these two fields are read.
  static func pairedOrigin() -> URL? {
    // A custom server keeps its data wherever its owner put it.
    guard let url = ServerMode.current.dataRoot?.appendingPathComponent("cloud.json"),
          let data = try? Data(contentsOf: url),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          json["enabled"] as? Bool != false,
          let origin = json["appOrigin"] as? String else { return nil }
    return URL(string: origin)
  }

  /// Starts (or rejoins) the server's device-code session and returns the
  /// claim code plus the control plane it belongs to (kanna.sh, or whatever
  /// KANNA_CLOUD_CONTROL_URL points the server at).
  private func startPairSession() async throws -> (code: String, site: URL) {
    var request = URLRequest(url: server.appendingPathComponent("api/cloud/pair-session"))
    request.httpMethod = "POST"
    let body = try await Self.json(for: request)
    let status = body["status"] as? String
    if status == "unsupported" { throw CloudError.unsupported }
    if status == "paired" { throw CloudError.server("This Mac is already on Kanna Cloud.") }
    guard let claim = (body["claimUrl"] as? String).flatMap(URL.init(string:)),
          let components = URLComponents(url: claim, resolvingAgainstBaseURL: false),
          let code = components.queryItems?.first(where: { $0.name == "pair" })?.value,
          let scheme = components.scheme, let host = components.host else {
      throw CloudError.server(body["error"] as? String ?? "kanna.sh didn't answer. Check your connection and try again.")
    }
    var site = URLComponents()
    site.scheme = scheme
    site.host = host
    site.port = components.port
    return (code, site.url!)
  }

  // MARK: Sign in

  /// The signed-in kanna.sh account, or nil. Checks the stored token.
  func account() async throws -> Account? {
    let (_, site) = try await startPairSession()
    guard let token = Keychain.token(for: site) else { return nil }
    var request = URLRequest(url: site.appendingPathComponent("api/auth/me"))
    request.setValue("kanna_cloud_session=\(token)", forHTTPHeaderField: "Cookie")
    let (data, response) = try await URLSession.shared.data(for: request)
    if (response as? HTTPURLResponse)?.statusCode == 401 {
      Keychain.deleteToken(for: site)
      return nil
    }
    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let user = json["user"] as? [String: Any],
          let login = user["githubLogin"] as? String else { return nil }
    return Account(githubLogin: login)
  }

  func signIn() async throws -> Account {
    let (_, site) = try await startPairSession()
    // `platform=macos` asks kanna.sh for the token on kanna://auth rather
    // than a cookie (src/worker/cloud/auth.ts in kanna-site).
    var start = URLComponents(url: site.appendingPathComponent("api/auth/github"), resolvingAgainstBaseURL: false)!
    start.queryItems = [URLQueryItem(name: "platform", value: "macos")]
    let callback = try await authenticate(start.url!)
    guard let token = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
      .queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty else {
      throw CloudError.server("GitHub sign-in didn't finish. Try again.")
    }
    Keychain.setToken(token, for: site)
    guard let account = try await account() else { throw CloudError.signInExpired }
    return account
  }

  func signOut() async {
    guard let (_, site) = try? await startPairSession() else { return }
    Keychain.deleteToken(for: site)
  }

  private func authenticate(_ url: URL) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "kanna") { callback, error in
        if let callback {
          continuation.resume(returning: callback)
        } else {
          continuation.resume(throwing: error ?? CloudError.server("GitHub sign-in didn't finish. Try again."))
        }
      }
      session.presentationContextProvider = self
      session.prefersEphemeralWebBrowserSession = false
      self.session = session
      session.start()
    }
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated { window ?? NSApp.keyWindow ?? ASPresentationAnchor() }
  }

  // MARK: Claim

  /// Claims this Mac as `<login>-<label>.kanna.sh` and waits for the server
  /// to come online there.
  func claim(label: String) async throws -> URL {
    let (code, site) = try await startPairSession()
    guard let token = Keychain.token(for: site) else { throw CloudError.signInExpired }
    guard let account = try await account() else { throw CloudError.signInExpired }

    var request = URLRequest(url: site.appendingPathComponent("api/cloud/device-code/\(code)/claim"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("kanna_cloud_session=\(token)", forHTTPHeaderField: "Cookie")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "subdomain": Self.subdomain(login: account.githubLogin, label: label),
      "name": Host.current().localizedName ?? label,
    ])
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 {
      Keychain.deleteToken(for: site)
      throw CloudError.signInExpired
    }
    guard status == 201 else {
      let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw CloudError.server(body?["error"] as? String ?? "kanna.sh refused the claim (\(status)).")
    }

    // The server polls kanna.sh and writes cloud.json when it sees the claim.
    let pairSession = server.appendingPathComponent("api/cloud/pair-session")
    for _ in 0..<60 {
      try await Task.sleep(for: .seconds(1))
      let body = try await Self.json(for: URLRequest(url: pairSession))
      if body["status"] as? String == "paired", let origin = (body["appOrigin"] as? String).flatMap(URL.init(string:)) {
        return origin
      }
      if body["status"] as? String == "error" {
        throw CloudError.server(body["error"] as? String ?? "Pairing failed.")
      }
    }
    throw CloudError.server("kanna.sh claimed this Mac, but the server hasn't come online yet. Check Help › Show Server Log.")
  }

  // MARK: Names

  /// Mirrors machineLabelFromName in kanna-site src/lib/cloud.ts, which fills
  /// the same field on the kanna.sh/machine page.
  static func suggestedLabel(login: String) -> String {
    let name = (Host.current().localizedName ?? "mac").replacingOccurrences(of: "['’`]", with: "", options: .regularExpression)
    let prefix = "\(login.lowercased())-"
    var label = sanitize(name).replacingOccurrences(of: "-+$", with: "", options: .regularExpression)
    if label.hasPrefix(prefix) { label.removeFirst(prefix.count) }
    return String(label.prefix(max(0, 40 - prefix.count))).replacingOccurrences(of: "-+$", with: "", options: .regularExpression)
  }

  static func subdomain(login: String, label: String) -> String {
    let clean = sanitize(label).replacingOccurrences(of: "-+$", with: "", options: .regularExpression)
    return "\(login.lowercased())-\(clean)"
  }

  private static func sanitize(_ value: String) -> String {
    value.lowercased()
      .replacingOccurrences(of: "[^a-z0-9-]", with: "-", options: .regularExpression)
      .replacingOccurrences(of: "-+", with: "-", options: .regularExpression)
      .replacingOccurrences(of: "^-", with: "", options: .regularExpression)
  }

  private static func json(for request: URLRequest) async throws -> [String: Any] {
    let (data, _) = try await URLSession.shared.data(for: request)
    return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
  }
}

/// The kanna.sh session token, one per control plane.
enum Keychain {
  private static let service = "sh.kanna.cloud"

  private static func query(for site: URL) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: site.host ?? "kanna.sh",
    ]
  }

  static func token(for site: URL) -> String? {
    var query = query(for: site)
    query[kSecReturnData as String] = true
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func setToken(_ token: String, for site: URL) {
    deleteToken(for: site)
    var query = query(for: site)
    query[kSecValueData as String] = Data(token.utf8)
    SecItemAdd(query as CFDictionary, nil)
  }

  static func deleteToken(for site: URL) {
    SecItemDelete(query(for: site) as CFDictionary)
  }
}

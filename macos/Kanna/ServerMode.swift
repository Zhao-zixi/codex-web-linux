import CryptoKit
import Foundation

/// Which Kanna the window shows.
///
/// - Installed: the global `kanna` (bun install -g kanna-code) on port 3210,
///   with its data in ~/.kanna. What users run.
/// - Development: a checkout's `bun run dev` (scripts/dev.ts): Vite on 5174
///   with hot reload, in front of a server on 5175 that keeps its data in
///   ~/.kanna-dev, so trying things never touches real chats.
///
/// Debug builds know their checkout and start in Development; the Developer
/// menu switches between the two and the choice sticks.
nonisolated enum ServerMode: String {
  case installed
  case development

  private static let key = "serverMode"

  static var current: ServerMode {
    get {
      UserDefaults.standard.string(forKey: key).flatMap(ServerMode.init(rawValue:))
        ?? (DevCheckout.url != nil ? .development : .installed)
    }
    set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
  }

  /// Where the page loads from: the server itself, or Vite in front of it.
  /// Vite also passes /health through, so one probe covers both halves.
  var port: Int {
    switch self {
    case .installed: 3210
    case .development: 5174
    }
  }

  /// ~/.kanna or ~/.kanna-dev (src/shared/branding.ts, KANNA_RUNTIME_PROFILE).
  var dataRoot: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent(self == .installed ? ".kanna" : ".kanna-dev")
  }

  /// Mirrors instanceFingerprint() in src/server/instance.ts: sha256 of the
  /// data dir path, first 16 hex characters. Tells the installed server and
  /// the dev one apart on /health.
  var fingerprint: String {
    let digest = SHA256.hash(data: Data(dataRoot.appendingPathComponent("data").path.utf8))
    return String(digest.map { String(format: "%02x", $0) }.joined().prefix(16))
  }
}

/// The checkout Development mode runs. A Debug build is stamped with the one
/// it was built from (KannaDevCheckout in Info.plist, set by project.yml);
/// Developer › Choose Checkout… overrides it.
nonisolated enum DevCheckout {
  private static let key = "devCheckout"

  static var url: URL? {
    let stamped = Bundle.main.object(forInfoDictionaryKey: "KannaDevCheckout") as? String
    guard let path = UserDefaults.standard.string(forKey: key) ?? stamped, !path.isEmpty else { return nil }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    return isCheckout(url) ? url : nil
  }

  static func set(_ url: URL) {
    UserDefaults.standard.set(url.standardizedFileURL.path, forKey: key)
  }

  static func isCheckout(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.appendingPathComponent("scripts/dev.ts").path)
  }

  /// Whether this build shows the Developer menu: Debug builds, or anyone who
  /// ran `defaults write sh.kanna.mac developerMenu -bool true`.
  static var showsDeveloperMenu: Bool {
    let stamped = Bundle.main.object(forInfoDictionaryKey: "KannaDevCheckout") as? String ?? ""
    return !stamped.isEmpty || UserDefaults.standard.bool(forKey: "developerMenu")
  }
}

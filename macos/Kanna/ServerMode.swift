import CryptoKit
import Foundation

/// Which Kanna the window shows. Every build can switch (the Server menu),
/// because plenty of people run a fork, a checkout or a second server, and
/// the window should show whichever one they point it at.
///
/// - Installed: the global `kanna` (bun install -g kanna-code) on port 3210,
///   with its data in ~/.kanna. What most people run, and the default.
/// - Development: a checkout's `bun run dev` (scripts/dev.ts): Vite on 5174
///   with hot reload, in front of a server on 5175 that keeps its data in
///   ~/.kanna-dev, so trying things never touches real chats. The app starts
///   it in the checkout when it isn't running. Debug builds default to this.
/// - Custom: any Kanna server by address (a fork on another port or data
///   dir, another Mac over Tailscale). The app only connects; whoever runs
///   the server starts it.
nonisolated enum ServerMode: Equatable {
  case installed
  case development
  case custom(URL)

  private static let modeKey = "serverMode"
  private static let customURLKey = "customServerURL"

  static var current: ServerMode {
    get {
      let defaults = UserDefaults.standard
      switch defaults.string(forKey: modeKey) {
      case "installed": return .installed
      case "development": return .development
      case "custom":
        if let url = defaults.string(forKey: customURLKey).flatMap(URL.init(string:)) { return .custom(url) }
        return .installed
      default:
        return DevCheckout.isStamped ? .development : .installed
      }
    }
    set {
      let defaults = UserDefaults.standard
      switch newValue {
      case .installed: defaults.set("installed", forKey: modeKey)
      case .development: defaults.set("development", forKey: modeKey)
      case .custom(let url):
        defaults.set("custom", forKey: modeKey)
        defaults.set(url.absoluteString, forKey: customURLKey)
      }
    }
  }

  /// The last custom address, to prefill Server › Custom URL….
  static var lastCustomURL: URL? {
    UserDefaults.standard.string(forKey: customURLKey).flatMap(URL.init(string:))
  }

  /// Where the page loads from: the server itself, or Vite in front of it
  /// (Vite passes /health through, so one probe covers both halves).
  var pageURL: URL {
    switch self {
    case .installed: URL(string: "http://localhost:3210")!
    case .development: URL(string: "http://localhost:5174")!
    case .custom(let url): url
    }
  }

  /// ~/.kanna or ~/.kanna-dev (src/shared/branding.ts, KANNA_RUNTIME_PROFILE).
  /// A custom server's data lives wherever its owner put it.
  var dataRoot: URL? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    switch self {
    case .installed: return home.appendingPathComponent(".kanna")
    case .development: return home.appendingPathComponent(".kanna-dev")
    case .custom: return nil
    }
  }

  /// Mirrors instanceFingerprint() in src/server/instance.ts: sha256 of the
  /// data dir path, first 16 hex characters. Tells the installed server and
  /// the dev one apart on /health. Nil for a custom server: any Kanna there
  /// is the one the user asked for.
  var fingerprint: String? {
    guard let dataRoot else { return nil }
    let digest = SHA256.hash(data: Data(dataRoot.appendingPathComponent("data").path.utf8))
    return String(digest.map { String(format: "%02x", $0) }.joined().prefix(16))
  }
}

/// The checkout Development mode runs. A Debug build is stamped with the one
/// it was built from (KannaDevCheckout in Info.plist, set by project.yml);
/// Server › Choose Checkout… picks any other, fork or not.
nonisolated enum DevCheckout {
  private static let key = "devCheckout"

  private static var stamped: String {
    Bundle.main.object(forInfoDictionaryKey: "KannaDevCheckout") as? String ?? ""
  }

  /// A Debug build, which knows where it was built.
  static var isStamped: Bool { !stamped.isEmpty }

  static var url: URL? {
    guard let path = UserDefaults.standard.string(forKey: key) ?? (isStamped ? stamped : nil) else { return nil }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    return isCheckout(url) ? url : nil
  }

  static func set(_ url: URL) {
    UserDefaults.standard.set(url.standardizedFileURL.path, forKey: key)
  }

  static func isCheckout(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.appendingPathComponent("scripts/dev.ts").path)
  }
}

import Foundation
import WebKit

/// The Fleet: the Kanna Cloud machines of the account this Mac is paired to,
/// for the Fleet menu and the sidebar's picker (pushed into the page, see
/// `MainWindowController.pushFleet`).
///
/// The local server has the list: it asks kanna.sh with this Mac's own
/// machine credentials (GET /api/cloud/fleet, src/server/cloud/fleet.ts), so
/// listing needs no sign-in, and `self` names this Mac. Showing this Mac
/// means the local server, never its kanna.sh address, which would send its
/// own traffic out through Cloudflare and back. Any other machine loads from
/// kanna.sh, which takes a session in the window (AppAuth).
final class Fleet {
  static let shared = Fleet()

  /// kanna.sh's session cookie (kanna-site src/worker/cloud/cookies.ts).
  static let sessionCookieName = "kanna_cloud_session"

  struct Machine: Codable, Equatable {
    let subdomain: String
    let name: String
    let appOrigin: String
    let online: Bool
    let lastSeenAt: Double?
    let kind: String?
  }

  private(set) var list: [Machine] = []
  /// This Mac's subdomain; nil while it isn't on Kanna Cloud.
  private(set) var thisSubdomain: String?
  var onChange: (() -> Void)?
  private var timer: Timer?

  /// The control plane this Mac paired with (cloud.json's controlUrl), else
  /// kanna.sh: where AppAuth signs in.
  var site: URL {
    let controlURL = pairing?["controlUrl"] as? String
    guard let url = controlURL.flatMap(URL.init(string:)),
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      return URL(string: "https://kanna.sh")!
    }
    components.path = ""
    components.query = nil
    return components.url ?? URL(string: "https://kanna.sh")!
  }

  private var pairing: [String: Any]? {
    guard let url = ServerMode.current.dataRoot?.appendingPathComponent("cloud.json"),
          let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  func machine(forHost host: String) -> Machine? {
    list.first { URL(string: $0.appOrigin)?.host?.lowercased() == host.lowercased() }
  }

  /// Whether the window has a kanna.sh session to open other machines with.
  func hasSession() async -> Bool {
    guard let host = site.host?.lowercased() else { return false }
    let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
    return cookies.contains { cookie in
      cookie.name == Self.sessionCookieName
        && cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == host
        && (cookie.expiresDate ?? .distantFuture) > Date()
    }
  }

  /// Keeps the list fresh while the app runs: machines come and go online.
  func start() {
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
    refresh()
  }

  func refresh() {
    guard let server = ServerAgent.shared.serverURL else { return }
    Task {
      var request = URLRequest(url: server.appendingPathComponent("api/cloud/fleet"))
      request.timeoutInterval = 10
      guard let (data, response) = try? await URLSession.shared.data(for: request),
            (response as? HTTPURLResponse)?.statusCode == 200,
            let decoded = try? JSONDecoder().decode(Response.self, from: data) else { return }
      let machines = decoded.machines.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
      if machines != list || decoded.`self` != thisSubdomain {
        list = machines
        thisSubdomain = decoded.`self`
        onChange?()
      }
    }
  }

  /// CloudLocalFleetResponse in src/shared/cloud-api.ts.
  private struct Response: Decodable {
    let `self`: String?
    let machines: [Machine]
  }
}

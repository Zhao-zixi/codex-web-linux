import Foundation
import WebKit

/// The signed-in account's Kanna Cloud machines, for the sidebar's picker
/// (pushed into the page, see `MainWindowController.pushMachines`) and the
/// Machines menu.
///
/// The app signs in to kanna.sh natively (CloudSignIn), so it asks kanna.sh
/// itself, with that session. This Mac is the machine whose subdomain its own
/// pairing (cloud.json) names: showing it means the local server, never its
/// kanna.sh address, which would send this Mac's own traffic out through
/// Cloudflare and back. Any other machine is shown at its kanna.sh address,
/// with the session installed as a cookie so it opens already signed in.
final class Machines {
  static let shared = Machines()

  struct Machine: Codable, Equatable {
    let subdomain: String
    let name: String
    let appOrigin: String
    let online: Bool
    let lastSeenAt: Double?
    let kind: String?
  }

  private(set) var list: [Machine] = []
  var onChange: (() -> Void)?
  private var timer: Timer?

  /// The control plane this Mac paired with (cloud.json's controlUrl), else
  /// kanna.sh. The sign-in token is kept per control plane (Keychain).
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

  var isSignedIn: Bool { Keychain.token(for: site) != nil }

  /// This Mac's machine, from the pairing of whichever server the window runs.
  var thisSubdomain: String? { pairing?["subdomain"] as? String }

  private var pairing: [String: Any]? {
    guard let url = ServerMode.current.dataRoot?.appendingPathComponent("cloud.json"),
          let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
  }

  func machine(forHost host: String) -> Machine? {
    list.first { URL(string: $0.appOrigin)?.host?.lowercased() == host.lowercased() }
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
    let site = site
    guard let token = Keychain.token(for: site) else {
      if !list.isEmpty {
        list = []
        onChange?()
      }
      return
    }
    Task {
      var request = URLRequest(url: site.appendingPathComponent("api/cloud/machines"))
      request.setValue("kanna_cloud_session=\(token)", forHTTPHeaderField: "Cookie")
      request.timeoutInterval = 10
      guard let (data, response) = try? await URLSession.shared.data(for: request) else { return }
      let status = (response as? HTTPURLResponse)?.statusCode
      // Signed out on kanna.sh: the menu offers sign-in again.
      if status == 401 {
        Keychain.deleteToken(for: site)
        return
      }
      guard status == 200, let decoded = try? JSONDecoder().decode(Response.self, from: data) else { return }
      await installSessionCookie(token: token, site: site)
      let machines = decoded.machines.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
      if machines != list {
        list = machines
        onChange?()
      }
    }
  }

  private struct Response: Decodable {
    let machines: [Machine]
  }

  /// kanna.sh's session cookie for every machine subdomain, so a remote
  /// machine's page loads signed in (the proxy gates on it).
  private func installSessionCookie(token: String, site: URL) async {
    guard let host = site.host,
          let cookie = HTTPCookie(properties: [
            .domain: ".\(host)",
            .path: "/",
            .name: "kanna_cloud_session",
            .value: token,
            .secure: "TRUE",
            .expires: Date().addingTimeInterval(30 * 24 * 60 * 60),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
          ]) else { return }
    await WKWebsiteDataStore.default().httpCookieStore.setCookie(cookie)
  }
}

import AppKit
import WebKit

/// The one window: the Kanna web client from the local server, drawn to the
/// window's edges the way a macOS 26 sidebar app is.
///
/// An empty unified toolbar gives the window its Tahoe shape: 26pt corners
/// and the traffic lights centered 26pt down. The page's sidebar sits 8pt in
/// from the edges under them, with corners concentric to the window's, and
/// its header row is the title bar. The page learns the real numbers from a
/// user script (`chromeScript`), because they differ between macOS versions
/// and in full screen; src/index.css keys its `mac-app:` variant off it.
///
/// WKWebView takes every click, so AppKit can't drag the window from the
/// page. The page marks its title-bar areas with `data-window-drag`, the
/// script reports a mousedown there, and the window drags from that event
/// (`KannaWebView.lastMouseDown`), as Tauri does.
final class MainWindowController: NSWindowController, NSWindowDelegate {
  let webView: KannaWebView
  let bridge = WebBridge()
  private let overlay = StatusOverlay()
  private var themeObservation: NSKeyValueObservation?
  private var popups: [PopupWindowController] = []
  private var loadedURL: URL?
  private lazy var navigation = NavigationHandler(owner: self)
  private let metrics: ChromeMetrics

  init() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "Kanna"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    let toolbar = NSToolbar(identifier: "Main")
    toolbar.showsBaselineSeparator = false
    window.toolbar = toolbar
    window.toolbarStyle = .unified
    // Wider than the client's md breakpoint (768px): below it the page lays
    // out for phones, with its own header under the traffic lights.
    window.minSize = NSSize(width: 800, height: 480)
    window.isReleasedWhenClosed = false
    window.tabbingMode = .disallowed
    window.center()
    window.setFrameAutosaveName("Main")
    window.layoutIfNeeded()
    metrics = ChromeMetrics(window: window)

    let configuration = WKWebViewConfiguration()
    configuration.applicationNameForUserAgent = "KannaMac/\(AppInfo.version)"
    configuration.websiteDataStore = .default()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
    configuration.preferences.isElementFullscreenEnabled = true
    HighFrameRate.unlock(configuration.preferences)
    bridge.install(on: configuration)
    configuration.userContentController.addUserScript(WKUserScript(
      source: Self.chromeScript(metrics.css(fullScreen: false)),
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    ))

    webView = KannaWebView(frame: .zero, configuration: configuration)
    webView.isInspectable = true
    webView.allowsBackForwardNavigationGestures = true
    webView.pageZoom = CGFloat(UserDefaults.standard.object(forKey: "pageZoom") as? Double ?? 1)
    bridge.webView = webView
    super.init(window: window)
    window.delegate = self

    let container = NSView()
    for view in [webView, overlay] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      container.addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        view.topAnchor.constraint(equalTo: container.topAnchor),
        view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      ])
    }
    window.contentView = container

    webView.navigationDelegate = navigation
    webView.uiDelegate = navigation
    themeObservation = webView.observe(\.themeColor, options: [.initial, .new]) { [weak self] webView, _ in
      MainActor.assumeIsolated { self?.applyTheme(webView.themeColor) }
    }
    bridge.onWindowDrag = { [weak self] in self?.dragWindow() }
    bridge.onWindowDoubleClick = { [weak self] in self?.titleBarDoubleClicked() }
  }

  required init?(coder: NSCoder) { fatalError() }

  private func applyTheme(_ color: NSColor?) {
    let color = color ?? .windowBackgroundColor
    window?.backgroundColor = color
    webView.underPageBackgroundColor = color
    overlay.backgroundColor = color
  }

  // MARK: Title bar

  private func dragWindow() {
    guard let window, let event = webView.lastMouseDown else { return }
    window.performDrag(with: event)
  }

  /// What a double-click on a title bar does, per System Settings › Desktop
  /// & Dock ("Double-click a window's title bar to").
  private func titleBarDoubleClicked() {
    guard let window else { return }
    switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
    case "Minimize": window.performMiniaturize(nil)
    case "None": break
    default: window.performZoom(nil)
    }
  }

  /// Full screen hides the traffic lights and squares the corners.
  func applyChrome() {
    let css = metrics.css(fullScreen: window?.styleMask.contains(.fullScreen) == true)
    webView.evaluateJavaScript("window.__kannaChrome?.(\(css))")
  }

  func windowDidEnterFullScreen(_ notification: Notification) { applyChrome() }
  func windowDidExitFullScreen(_ notification: Notification) { applyChrome() }

  private static func chromeScript(_ initial: String) -> String {
    """
    (() => {
      const root = document.documentElement
      root.classList.add("kanna-mac-app")
      window.__kannaChrome = (chrome) => {
        for (const [name, value] of Object.entries(chrome.vars)) root.style.setProperty(name, value)
        root.classList.toggle("kanna-mac-fullscreen", chrome.fullScreen)
      }
      window.__kannaChrome(\(initial))

      // Title-bar areas the page marks with data-window-drag drag the window;
      // anything clickable inside them stays clickable.
      const controls = "button, a, input, textarea, select, summary, label, [role=button], [role=menuitem], [role=tab], [contenteditable], [data-no-window-drag]"
      const inTitleBar = (event) => {
        const target = event.target
        return event.button === 0 && target instanceof Element
          && target.closest("[data-window-drag]") !== null && target.closest(controls) === null
      }
      const post = (type) => window.webkit.messageHandlers.kanna.postMessage({ type })
      addEventListener("mousedown", (event) => {
        if (event.detail === 1 && inTitleBar(event)) post("windowDrag")
      }, true)
      addEventListener("dblclick", (event) => {
        if (inTitleBar(event)) post("windowDoubleClick")
      }, true)
    })()
    """
  }

  // MARK: Server

  func show(_ state: ServerAgent.State) {
    let agent = ServerAgent.shared
    let showLog = StatusOverlay.Action(title: "Show Log", isDefault: false) {
      NSWorkspace.shared.open(agent.logURL)
    }
    switch state {
    case .starting:
      overlay.show(busy: true, title: "Starting Kanna…")
    case .notInstalled:
      overlay.show(
        busy: false,
        title: "Install Kanna",
        detail: "Kanna runs from the kanna command, the same one you'd use in a terminal, and it isn't on this Mac yet. Installing adds Bun (if needed) and kanna-code to ~/.bun. If you just installed it yourself, choose Check Again.",
        actions: [
          .init(title: "Check Again", isDefault: false) { agent.retry() },
          .init(title: "Install Kanna", isDefault: true) { agent.install() },
        ]
      )
    case .installing(let line):
      overlay.show(busy: true, title: "Installing Kanna…", detail: line, monospaced: true, actions: [showLog])
    case .waiting(let url):
      overlay.show(
        busy: true,
        title: "Waiting for \(url.host ?? url.absoluteString)\(url.port.map { ":\($0)" } ?? "")…",
        detail: "Nothing is answering at \(url.absoluteString) yet. The window opens as soon as that Kanna starts, or choose another server from the Server menu.",
        actions: [.init(title: "Use Installed Kanna", isDefault: false) { agent.switchMode(to: .installed) }]
      )
    case .failed(let message):
      overlay.show(
        busy: false,
        title: "Kanna couldn't start",
        detail: message,
        monospaced: true,
        actions: [showLog, .init(title: "Try Again", isDefault: true) { agent.retry() }]
      )
    case .running(let url):
      // The client reconnects its socket by itself when the same server
      // comes back (an npm update restarts it in place); only a new address
      // needs a load.
      if loadedURL != url {
        loadedURL = url
        webView.load(URLRequest(url: url))
      }
      overlay.hide()
    }
  }

  var serverOrigin: URL? { loadedURL }

  func go(to path: String) {
    guard let base = loadedURL, let url = URL(string: path, relativeTo: base) else { return }
    webView.evaluateJavaScript("""
      window.history.pushState(null, "", \(Self.jsonString(url.path)));
      window.dispatchEvent(new PopStateEvent("popstate"));
    """)
  }

  private static func jsonString(_ value: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [value])
    return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
  }

  // MARK: Popups

  /// `window.open()` with no URL yet. The OpenRouter sign-in
  /// (src/client/components/auth/AuthCard.tsx) opens about:blank inside the
  /// click, navigates it once the server answers, and expects it to close
  /// itself on the callback page, so it needs a real window.
  func openPopup(with configuration: WKWebViewConfiguration) -> WKWebView {
    let popup = PopupWindowController(configuration: configuration, parent: window)
    popup.onClose = { [weak self, weak popup] in
      self?.popups.removeAll { $0 === popup }
    }
    popups.append(popup)
    popup.showWindow(nil)
    return popup.webView
  }

  // MARK: Zoom

  @objc func zoomIn(_ sender: Any?) { setZoom(webView.pageZoom + 0.1) }
  @objc func zoomOut(_ sender: Any?) { setZoom(webView.pageZoom - 0.1) }
  @objc func actualSize(_ sender: Any?) { setZoom(1) }

  private func setZoom(_ zoom: CGFloat) {
    let clamped = min(max(zoom, 0.5), 2)
    webView.pageZoom = clamped
    UserDefaults.standard.set(Double(clamped), forKey: "pageZoom")
  }

  @objc func reloadPage(_ sender: Any?) {
    if let loadedURL, webView.url == nil { webView.load(URLRequest(url: loadedURL)) } else { webView.reload() }
  }

  @objc func goBack(_ sender: Any?) { webView.goBack() }
  @objc func goForward(_ sender: Any?) { webView.goForward() }
}

/// Where each navigation goes. The window only ever shows the local server;
/// everything else opens in the default browser, where the user's sessions
/// and password manager are.
final class NavigationHandler: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  private weak var owner: MainWindowController?
  private var destinations: [ObjectIdentifier: URL] = [:]

  init(owner: MainWindowController) {
    self.owner = owner
  }

  /// The server's own origin: the one the window loaded (localhost for the
  /// installed and dev servers, anything for a custom one). localhost,
  /// 127.0.0.1 and ::1 count as one host.
  private func isApp(_ url: URL) -> Bool {
    guard let origin = owner?.serverOrigin, url.scheme == origin.scheme, url.port == origin.port,
          let host = url.host else { return false }
    return isServerHost(host)
  }

  private func isServerHost(_ host: String) -> Bool {
    guard let serverHost = owner?.serverOrigin?.host else { return false }
    return host == serverHost || (ServerAgent.isLoopback(host) && ServerAgent.isLoopback(serverHost))
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    if action.shouldPerformDownload {
      decisionHandler(.download)
      return
    }
    guard let url = action.request.url else {
      decisionHandler(.allow)
      return
    }
    // Frames (a dev server preview, an embed) load whatever they load.
    if action.targetFrame?.isMainFrame == false || ["about", "blob", "data"].contains(url.scheme) || isApp(url) {
      decisionHandler(.allow)
      return
    }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    if !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
      decisionHandler(.download)
    } else {
      decisionHandler(.allow)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    owner?.bridge.refreshPermission()
    owner?.applyChrome()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    // The server went away between its health check and this load. The
    // agent notices within seconds and the window reloads when it is back.
    ServerAgent.shared.start()
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
  }

  // MARK: WKUIDelegate

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = action.request.url, url.scheme == "http" || url.scheme == "https" {
      NSWorkspace.shared.open(url)
      return nil
    }
    return owner?.openPopup(with: configuration)
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping (WKPermissionDecision) -> Void
  ) {
    // Dictation. macOS still asks the user once for the app.
    decisionHandler(isServerHost(origin.host) && type == .microphone ? .grant : .deny)
  }

  func webView(
    _ webView: WKWebView,
    runOpenPanelWith parameters: WKOpenPanelParameters,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping ([URL]?) -> Void
  ) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    guard let window = webView.window else {
      completionHandler(panel.runModal() == .OK ? panel.urls : nil)
      return
    }
    panel.beginSheetModal(for: window) { response in
      completionHandler(response == .OK ? panel.urls : nil)
    }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    present(alert, in: webView) { _ in completionHandler() }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    present(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
    field.stringValue = defaultText ?? ""
    alert.accessoryView = field
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    present(alert, in: webView) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  private func present(_ alert: NSAlert, in webView: WKWebView, completion: @escaping (NSApplication.ModalResponse) -> Void) {
    if let window = webView.window {
      alert.beginSheetModal(for: window, completionHandler: completion)
    } else {
      completion(alert.runModal())
    }
  }

  // MARK: Downloads (CSV exports, share exports, attachments)

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func download(
    _ download: WKDownload,
    decideDestinationUsing response: URLResponse,
    suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    let destination = Self.unusedURL(in: downloads, for: suggestedFilename)
    destinations[ObjectIdentifier(download)] = destination
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    // Bounces the Downloads stack in the Dock, as a browser download does.
    if let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) {
      DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: destination.path)
    }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    destinations.removeValue(forKey: ObjectIdentifier(download))
  }

  private static func unusedURL(in directory: URL, for filename: String) -> URL {
    let name = (filename as NSString).deletingPathExtension
    let ext = (filename as NSString).pathExtension
    var candidate = directory.appendingPathComponent(filename)
    var index = 2
    while FileManager.default.fileExists(atPath: candidate.path) {
      let numbered = ext.isEmpty ? "\(name) \(index)" : "\(name) \(index).\(ext)"
      candidate = directory.appendingPathComponent(numbered)
      index += 1
    }
    return candidate
  }
}

/// A window for a page's `window.open()`. It closes when the page calls
/// `window.close()`.
final class PopupWindowController: NSWindowController, NSWindowDelegate, WKUIDelegate {
  let webView: WKWebView
  var onClose: (() -> Void)?

  init(configuration: WKWebViewConfiguration, parent: NSWindow?) {
    webView = WKWebView(frame: .zero, configuration: configuration)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 520, height: 680),
      styleMask: [.titled, .closable, .resizable, .miniaturizable],
      backing: .buffered,
      defer: false
    )
    window.contentView = webView
    window.isReleasedWhenClosed = false
    if let parent {
      let frame = parent.frame
      window.setFrameOrigin(NSPoint(x: frame.midX - 260, y: frame.midY - 340))
    } else {
      window.center()
    }
    super.init(window: window)
    window.delegate = self
    webView.uiDelegate = self
    webView.isInspectable = true
  }

  required init?(coder: NSCoder) { fatalError() }

  func webViewDidClose(_ webView: WKWebView) {
    close()
  }

  func windowWillClose(_ notification: Notification) {
    onClose?()
  }
}

/// Covers the web view until the server answers: while it starts, when
/// `kanna` still has to be installed, and when it can't start.
final class StatusOverlay: NSView {
  struct Action {
    let title: String
    let isDefault: Bool
    let perform: () -> Void
  }

  var backgroundColor: NSColor = .windowBackgroundColor {
    didSet { needsDisplay = true }
  }

  private let spinner = NSProgressIndicator()
  private let title = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let buttons = NSStackView()
  private var actions: [Action] = []

  override init(frame: NSRect) {
    super.init(frame: frame)
    spinner.style = .spinning
    spinner.controlSize = .small
    title.font = .systemFont(ofSize: 15, weight: .semibold)
    title.alignment = .center
    detail.font = .systemFont(ofSize: 12)
    detail.textColor = .secondaryLabelColor
    detail.alignment = .center
    detail.preferredMaxLayoutWidth = 460
    detail.isSelectable = true
    buttons.spacing = 8

    let stack = NSStackView(views: [spinner, title, detail, buttons])
    stack.orientation = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      stack.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
    ])
  }

  required init?(coder: NSCoder) { fatalError() }

  override func draw(_ dirtyRect: NSRect) {
    backgroundColor.setFill()
    dirtyRect.fill()
  }

  func hide() {
    isHidden = true
    spinner.stopAnimation(nil)
  }

  func show(busy: Bool, title: String, detail: String? = nil, monospaced: Bool = false, actions: [Action] = []) {
    isHidden = false
    spinner.isHidden = !busy
    if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
    self.title.stringValue = title
    self.detail.stringValue = detail ?? ""
    self.detail.isHidden = detail == nil
    self.detail.font = monospaced ? .monospacedSystemFont(ofSize: 11, weight: .regular) : .systemFont(ofSize: 12)
    self.actions = actions
    buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for (index, action) in actions.enumerated() {
      let button = NSButton(title: action.title, target: self, action: #selector(clicked(_:)))
      button.tag = index
      if action.isDefault { button.keyEquivalent = "\r" }
      buttons.addArrangedSubview(button)
    }
    buttons.isHidden = actions.isEmpty
  }

  @objc private func clicked(_ sender: NSButton) {
    actions[sender.tag].perform()
  }
}

/// Remembers the mousedown a title-bar drag starts from: the page reports it
/// a moment later, and `performDrag(with:)` needs the original event.
final class KannaWebView: WKWebView {
  private(set) var lastMouseDown: NSEvent?

  override func mouseDown(with event: NSEvent) {
    lastMouseDown = event
    super.mouseDown(with: event)
  }
}

/// The window's shape as the page needs it, read from the window itself.
struct ChromeMetrics {
  /// Where the page may start drawing to the right of the traffic lights.
  let trafficLightsInset: CGFloat
  /// How far down the lights' centers are; title-bar content centers there.
  let trafficLightsCenter: CGFloat
  let cornerRadius: CGFloat

  init(window: NSWindow) {
    let zoom = window.standardWindowButton(.zoomButton)
    let frame = zoom.map { $0.convert($0.bounds, to: nil) } ?? .zero
    // 12pt of air after the green light, as the system leaves before a
    // toolbar's first item. Fallbacks are macOS 26's unified toolbar.
    trafficLightsInset = frame.maxX > 0 ? (frame.maxX + 12).rounded() : 91
    let fromTop = window.frame.height - frame.midY
    trafficLightsCenter = frame.maxX > 0 && fromTop > 0 ? fromTop.rounded() : 26
    // NSWindow has no public corner radius; this private key is read-only
    // and only styles the sidebar, so a miss just means the fallback.
    let key = "_cornerRadius"
    let radius = window.responds(to: NSSelectorFromString(key)) ? window.value(forKey: key) as? CGFloat : nil
    cornerRadius = radius.flatMap { $0 > 0 ? $0 : nil } ?? 26
  }

  /// `{vars, fullScreen}` for window.__kannaChrome.
  func css(fullScreen: Bool) -> String {
    // Full screen has no lights to clear and square corners; these put the
    // sidebar back to its browser look (16px corners, 12px padding).
    let inset = fullScreen ? 20 : trafficLightsInset
    let radius = fullScreen ? 24 : cornerRadius
    return """
    {"fullScreen": \(fullScreen), "vars": {"--mac-traffic-lights-inset": "\(Int(inset))px", "--mac-traffic-lights-center": "\(Int(trafficLightsCenter))px", "--mac-window-radius": "\(Int(radius))px"}}
    """
  }
}

/// WebKit renders a WKWebView in any app but Safari at 60 fps, even on a
/// 120 Hz display (WebKit bug 294338), which makes scrolling and typing feel
/// behind. Safari lifts the cap with an internal WebKit feature; there is no
/// public switch, so this flips the same one through the private `_features`
/// list, measured at 61 → 120 fps on macOS 26. It is looked up by name and
/// skipped if it's gone, so a WebKit that drops it just stays at 60. Not an
/// option for the Mac App Store, which this app isn't in.
enum HighFrameRate {
  static func unlock(_ preferences: WKPreferences) {
    let featuresSelector = NSSelectorFromString("_features")
    let setSelector = NSSelectorFromString("_setEnabled:forFeature:")
    guard WKPreferences.responds(to: featuresSelector),
          preferences.responds(to: setSelector),
          let features = (WKPreferences.self as AnyObject).perform(featuresSelector)?
            .takeUnretainedValue() as? [NSObject],
          let feature = features.first(where: {
            ($0.value(forKey: "key") as? String) == "PreferPageRenderingUpdatesNear60FPSEnabled"
          }),
          let method = class_getInstanceMethod(WKPreferences.self, setSelector) else { return }
    // A BOOL argument can't go through perform(_:with:with:); call it typed.
    typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
    unsafeBitCast(method_getImplementation(method), to: SetEnabled.self)(preferences, setSelector, false, feature)
  }
}

enum AppInfo {
  static var version: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
  }
}

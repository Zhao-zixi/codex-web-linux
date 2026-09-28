import AppKit
import Sparkle

@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  private var main: MainWindowController!
  private var quitting = false
  private var offeredSetup = false

  /// Sparkle updates this app, the window. Kanna itself is the global npm
  /// install and updates itself the way it does in a terminal. The updater
  /// stays off until a build carries the feed's public key.
  private lazy var updater = SPUStandardUpdaterController(
    startingUpdater: Self.updatesEnabled,
    updaterDelegate: nil,
    userDriverDelegate: nil
  )

  private static var updatesEnabled: Bool {
    !(Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? "").isEmpty
  }

  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    // kanna-app://open?url=… from a terminal `kanna` (src/server/mac-app.ts).
    NSAppleEventManager.shared().setEventHandler(
      self,
      andSelector: #selector(handleURLEvent(_:reply:)),
      forEventClass: AEEventClass(kInternetEventClass),
      andEventID: AEEventID(kAEGetURL)
    )
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    main = MainWindowController()
    main.bridge.onActivateNotification = { [weak self] in self?.bringToFront() }
    NSApp.mainMenu = buildMenu()
    _ = updater

    KeepAwake.shared.start()
    updateDockBadge()

    // A heavy shell profile takes seconds to read; start now, alongside the
    // check for a server that is already running.
    Task.detached { _ = ShellEnvironment.current() }

    let agent = ServerAgent.shared
    agent.onChange = { [weak self] state in
      guard let self else { return }
      main.show(state)
      // Setup needs a running server (Kanna Cloud pairs through it), and
      // installing Kanna comes first.
      if case .running = state, !offeredSetup, let window = main.window {
        offeredSetup = true
        SetupSheet.showIfNeeded(on: window)
      }
    }
    main.show(agent.state)
    agent.start()

    main.showWindow(nil)
    NSApp.activate()
  }

  func applicationDidBecomeActive(_ notification: Notification) {
    main?.bridge.refreshPermission()
  }

  /// Closing the window is quitting, and the server the app started goes
  /// with it. Open at Login is how a Mac stays online.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard !quitting, ServerAgent.shared.isOwned else { return .terminateNow }
    quitting = true
    ServerAgent.shared.stop {
      NSApp.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }

  @objc private func handleURLEvent(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    guard let string = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
          let components = URLComponents(string: string),
          components.scheme == "kanna-app" else { return }
    if components.host == "open",
       let target = components.queryItems?.first(where: { $0.name == "url" })?.value.flatMap(URL.init(string:)) {
      ServerAgent.shared.start(preferring: target)
    }
    bringToFront()
  }

  private func bringToFront() {
    main?.showWindow(nil)
    NSApp.activate()
  }

  // MARK: Menu actions

  @objc func checkForUpdates(_ sender: Any?) {
    guard Self.updatesEnabled else {
      let alert = NSAlert()
      alert.messageText = "Updates are off in this build"
      alert.informativeText = "Development builds have no update feed. Kanna itself still updates from npm, in Settings."
      alert.runModal()
      return
    }
    updater.checkForUpdates(sender)
  }

  @objc func showSetup(_ sender: Any?) {
    guard let window = main.window else { return }
    bringToFront()
    SetupSheet.show(on: window)
  }

  @objc func showSettings(_ sender: Any?) {
    bringToFront()
    main.go(to: "/settings/general")
  }

  @objc func toggleKeepAwake(_ sender: Any?) {
    KeepAwake.shared.onPower.toggle()
  }

  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
    switch menuItem.action {
    case #selector(toggleKeepAwake(_:)):
      menuItem.state = KeepAwake.shared.onPower ? .on : .off
    case #selector(useInstalledKanna(_:)):
      menuItem.state = ServerAgent.shared.mode == .installed ? .on : .off
    case #selector(useDevelopmentCheckout(_:)):
      menuItem.state = ServerAgent.shared.mode == .development ? .on : .off
    case #selector(chooseCheckout(_:)):
      let path = DevCheckout.url.map { ($0.path as NSString).abbreviatingWithTildeInPath }
      menuItem.title = path.map { "Checkout: \($0)…" } ?? "Choose Checkout…"
    default:
      break
    }
    return true
  }

  // MARK: Developer menu

  @objc func useInstalledKanna(_ sender: Any?) {
    switchServer(to: .installed)
  }

  @objc func useDevelopmentCheckout(_ sender: Any?) {
    guard DevCheckout.url != nil else {
      chooseCheckout(sender)
      return
    }
    switchServer(to: .development)
  }

  @objc func chooseCheckout(_ sender: Any?) {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.message = "Choose a Kanna checkout. Development mode runs its `bun run dev`."
    panel.directoryURL = DevCheckout.url
    guard panel.runModal() == .OK, let url = panel.url else { return }
    guard DevCheckout.isCheckout(url) else {
      let alert = NSAlert()
      alert.messageText = "That folder isn't a Kanna checkout"
      alert.informativeText = "A checkout has scripts/dev.ts in it."
      alert.runModal()
      return
    }
    DevCheckout.set(url)
    if ServerAgent.shared.mode == .development {
      ServerAgent.shared.restart()
    } else {
      switchServer(to: .development)
    }
  }

  private func switchServer(to mode: ServerMode) {
    ServerAgent.shared.switchMode(to: mode)
    updateDockBadge()
  }

  /// "DEV" on the Dock icon while the window shows a checkout's server, so a
  /// dev window is never mistaken for the real one.
  private func updateDockBadge() {
    NSApp.dockTile.badgeLabel = ServerAgent.shared.mode == .development ? "DEV" : nil
  }

  @objc func showServerLog(_ sender: Any?) {
    NSWorkspace.shared.open(ServerAgent.shared.logURL)
  }

  @objc func openWebsite(_ sender: Any?) {
    NSWorkspace.shared.open(URL(string: "https://kanna.sh")!)
  }

  @objc func openInBrowser(_ sender: Any?) {
    if let url = main.webView.url ?? ServerAgent.shared.serverURL { NSWorkspace.shared.open(url) }
  }

  // MARK: Menu

  private func buildMenu() -> NSMenu {
    let menu = NSMenu()

    let app = submenu(in: menu, title: "Kanna")
    app.addItem(withTitle: "About Kanna", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    app.addItem(item("Check for Updates…", #selector(checkForUpdates(_:))))
    app.addItem(.separator())
    app.addItem(item("Settings…", #selector(showSettings(_:)), key: ","))
    app.addItem(item("Setup…", #selector(showSetup(_:))))
    app.addItem(item("Keep Mac Awake While Plugged In", #selector(toggleKeepAwake(_:))))
    app.addItem(.separator())
    let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
    services.submenu = NSMenu()
    NSApp.servicesMenu = services.submenu
    app.addItem(services)
    app.addItem(.separator())
    app.addItem(withTitle: "Hide Kanna", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    app.addItem(.separator())
    app.addItem(withTitle: "Quit Kanna", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    let edit = submenu(in: menu, title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    let pasteMatching = edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
    pasteMatching.keyEquivalentModifierMask = [.command, .option, .shift]
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    let view = submenu(in: menu, title: "View")
    view.addItem(item("Reload", #selector(MainWindowController.reloadPage(_:)), key: "r", target: main))
    view.addItem(item("Open in Browser", #selector(openInBrowser(_:))))
    view.addItem(.separator())
    view.addItem(item("Actual Size", #selector(MainWindowController.actualSize(_:)), key: "0", target: main))
    view.addItem(item("Zoom In", #selector(MainWindowController.zoomIn(_:)), key: "+", target: main))
    view.addItem(item("Zoom Out", #selector(MainWindowController.zoomOut(_:)), key: "-", target: main))
    view.addItem(.separator())
    let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
    fullScreen.keyEquivalentModifierMask = [.command, .control]

    let history = submenu(in: menu, title: "History")
    history.addItem(item("Back", #selector(MainWindowController.goBack(_:)), key: "[", target: main))
    history.addItem(item("Forward", #selector(MainWindowController.goForward(_:)), key: "]", target: main))

    if DevCheckout.showsDeveloperMenu {
      let developer = submenu(in: menu, title: "Developer")
      developer.addItem(item("Installed Kanna", #selector(useInstalledKanna(_:))))
      developer.addItem(item("Development Checkout (bun run dev)", #selector(useDevelopmentCheckout(_:))))
      developer.addItem(.separator())
      developer.addItem(item("Choose Checkout…", #selector(chooseCheckout(_:))))
    }

    let window = submenu(in: menu, title: "Window")
    window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    window.addItem(.separator())
    window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    NSApp.windowsMenu = window

    let help = submenu(in: menu, title: "Help")
    help.addItem(item("Kanna Website", #selector(openWebsite(_:))))
    help.addItem(item("Show Server Log", #selector(showServerLog(_:))))
    NSApp.helpMenu = help

    return menu
  }

  private func submenu(in menu: NSMenu, title: String) -> NSMenu {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: title)
    item.submenu = submenu
    menu.addItem(item)
    return submenu
  }

  private func item(_ title: String, _ action: Selector, key: String = "", target: AnyObject? = nil) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = target ?? self
    return item
  }
}

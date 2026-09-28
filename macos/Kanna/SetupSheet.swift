import AppKit
import AuthenticationServices
import SwiftUI

/// First-run setup: Open at Login, keeping the Mac awake, Full Disk Access
/// and Kanna Cloud. It opens
/// by itself once, the first time Kanna is running and anything is missing,
/// and Kanna › Setup… brings it back. Every step can be skipped,
/// and each one re-reads the live state every second, so a switch flipped in
/// System Settings shows up here without a click.
enum SetupSheet {
  private static let shownKey = "setupShown"
  private static var sheet: NSWindow?

  static func showIfNeeded(on parent: NSWindow) {
    guard !UserDefaults.standard.bool(forKey: shownKey) else { return }
    let complete = LoginItem.isEnabled
      && FullDiskAccess.isGranted()
      && CloudSignIn.pairedOrigin() != nil
    guard !complete else { return }
    show(on: parent)
  }

  static func show(on parent: NSWindow) {
    UserDefaults.standard.set(true, forKey: shownKey)
    if let sheet {
      sheet.makeKeyAndOrderFront(nil)
      return
    }
    let model = SetupModel(parent: parent)
    let window = NSWindow(contentViewController: NSHostingController(rootView: SetupView(model: model)))
    window.styleMask = [.titled]
    model.onFinish = {
      parent.endSheet(window)
      sheet = nil
    }
    sheet = window
    parent.beginSheet(window)
  }
}

@MainActor
final class SetupModel: ObservableObject {
  enum Step: Int, CaseIterable {
    case login, awake, disk, cloud
  }

  enum Cloud: Equatable {
    case waitingForServer
    case checking
    case signedOut
    case signedIn(login: String)
    case paired(URL)
    case unavailable(String)
  }

  @Published var step: Step = .login
  @Published var loginStatus = LoginItem.status
  @Published var diskGranted = FullDiskAccess.isGranted()
  @Published var cloud: Cloud = .waitingForServer
  @Published var label = ""
  @Published var onPowerAdapter = KeepAwake.isOnPowerAdapter
  @Published var lidClosingSleeps = KeepAwake.lidClosingSleeps
  @Published var fileVaultOn: Bool?
  @Published var note: String?
  @Published var busy = false

  var onFinish: (() -> Void)?
  private weak var parent: NSWindow?
  private var timer: Timer?

  init(parent: NSWindow) {
    self.parent = parent
    // Staying awake is a choice with a default, not a permission, so every
    // run of the sheet shows it rather than skipping past.
    if LoginItem.isEnabled { step = .awake }
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
    Task.detached {
      let on = KeepAwake.isFileVaultOn()
      await MainActor.run { self.fileVaultOn = on }
    }
  }

  var keepAwakeOnPower: Bool {
    get { KeepAwake.shared.onPower }
    set {
      KeepAwake.shared.onPower = newValue
      objectWillChange.send()
    }
  }

  var keepAwakeOnBattery: Bool {
    get { KeepAwake.shared.onBattery }
    set {
      KeepAwake.shared.onBattery = newValue
      objectWillChange.send()
    }
  }

  func refresh() {
    loginStatus = LoginItem.status
    diskGranted = FullDiskAccess.isGranted()
    onPowerAdapter = KeepAwake.isOnPowerAdapter
    lidClosingSleeps = KeepAwake.lidClosingSleeps
    if let origin = CloudSignIn.pairedOrigin() {
      cloud = .paired(origin)
    } else if cloud == .waitingForServer, ServerAgent.shared.serverURL != nil, step == .cloud {
      checkAccount()
    }
  }

  func go(to step: Step) {
    note = nil
    self.step = step
    if step == .cloud { refresh() }
  }

  func next() {
    if let following = Step(rawValue: step.rawValue + 1) {
      go(to: following)
    } else {
      finish()
    }
  }

  func back() {
    if let previous = Step(rawValue: step.rawValue - 1) { go(to: previous) }
  }

  func finish() {
    timer?.invalidate()
    onFinish?()
  }

  // MARK: Actions

  func primary() {
    switch step {
    case .login:
      switch loginStatus {
      case .enabled:
        next()
      case .requiresApproval:
        LoginItem.openSettings()
      default:
        do {
          try LoginItem.enable()
          loginStatus = LoginItem.status
          if loginStatus == .enabled { next() }
        } catch {
          note = error.localizedDescription
        }
      }
    case .awake:
      next()
    case .disk:
      if diskGranted { next() } else { FullDiskAccess.openSettings() }
    case .cloud:
      switch cloud {
      case .signedOut: signIn()
      case .signedIn: claim()
      default: finish()
      }
    }
  }

  private func cloudClient() -> CloudSignIn? {
    ServerAgent.shared.serverURL.map { CloudSignIn(server: $0, window: parent) }
  }

  private func checkAccount() {
    guard let client = cloudClient() else { return }
    cloud = .checking
    Task {
      do {
        if let account = try await client.account() {
          signedIn(account)
        } else {
          cloud = .signedOut
        }
      } catch {
        cloud = .unavailable(error.localizedDescription)
      }
    }
  }

  private func signIn() {
    guard let client = cloudClient() else { return }
    busy = true
    note = nil
    Task {
      defer { busy = false }
      do {
        signedIn(try await client.signIn())
      } catch {
        // Closing the sign-in sheet is not an error worth showing.
        if (error as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
          note = error.localizedDescription
        }
      }
    }
  }

  private func signedIn(_ account: CloudSignIn.Account) {
    if label.isEmpty { label = CloudSignIn.suggestedLabel(login: account.githubLogin) }
    cloud = .signedIn(login: account.githubLogin)
  }

  private func claim() {
    guard let client = cloudClient() else { return }
    busy = true
    note = nil
    Task {
      defer { busy = false }
      do {
        cloud = .paired(try await client.claim(label: label))
      } catch CloudSignIn.CloudError.signInExpired {
        cloud = .signedOut
        note = CloudSignIn.CloudError.signInExpired.localizedDescription
      } catch {
        note = error.localizedDescription
      }
    }
  }
}

struct SetupView: View {
  @ObservedObject var model: SetupModel

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 6) {
        ForEach(SetupModel.Step.allCases, id: \.self) { step in
          Capsule()
            .fill(step == model.step ? Color.accentColor : Color.secondary.opacity(0.25))
            .frame(width: step == model.step ? 18 : 6, height: 6)
        }
      }
      .animation(.snappy, value: model.step)

      Image(systemName: icon)
        .font(.system(size: 30, weight: .medium))
        .foregroundStyle(Color.accentColor)
        .frame(height: 40)
      Text(title).font(.title2.weight(.semibold))
      Text(message)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      content

      if let note = model.note ?? stepNote {
        Text(note)
          .font(.callout)
          .foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }

      Spacer(minLength: 0)

      HStack {
        if model.step != .login {
          Button("Back") { model.back() }
        }
        Spacer()
        if !isDone {
          Button("Skip") { model.next() }
            .keyboardShortcut(.cancelAction)
        }
        Button(primaryTitle) { model.primary() }
          .keyboardShortcut(.defaultAction)
          .disabled(model.busy || primaryDisabled)
      }
    }
    .padding(28)
    .frame(width: 540, height: 470, alignment: .topLeading)
  }

  @ViewBuilder private var content: some View {
    switch model.step {
    case .awake:
      awakeContent
    case .disk where !model.diskGranted:
      AppDragRow()
    case .cloud:
      switch model.cloud {
      case .waitingForServer, .checking:
        ProgressView().controlSize(.small)
      case .signedIn(let login):
        HStack(spacing: 2) {
          Text("\(login.lowercased())-").foregroundStyle(.secondary)
          TextField("name", text: $model.label)
            .textFieldStyle(.roundedBorder)
            .frame(width: 180)
          Text(".kanna.sh").foregroundStyle(.secondary)
        }
        .font(.system(.body, design: .monospaced))
      case .paired(let url):
        Link(url.absoluteString, destination: url)
          .font(.system(.body, design: .monospaced))
      default:
        EmptyView()
      }
    default:
      EmptyView()
    }
  }

  @ViewBuilder private var awakeContent: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle("Keep this Mac awake while it's plugged in", isOn: $model.keepAwakeOnPower)
      Toggle("Also on battery", isOn: $model.keepAwakeOnBattery)
        .disabled(!model.keepAwakeOnPower)
        .padding(.leading, 20)
      Divider().padding(.vertical, 2)
      if model.onPowerAdapter {
        StatusRow(ok: true, text: "Plugged in.")
      } else {
        StatusRow(
          ok: model.keepAwakeOnPower && model.keepAwakeOnBattery,
          text: model.keepAwakeOnPower && model.keepAwakeOnBattery
            ? "On battery, staying awake anyway."
            : "On battery: this Mac sleeps when idle until it's plugged in."
        )
      }
      if let lidClosingSleeps = model.lidClosingSleeps {
        StatusRow(
          ok: !lidClosingSleeps,
          text: lidClosingSleeps
            ? "Closing the lid sleeps this Mac. Keep it open, or connect a display to run it closed."
            : "The lid can stay closed while a display is connected."
        )
      }
      StatusRow(symbol: "lock", text: "Lock with ⌃⌘Q whenever you like. Kanna keeps running behind the lock screen.")
      StatusRow(
        symbol: "arrow.clockwise",
        text: model.fileVaultOn == false
          ? "After a restart or macOS update, Kanna comes back once you log in, or by itself with automatic login."
          : "After a restart or macOS update, Kanna comes back once you log in. FileVault asks for your password first."
      )
    }
  }

  private var isDone: Bool {
    switch model.step {
    case .login: model.loginStatus == .enabled
    case .awake: true
    case .disk: model.diskGranted
    case .cloud:
      if case .paired = model.cloud { true } else { false }
    }
  }

  private var icon: String {
    switch model.step {
    case .login: "power"
    case .awake: "cup.and.saucer"
    case .disk: "externaldrive.badge.checkmark"
    case .cloud: "globe"
    }
  }

  private var title: String {
    switch model.step {
    case .login: "Open Kanna at login"
    case .awake: "Keep this Mac reachable"
    case .disk: "Give Kanna Full Disk Access"
    case .cloud: "Reach this Mac from anywhere"
    }
  }

  private var message: String {
    switch model.step {
    case .login:
      "Kanna runs your agents while the app is open. Opening it at login keeps them, and this Mac's Kanna Cloud address, going after a restart."
    case .awake:
      "A locked Mac keeps working; a sleeping one doesn't. While it's awake, your agents keep running and this Mac stays reachable from kanna.sh, your phone or Tailscale. The display still turns off and locks as usual."
    case .disk:
      "Agents work on projects wherever they live. Without Full Disk Access, macOS stops them to ask about Desktop, Documents, Downloads and iCloud Drive, one folder at a time."
    case .cloud:
      "Kanna Cloud gives this Mac an address on kanna.sh, so you can pick up your chats from your phone or another computer. Your code stays on this Mac."
    }
  }

  private var stepNote: String? {
    switch model.step {
    case .login where model.loginStatus == .requiresApproval:
      return "Turn Kanna on under Login Items to finish."
    case .disk where !model.diskGranted:
      return "Drag Kanna into the list, then turn it on."
    case .cloud:
      switch model.cloud {
      case .waitingForServer: return "Waiting for Kanna to start…"
      case .unavailable(let message): return message
      default: return nil
      }
    default:
      return nil
    }
  }

  private var primaryTitle: String {
    switch model.step {
    case .login:
      switch model.loginStatus {
      case .enabled: return "Continue"
      case .requiresApproval: return "Open Login Items"
      default: return "Open at Login"
      }
    case .awake:
      return "Continue"
    case .disk:
      return model.diskGranted ? "Continue" : "Open Privacy Settings"
    case .cloud:
      switch model.cloud {
      case .signedOut: return "Sign in with GitHub"
      case .signedIn: return model.busy ? "Connecting…" : "Put This Mac Online"
      default: return "Done"
      }
    }
  }

  private var primaryDisabled: Bool {
    switch model.step {
    case .cloud:
      switch model.cloud {
      case .checking: true
      case .signedIn: CloudSignIn.subdomain(login: "x", label: model.label) == "x-"
      default: false
      }
    default: false
    }
  }
}

/// One line of the awake step: a green check, an orange warning, or a plain
/// fact with its own symbol.
private struct StatusRow: View {
  var ok: Bool? = nil
  var symbol: String? = nil
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: symbol ?? (ok == true ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"))
        .foregroundStyle(ok == true ? Color.green : ok == false ? Color.orange : Color.secondary)
        .frame(width: 16)
      Text(text)
        .font(.callout)
        .foregroundStyle(ok == false ? Color.primary : Color.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// A Kanna row to drag into the Full Disk Access list; dropping the app
/// there adds it, so the user only flips the switch.
struct AppDragRow: View {
  var body: some View {
    HStack(spacing: 10) {
      Image(nsImage: NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath))
        .resizable()
        .frame(width: 32, height: 32)
      VStack(alignment: .leading, spacing: 1) {
        Text("Kanna").font(.headline)
        Text("Drag into Full Disk Access").font(.caption).foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "hand.draw").foregroundStyle(.secondary)
    }
    .padding(10)
    .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.1)))
    .overlay(AppDragSource())
  }
}

private struct AppDragSource: NSViewRepresentable {
  func makeNSView(context: Context) -> AppDragView { AppDragView() }
  func updateNSView(_ view: AppDragView, context: Context) {}
}

final class AppDragView: NSView, NSDraggingSource {
  override func mouseDown(with event: NSEvent) {
    let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
    let icon = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    let point = convert(event.locationInWindow, from: nil)
    item.setDraggingFrame(NSRect(x: point.x - 16, y: point.y - 16, width: 32, height: 32), contents: icon)
    beginDraggingSession(with: [item], event: event, source: self)
  }

  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    context == .outsideApplication ? .copy : []
  }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .openHand)
  }
}

import AppKit
import WebKit

/// The Mac half of the web setup wizard's "This Mac" step
/// (src/client/components/auth/MacSetupStep.tsx): Open at Login, staying
/// awake, and Full Disk Access. The page draws the step and sends `macSetup.*`
/// messages; this answers with the live state in `window.__kannaSetMacSetup`.
/// The page asks again every second or so while the step is up, so a switch
/// flipped in System Settings shows without a click.
///
/// Only the local server's page may change this Mac's settings: another
/// machine's page, opened through the Fleet, gets the same message handler.
@MainActor
final class MacSetup {
  weak var webView: KannaWebView?
  private var fileVaultOn: Bool?
  private lazy var dragSource = AppDragSource()

  init() {
    Task.detached {
      let on = KeepAwake.isFileVaultOn()
      await MainActor.run { self.fileVaultOn = on }
    }
  }

  func handle(_ type: String, body: [String: Any], frame: WKFrameInfo) {
    guard frame.isMainFrame, ServerAgent.isLoopback(frame.securityOrigin.host) else { return }
    switch type {
    case "macSetup.setLoginItem":
      if body["enabled"] as? Bool == false {
        try? LoginItem.disable()
      } else {
        try? LoginItem.enable()
      }
    case "macSetup.openLoginItems":
      LoginItem.openSettings()
    case "macSetup.setKeepAwake":
      if let onPower = body["onPower"] as? Bool { KeepAwake.shared.onPower = onPower }
      if let onBattery = body["onBattery"] as? Bool { KeepAwake.shared.onBattery = onBattery }
    case "macSetup.openFullDiskAccess":
      FullDiskAccess.openSettings()
    case "macSetup.startAppDrag":
      startAppDrag()
    default:
      break
    }
    push()
  }

  struct State: Encodable {
    /// "enabled", "requiresApproval" (macOS wants it approved in System
    /// Settings), or "off".
    let loginItem: String
    let keepAwakeOnPower: Bool
    let keepAwakeOnBattery: Bool
    let pluggedIn: Bool
    let lidClosingSleeps: Bool?
    let fileVault: Bool?
    let fullDiskAccess: Bool
  }

  func push() {
    let loginItem: String
    switch LoginItem.status {
    case .enabled: loginItem = "enabled"
    case .requiresApproval: loginItem = "requiresApproval"
    default: loginItem = "off"
    }
    let state = State(
      loginItem: loginItem,
      keepAwakeOnPower: KeepAwake.shared.onPower,
      keepAwakeOnBattery: KeepAwake.shared.onBattery,
      pluggedIn: KeepAwake.isOnPowerAdapter,
      lidClosingSleeps: KeepAwake.lidClosingSleeps,
      fileVault: fileVaultOn,
      fullDiskAccess: FullDiskAccess.isGranted()
    )
    guard let data = try? JSONEncoder().encode(state) else { return }
    webView?.evaluateJavaScript("window.__kannaSetMacSetup?.(\(String(decoding: data, as: UTF8.self)))")
  }

  /// Dragging Kanna into the Full Disk Access list adds it there, so the user
  /// only flips the switch. The page cancels its own drag of the icon and
  /// asks for this one, which carries the app itself. It starts from the
  /// mousedown WebKit just handled, the way Electron's startDrag does.
  private func startAppDrag() {
    guard let webView, let event = webView.lastMouseDown else { return }
    let item = NSDraggingItem(pasteboardWriter: Bundle.main.bundleURL as NSURL)
    let icon = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
    let point = webView.convert(event.locationInWindow, from: nil)
    item.setDraggingFrame(NSRect(x: point.x - 16, y: point.y - 16, width: 32, height: 32), contents: icon)
    webView.beginDraggingSession(with: [item], event: event, source: dragSource)
  }
}

private final class AppDragSource: NSObject, NSDraggingSource {
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
    context == .outsideApplication ? .copy : []
  }
}

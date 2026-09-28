import AppKit
import UserNotifications
import WebKit

/// The page ↔ app channel: the `kanna` message handler one way,
/// `evaluateJavaScript` into `window.__kannaShell` the other.
///
/// WKWebView has no web notifications, and the client only uses the plain
/// `Notification` API (src/client/lib/chatBrowserNotifications.ts). So instead
/// of teaching the client about the app, a user script installs a
/// `Notification` that hands each one to UserNotifications here.
final class WebBridge: NSObject, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
  static let handlerName = "kanna"

  weak var webView: WKWebView?
  /// A mousedown / double-click on the page's title bar (data-window-drag).
  var onWindowDrag: (() -> Void)?
  var onWindowDoubleClick: (() -> Void)?
  var onActivateNotification: (() -> Void)?

  private let center = UNUserNotificationCenter.current()
  private var permission = "default"

  override init() {
    super.init()
    center.delegate = self
  }

  func install(on configuration: WKWebViewConfiguration) {
    let controller = configuration.userContentController
    controller.add(self, name: Self.handlerName)
    controller.addUserScript(WKUserScript(
      source: Self.notificationShim,
      injectionTime: .atDocumentStart,
      forMainFrameOnly: true
    ))
  }

  /// The permission can change in System Settings while the app runs.
  func refreshPermission() {
    center.getNotificationSettings { settings in
      let permission = Self.webPermission(settings.authorizationStatus)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.permission = permission
          self.call("setNotificationPermission", permission)
        }
      }
    }
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    switch type {
    case "notify":
      notify(body)
    case "closeNotification":
      if let id = body["id"] as? String {
        center.removeDeliveredNotifications(withIdentifiers: [id])
      }
    case "windowDrag":
      onWindowDrag?()
    case "windowDoubleClick":
      onWindowDoubleClick?()
    case "requestNotificationPermission":
      requestPermission(callbackId: body["id"] as? String)
    default:
      break
    }
  }

  private func notify(_ body: [String: Any]) {
    guard let id = body["id"] as? String else { return }
    let content = UNMutableNotificationContent()
    content.title = body["title"] as? String ?? "Kanna"
    content.body = body["body"] as? String ?? ""
    content.sound = .default
    content.userInfo = ["id": id]
    center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
  }

  private func requestPermission(callbackId: String?) {
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.permission = granted ? "granted" : "denied"
          if let callbackId { self.call("permissionResolved", callbackId, self.permission) }
        }
      }
    }
  }

  private func call(_ function: String, _ arguments: String...) {
    let args = arguments.map(Self.jsString).joined(separator: ",")
    webView?.evaluateJavaScript("window.__kannaShell?.\(function)(\(args))")
  }

  // MARK: UNUserNotificationCenterDelegate

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    // The client already decides when a notification is worth showing
    // (only while the window is unfocused, by default), so always show it.
    completionHandler([.banner, .sound])
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let id = response.notification.request.content.userInfo["id"] as? String
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        self.onActivateNotification?()
        // The page's onclick navigates to the chat. After a reload the
        // notification is unknown to the page and this does nothing.
        if let id { self.call("notificationClicked", id) }
      }
    }
    completionHandler()
  }

  // MARK: Script

  private static func webPermission(_ status: UNAuthorizationStatus) -> String {
    switch status {
    case .authorized, .provisional, .ephemeral: return "granted"
    case .denied: return "denied"
    default: return "default"
    }
  }

  private static func jsString(_ value: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [value])
    let array = String(data: data, encoding: .utf8)!
    return String(array.dropFirst().dropLast())
  }

  private static let notificationShim = """
  (() => {
    const post = (message) => window.webkit.messageHandlers.kanna.postMessage(message)
    const live = new Map()
    const pending = new Map()
    let permission = "default"
    let nextId = 0

    class Notification extends EventTarget {
      constructor(title, options = {}) {
        super()
        this.title = String(title)
        this.body = options.body == null ? "" : String(options.body)
        this.tag = options.tag == null ? "" : String(options.tag)
        this.onclick = null
        this.onclose = null
        this.id = `kanna-${Date.now()}-${nextId++}`
        if (permission !== "granted") return
        live.set(this.id, this)
        post({ type: "notify", id: this.id, title: this.title, body: this.body, tag: this.tag })
      }
      close() {
        if (!live.delete(this.id)) return
        post({ type: "closeNotification", id: this.id })
        const event = new Event("close")
        this.dispatchEvent(event)
        this.onclose?.call(this, event)
      }
      static get permission() { return permission }
      static requestPermission(callback) {
        return new Promise((resolve) => {
          const id = `permission-${nextId++}`
          pending.set(id, (result) => {
            callback?.(result)
            resolve(result)
          })
          post({ type: "requestNotificationPermission", id })
        })
      }
    }

    window.__kannaShell = {
      setNotificationPermission(value) { permission = value },
      permissionResolved(id, value) {
        permission = value
        pending.get(id)?.(value)
        pending.delete(id)
      },
      notificationClicked(id) {
        const notification = live.get(id)
        if (!notification) return
        const event = new Event("click")
        notification.dispatchEvent(event)
        notification.onclick?.call(notification, event)
      },
    }
    window.Notification = Notification
  })()
  """
}

import AppKit
import ServiceManagement

/// Open at Login. With it, a restart brings the server (and, when paired,
/// this Mac's kanna.sh address) back without anyone opening the app.
enum LoginItem {
  static var status: SMAppService.Status { SMAppService.mainApp.status }
  static var isEnabled: Bool { status == .enabled }

  static func enable() throws {
    try SMAppService.mainApp.register()
  }

  static func disable() throws {
    try SMAppService.mainApp.unregister()
  }

  static func openSettings() {
    SMAppService.openSystemSettingsLoginItems()
  }
}

/// Full Disk Access. Agents read and write projects anywhere in the home
/// directory, and without it macOS stops them with a prompt per protected
/// folder (Desktop, Documents, Downloads, iCloud Drive). One grant to the app
/// covers the server and everything it spawns: TCC charges a child's reads
/// to the app that launched it.
enum FullDiskAccess {
  /// Try to open a file TCC guards. EPERM is the "no" answer; a file that
  /// doesn't exist says nothing, so try the next one.
  static func isGranted() -> Bool {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let guarded = [
      "\(home)/Library/Application Support/com.apple.TCC/TCC.db",
      "\(home)/Library/Safari/Bookmarks.plist",
      "\(home)/Library/Mail",
    ]
    for path in guarded {
      let fd = open(path, O_RDONLY)
      if fd >= 0 {
        close(fd)
        return true
      }
      if errno == EPERM { return false }
    }
    return false
  }

  static func openSettings() {
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
  }
}

import AppKit
import IOKit
import IOKit.ps
import IOKit.pwr_mgt

/// Keeps the Mac awake while Kanna runs, so it stays reachable from kanna.sh,
/// the iOS app or a Tailscale address with the screen locked.
///
/// Locking (⌃⌘Q) never stopped Kanna: the session and its processes keep
/// running behind the login window. Idle sleep does. So the app holds a
/// PreventUserIdleSystemSleep assertion, the one `caffeinate -i` takes,
/// instead of changing the Mac's energy settings: it needs no admin
/// password, the display still turns off and locks on its usual timers, and
/// it ends when Kanna quits. By default it only holds on the power adapter,
/// so a laptop on battery still sleeps.
final class KeepAwake {
  static let shared = KeepAwake()

  private static let onPowerKey = "keepAwakeOnPower"
  private static let onBatteryKey = "keepAwakeOnBattery"

  var onPower: Bool {
    get { UserDefaults.standard.object(forKey: Self.onPowerKey) as? Bool ?? true }
    set {
      UserDefaults.standard.set(newValue, forKey: Self.onPowerKey)
      update()
    }
  }

  var onBattery: Bool {
    get { UserDefaults.standard.bool(forKey: Self.onBatteryKey) }
    set {
      UserDefaults.standard.set(newValue, forKey: Self.onBatteryKey)
      update()
    }
  }

  private var assertion: IOPMAssertionID?
  private var powerSource: CFRunLoopSource?

  /// Holds or releases the assertion now, and again whenever the Mac moves
  /// between the adapter and battery.
  func start() {
    if powerSource == nil {
      let context = Unmanaged.passUnretained(self).toOpaque()
      let source = IOPSNotificationCreateRunLoopSource({ context in
        guard let context else { return }
        let keepAwake = Unmanaged<KeepAwake>.fromOpaque(context).takeUnretainedValue()
        // The source is on the main run loop.
        MainActor.assumeIsolated { keepAwake.update() }
      }, context)?.takeRetainedValue()
      if let source {
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
        powerSource = source
      }
    }
    update()
  }

  private func update() {
    let wanted = Self.isOnPowerAdapter ? onPower : (onPower && onBattery)
    if wanted, assertion == nil {
      var id = IOPMAssertionID(0)
      let result = IOPMAssertionCreateWithName(
        kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn),
        "Kanna keeps this Mac reachable while it runs (Kanna › Keep Mac Awake)" as CFString,
        &id
      )
      if result == kIOReturnSuccess { assertion = id }
    } else if !wanted, let id = assertion {
      IOPMAssertionRelease(id)
      assertion = nil
    }
  }

  var isHoldingMacAwake: Bool { assertion != nil }

  // MARK: What the Mac can tell us

  /// Desktops always report the adapter.
  static var isOnPowerAdapter: Bool {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
          let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() else { return true }
    return (type as String) == kIOPMACPowerKey
  }

  /// Nil on a Mac without a lid. False when a display is connected, which
  /// lets a laptop run closed (clamshell mode).
  static var lidClosingSleeps: Bool? {
    let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
    guard root != 0 else { return nil }
    defer { IOObjectRelease(root) }
    let value = IORegistryEntryCreateCFProperty(root, "AppleClamshellCausesSleep" as CFString, kCFAllocatorDefault, 0)?
      .takeRetainedValue()
    return value as? Bool
  }

  /// With FileVault, macOS asks for a password after every restart before any
  /// login item (Kanna included) can start. Slow (a process); call off main.
  nonisolated static func isFileVaultOn() -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/fdesetup")
    process.arguments = ["status"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return false }
    let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    process.waitUntilExit()
    return output.contains("FileVault is On")
  }
}

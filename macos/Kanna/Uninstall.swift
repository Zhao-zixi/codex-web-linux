import AppKit
import Security

/// Kanna › Uninstall Kanna…: removes Kanna from this Mac, with a choice of
/// what goes with it.
///
/// The removing is macos/uninstall.sh, bundled with the app, the same script
/// that works by hand. It can't run inside the app, since it deletes the app
/// and stops its server, so the app starts it and quits. The script waits
/// for the app to exit, takes the choices as flags, logs to
/// /tmp/kanna-uninstall.log, and posts a notification when it's done.
@MainActor
enum Uninstall {
  private struct Choice {
    let title: String
    let flag: String
    /// Checked: `flag` is added. Otherwise its opposite is (`keepFlag`).
    let checkedByDefault: Bool
    let keepFlag: String?
  }

  private static let cli = Choice(title: "The kanna command (kanna-code)", flag: "", checkedByDefault: true, keepFlag: "--keep-cli")
  // kanna-code lives in Bun's global folder, so Bun can only go with it.
  private static let bun = Choice(title: "Bun (~/.bun)", flag: "", checkedByDefault: false, keepFlag: "--keep-bun")

  private static let keep: [Choice] = [
    cli,
    Choice(title: "Chats, projects and settings (~/.kanna)", flag: "", checkedByDefault: true, keepFlag: "--keep-data"),
    Choice(title: "This Mac's Kanna Cloud address", flag: "", checkedByDefault: true, keepFlag: "--keep-cloud"),
    // Off by default: Bun may be the user's own, not the one Kanna installed.
    bun,
  ]

  private static let agents: [Choice] = [
    Choice(title: "Claude Code", flag: "--claude", checkedByDefault: false, keepFlag: nil),
    Choice(title: "Codex", flag: "--codex", checkedByDefault: false, keepFlag: nil),
    Choice(title: "Cursor CLI", flag: "--cursor", checkedByDefault: false, keepFlag: nil),
    Choice(title: "GitHub CLI", flag: "--gh", checkedByDefault: false, keepFlag: nil),
    Choice(title: "Grok", flag: "--grok", checkedByDefault: false, keepFlag: nil),
  ]

  static func confirmAndRun(window: NSWindow?) {
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = "Uninstall Kanna?"
    alert.informativeText = "Kanna for Mac and its preferences are removed. Choose what else goes."

    var boxes: [(NSButton, Choice)] = []
    func checkbox(_ choice: Choice) -> NSButton {
      let box = NSButton(checkboxWithTitle: choice.title, target: nil, action: nil)
      box.state = choice.checkedByDefault ? .on : .off
      boxes.append((box, choice))
      return box
    }
    func heading(_ text: String) -> NSTextField {
      let label = NSTextField(labelWithString: text)
      label.font = .systemFont(ofSize: NSFont.smallSystemFontSize, weight: .semibold)
      label.textColor = .secondaryLabelColor
      return label
    }

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 6
    stack.addArrangedSubview(heading("Also remove"))
    for choice in keep { stack.addArrangedSubview(checkbox(choice)) }
    stack.setCustomSpacing(14, after: stack.arrangedSubviews.last!)
    stack.addArrangedSubview(heading("Agent CLIs, and their sign-ins"))
    for choice in agents { stack.addArrangedSubview(checkbox(choice)) }
    stack.frame = NSRect(origin: .zero, size: stack.fittingSize)
    alert.accessoryView = stack

    // Keeping the command keeps Bun: untick the command and Bun goes grey.
    let cliBox = boxes.first { $0.1.title == cli.title }!.0
    let bunBox = boxes.first { $0.1.title == bun.title }!.0
    let link = CheckboxLink(source: cliBox, dependent: bunBox)
    cliBox.target = link
    cliBox.action = #selector(CheckboxLink.changed(_:))

    let uninstall = alert.addButton(withTitle: "Uninstall")
    uninstall.hasDestructiveAction = true
    alert.addButton(withTitle: "Cancel")

    let run = { (response: NSApplication.ModalResponse) in
      withExtendedLifetime(link) {}
      guard response == .alertFirstButtonReturn else { return }
      var flags: [String] = []
      for (box, choice) in boxes {
        if box.state == .on {
          if !choice.flag.isEmpty { flags.append(choice.flag) }
        } else if let keepFlag = choice.keepFlag {
          flags.append(keepFlag)
        }
      }
      start(flags: flags)
    }
    if let window {
      alert.beginSheetModal(for: window, completionHandler: run)
    } else {
      run(alert.runModal())
    }
  }

  private static func start(flags: [String]) {
    guard let bundled = Bundle.main.url(forResource: "uninstall", withExtension: "sh") else {
      failed("The uninstaller is missing from this copy of Kanna.")
      return
    }
    // Out of the bundle, which the script deletes while it runs.
    let script = FileManager.default.temporaryDirectory.appendingPathComponent("kanna-uninstall.sh")
    try? FileManager.default.removeItem(at: script)
    do {
      try FileManager.default.copyItem(at: bundled, to: script)
    } catch {
      failed(error.localizedDescription)
      return
    }

    // What only the app can do cleanly: the login item is its own, and the
    // Keychain item it made deletes without a prompt when it asks.
    try? LoginItem.disable()
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "sh.kanna.cloud"]
    while SecItemDelete(query as CFDictionary) == errSecSuccess {}

    let log = URL(fileURLWithPath: "/tmp/kanna-uninstall.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [script.path, "--yes", "--after-pid", String(ProcessInfo.processInfo.processIdentifier), "--app", Bundle.main.bundlePath] + flags
    // The login shell's PATH, so it finds the npm or bun each CLI came from.
    process.environment = ShellEnvironment.current()
    process.standardInput = FileHandle.nullDevice
    if let handle = try? FileHandle(forWritingTo: log) {
      process.standardOutput = handle
      process.standardError = handle
    }
    do {
      try process.run()
    } catch {
      failed(error.localizedDescription)
      return
    }
    // Quitting stops the server the app started; the script waits for that.
    NSApp.terminate(nil)
  }

  /// A checkbox that only means something while another one is on.
  private final class CheckboxLink: NSObject {
    private weak var dependent: NSButton?
    private var remembered: NSControl.StateValue

    init(source: NSButton, dependent: NSButton) {
      self.dependent = dependent
      remembered = dependent.state
    }

    @objc func changed(_ sender: NSButton) {
      guard let dependent else { return }
      if sender.state == .on {
        dependent.isEnabled = true
        dependent.state = remembered
      } else {
        remembered = dependent.state
        dependent.state = .off
        dependent.isEnabled = false
      }
    }
  }

  private static func failed(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Kanna couldn't start the uninstall"
    alert.informativeText = message
    alert.runModal()
  }
}

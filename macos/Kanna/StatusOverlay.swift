import AppKit
import QuartzCore

/// Covers the web view until the server answers: while it starts, when
/// `kanna` still has to be installed, and when it can't start.
///
/// It is the first thing a new user sees, so it looks like the web setup
/// wizard that follows it (src/client/components/auth/SetupWizard.tsx): the
/// flower in the logo pink, the thin progress bar under it, a centered
/// heading and pill buttons. Everything sits in one fixed-width column, so
/// installer output of any length never moves the buttons.
final class StatusOverlay: NSView {
  struct Action {
    let title: String
    let isDefault: Bool
    let perform: () -> Void
  }

  var backgroundColor: NSColor = .windowBackgroundColor {
    didSet { needsDisplay = true }
  }

  private static let columnWidth: CGFloat = 420

  private let logo = NSImageView(image: Brand.flower(size: 28))
  private let bar = ProgressBar()
  private let title = NSTextField(labelWithString: "")
  private let detail = NSTextField(wrappingLabelWithString: "")
  private let buttons = NSStackView()
  private var actions: [Action] = []
  /// The installer's last line of words, shown while a download's bare
  /// progress line ("#### 54.9%") only moves the bar.
  private var lastWords: String?

  override init(frame: NSRect) {
    super.init(frame: frame)
    title.font = .systemFont(ofSize: 20, weight: .semibold)
    title.textColor = .labelColor
    title.alignment = .center
    detail.font = .systemFont(ofSize: 13)
    detail.textColor = .secondaryLabelColor
    detail.alignment = .center
    detail.isSelectable = true
    detail.preferredMaxLayoutWidth = Self.columnWidth
    buttons.orientation = .horizontal
    buttons.spacing = 8

    let column = NSStackView(views: [logo, bar, title, detail, buttons])
    column.orientation = .vertical
    column.alignment = .centerX
    column.setCustomSpacing(20, after: logo)
    column.setCustomSpacing(32, after: bar)
    column.setCustomSpacing(8, after: title)
    column.setCustomSpacing(28, after: detail)
    column.translatesAutoresizingMaskIntoConstraints = false
    addSubview(column)
    NSLayoutConstraint.activate([
      column.centerXAnchor.constraint(equalTo: centerXAnchor),
      column.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -24),
      column.widthAnchor.constraint(equalToConstant: Self.columnWidth),
      detail.widthAnchor.constraint(equalTo: column.widthAnchor),
      bar.widthAnchor.constraint(equalToConstant: 176),
      bar.heightAnchor.constraint(equalToConstant: 4),
    ])
  }

  required init?(coder: NSCoder) { fatalError() }

  override func draw(_ dirtyRect: NSRect) {
    backgroundColor.setFill()
    dirtyRect.fill()
  }

  func hide() {
    isHidden = true
    bar.stop()
  }

  func show(busy: Bool, title: String, detail: String? = nil, monospaced: Bool = false, actions: [Action] = []) {
    let changedScreen = isHidden || self.title.stringValue != title
    isHidden = false
    self.title.stringValue = title

    var text = detail
    var progress: Double?
    if monospaced, let line = detail {
      // Bun's installer draws its download as "#####   54.9%": that's the
      // bar's job. Keep showing the last line that said something.
      if let percent = Self.percent(in: line) {
        progress = percent
        text = lastWords
      } else if !line.trimmingCharacters(in: .whitespaces).isEmpty {
        lastWords = line
      } else {
        text = lastWords
      }
    } else {
      lastWords = nil
    }
    if changedScreen, !monospaced { lastWords = nil }

    self.detail.stringValue = text ?? ""
    self.detail.isHidden = text == nil
    // One line of installer output, cut in the middle, so the column never
    // changes height while it streams.
    self.detail.font = monospaced ? .monospacedSystemFont(ofSize: 12, weight: .regular) : .systemFont(ofSize: 13)
    self.detail.maximumNumberOfLines = monospaced ? 1 : 0
    self.detail.lineBreakMode = monospaced ? .byTruncatingMiddle : .byWordWrapping

    bar.isHidden = !busy
    if busy {
      // A line of words after a download means the next phase: back to the sweep.
      if let progress { bar.setProgress(progress) } else { bar.setIndeterminate() }
    } else {
      bar.stop()
    }

    // Rebuild the buttons only when they change, so a streaming line never
    // re-lays them out.
    let titles = actions.map(\.title)
    self.actions = actions
    if titles != buttons.arrangedSubviews.compactMap({ ($0 as? PillButton)?.title }) {
      buttons.arrangedSubviews.forEach { $0.removeFromSuperview() }
      for (index, action) in actions.enumerated() {
        let button = PillButton(title: action.title, primary: action.isDefault, target: self, action: #selector(clicked(_:)))
        button.tag = index
        if action.isDefault { button.keyEquivalent = "\r" }
        buttons.addArrangedSubview(button)
      }
    }
    buttons.isHidden = actions.isEmpty
  }

  @objc private func clicked(_ sender: NSButton) {
    actions[sender.tag].perform()
  }

  private static func percent(in line: String) -> Double? {
    guard let match = line.range(of: #"^[#\s=>-]*([0-9]+(?:\.[0-9]+)?)%\s*$"#, options: .regularExpression) else { return nil }
    let digits = line[match].filter { $0.isNumber || $0 == "." }
    return Double(digits).map { min(max($0 / 100, 0), 1) }
  }
}

/// The web client's brand, for the few native surfaces (src/index.css).
enum Brand {
  /// --logo: oklch(71.2% 0.194 13.428).
  static let logo = NSColor(srgbRed: 1, green: 0.388, blue: 0.494, alpha: 1)
  /// --primary: near-white in dark, near-black in light.
  static let primary = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      ? NSColor(srgbRed: 0.98, green: 0.98, blue: 0.98, alpha: 1)
      : NSColor(srgbRed: 0.059, green: 0.090, blue: 0.165, alpha: 1)
  }
  static let primaryText = NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      ? NSColor(srgbRed: 0.059, green: 0.090, blue: 0.165, alpha: 1)
      : NSColor(srgbRed: 0.98, green: 0.98, blue: 0.98, alpha: 1)
  }

  /// lucide's `flower`, the page's logo mark, stroked in the logo pink.
  static func flower(size: CGFloat) -> NSImage {
    let svg = """
    <svg xmlns="http://www.w3.org/2000/svg" width="\(size)" height="\(size)" viewBox="0 0 24 24" fill="none" stroke="#FF637E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5"/><path d="M12 7.5V9"/><path d="M7.5 12H9"/><path d="M16.5 12H15"/><path d="M12 16.5V15"/><path d="m8 8 1.88 1.88"/><path d="M14.12 9.88 16 8"/><path d="m8 16 1.88-1.88"/><path d="M14.12 14.12 16 16"/></svg>
    """
    return NSImage(data: Data(svg.utf8)) ?? NSImage()
  }
}

/// The wizard's progress bar: a 4pt pink fill on a faint track. Without a
/// percentage, a short segment runs across it at a constant speed (linear:
/// it's steady motion, not an arrival).
private final class ProgressBar: NSView {
  private let fill = CALayer()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.cornerRadius = 2
    layer?.masksToBounds = true
    fill.cornerRadius = 2
    fill.backgroundColor = Brand.logo.cgColor
    layer?.addSublayer(fill)
  }

  required init?(coder: NSCoder) { fatalError() }

  private var progress: Double?

  override func updateLayer() {
    layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.12).cgColor
  }

  override var wantsUpdateLayer: Bool { true }

  override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if let progress {
      fill.frame = CGRect(x: 0, y: 0, width: bounds.width * progress, height: bounds.height)
    } else {
      fill.frame = CGRect(x: 0, y: 0, width: bounds.width * 0.3, height: bounds.height)
      if fill.animation(forKey: "sweep") == nil { restartSweep() }
    }
    CATransaction.commit()
  }

  /// Keeps a sweep that's already running, so it never jumps back.
  func setIndeterminate() {
    if progress == nil, fill.animation(forKey: "sweep") != nil { return }
    progress = nil
    needsLayout = true
    restartSweep()
  }

  func setProgress(_ value: Double) {
    let wasIndeterminate = progress == nil
    progress = value
    fill.removeAnimation(forKey: "sweep")
    CATransaction.begin()
    CATransaction.setDisableActions(wasIndeterminate)
    CATransaction.setAnimationDuration(0.2)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1))
    fill.frame = CGRect(x: 0, y: 0, width: bounds.width * value, height: bounds.height)
    CATransaction.commit()
  }

  func stop() {
    fill.removeAllAnimations()
    progress = nil
  }

  private func restartSweep() {
    guard progress == nil, bounds.width > 0 else { return }
    let segment = bounds.width * 0.3
    let sweep = CABasicAnimation(keyPath: "position.x")
    sweep.fromValue = -segment / 2
    sweep.toValue = bounds.width + segment / 2
    sweep.duration = 1.1
    sweep.repeatCount = .infinity
    sweep.timingFunction = CAMediaTimingFunction(name: .linear)
    fill.add(sweep, forKey: "sweep")
  }
}

/// The page's rounded-full buttons: the default action filled with the
/// primary color, the rest outlined. Pressing dims it at once.
final class PillButton: NSButton {
  private let primary: Bool

  init(title: String, primary: Bool, target: AnyObject?, action: Selector?) {
    self.primary = primary
    super.init(frame: .zero)
    self.title = title
    self.target = target
    self.action = action
    isBordered = false
    font = .systemFont(ofSize: 13, weight: .medium)
    setButtonType(.momentaryChange)
  }

  required init?(coder: NSCoder) { fatalError() }

  override var intrinsicContentSize: NSSize {
    let width = (title as NSString).size(withAttributes: [.font: font as Any]).width
    return NSSize(width: ceil(width) + 36, height: 36)
  }

  override func draw(_ dirtyRect: NSRect) {
    let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
    let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)
    let pressed = isHighlighted
    if primary {
      Brand.primary.withAlphaComponent(pressed ? 0.8 : 1).setFill()
      path.fill()
    } else {
      NSColor.labelColor.withAlphaComponent(pressed ? 0.1 : 0.04).setFill()
      path.fill()
      NSColor.labelColor.withAlphaComponent(0.14).setStroke()
      path.lineWidth = 1
      path.stroke()
    }
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font as Any,
      .foregroundColor: primary ? Brand.primaryText : NSColor.labelColor,
    ]
    let size = (title as NSString).size(withAttributes: attributes)
    (title as NSString).draw(
      at: NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2),
      withAttributes: attributes
    )
  }

  override func resetCursorRects() {
    addCursorRect(bounds, cursor: .pointingHand)
  }
}

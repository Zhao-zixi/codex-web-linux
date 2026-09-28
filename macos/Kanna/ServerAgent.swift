import AppKit
import Foundation

/// Keeps one Kanna server running while the app is open.
///
/// The app is a window around the globally installed `kanna` (bun install -g
/// kanna-code), the same one a terminal runs, so the two are always one
/// version and npm's updater keeps working. The app and the command share one
/// server per data dir (the CLI's single-instance guard,
/// src/server/instance.ts): on launch the app first looks for a server a
/// terminal already started and adopts it, and only when there is none does
/// it run `kanna --no-open` itself. A server the app started dies with the
/// app; an adopted one belongs to its terminal and is left alone. Either way,
/// if the server goes away while the app is open, the app starts its own, so
/// the window never sits on a dead page. In Development mode (ServerMode.swift)
/// the same holds for a checkout's `bun run dev`.
final class ServerAgent {
  static let shared = ServerAgent()

  enum State: Equatable {
    case starting
    case running(URL)
    case notInstalled
    case installing(String)
    /// A custom server (ServerMode.custom) that isn't answering yet. The app
    /// doesn't run it, so it keeps checking until it does.
    case waiting(URL)
    case failed(String)
  }

  private(set) var state: State = .starting {
    didSet { if state != oldValue { onChange?(state) } }
  }
  var onChange: ((State) -> Void)?

  var serverURL: URL? {
    if case .running(let url) = state { return url }
    return nil
  }

  /// Non-nil while the app owns the server process.
  private var process: Process?
  private var connecting = false
  private var stopping = false
  private var failures = 0
  private var reachedRunning = false
  private var outputBuffer = Data()
  private var recentOutput: [String] = []
  private var adoptAfterExit: URL?
  private var monitor: Timer?
  private var missedHealthChecks = 0
  private var readiness: Task<Void, Never>?
  private let log = ServerLog()

  private(set) var mode = ServerMode.current
  private static let maxFailures = 5

  // MARK: Start

  /// Show a server, starting one if needed. `preferred` comes from a terminal
  /// `kanna` (kanna-app://open?url=…) and is only used if it is ours.
  func start(preferring preferred: URL? = nil) {
    if serverURL != nil { return }
    guard !connecting else { return }
    connecting = true
    Task {
      await connect(preferring: preferred)
      connecting = false
    }
  }

  private func connect(preferring preferred: URL?) async {
    stopping = false
    if case .custom(let url) = mode {
      await connectToCustom(url)
      return
    }
    if case .failed = state {} else { state = .starting }
    var candidates = [URL]()
    // A terminal `kanna` names the installed server; it means nothing to a
    // window showing the dev one.
    if let preferred, mode == .installed { candidates.append(preferred) }
    candidates.append(mode.pageURL)
    for candidate in candidates {
      if let url = await Self.probe(candidate, fingerprint: mode.fingerprint) {
        adopt(url)
        return
      }
    }
    // Finding `kanna` runs the login shell once; keep it off the main thread.
    let mode = self.mode
    switch await Task.detached(operation: { Runtime.locate(for: mode) }).value {
    case .found(let runtime):
      launch(runtime)
    case .notInstalled:
      state = .notInstalled
    case .unavailable(let message):
      state = .failed(message)
    }
  }

  /// Someone else runs a custom server, so there's nothing to launch: show it
  /// once it answers, and look again every couple of seconds until then.
  private func connectToCustom(_ url: URL) async {
    if let ready = await Self.probe(url, fingerprint: nil) {
      adopt(ready)
      return
    }
    state = .waiting(url)
    // A fresh start() rather than looping here: start() ignores calls while a
    // connect is in flight, and a Server menu switch must not be one of them.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, !self.stopping, self.mode == .custom(url), case .waiting = self.state else { return }
        self.start()
      }
    }
  }

  /// The Server menu. Stops a server the app started for the old mode.
  func switchMode(to mode: ServerMode) {
    ServerMode.current = mode
    guard mode != self.mode else { return }
    self.mode = mode
    restart()
  }

  /// Stop what the app runs and start again (a new mode or checkout).
  func restart() {
    monitor?.invalidate()
    readiness?.cancel()
    failures = 0
    state = .starting
    stop { [weak self] in self?.start() }
  }

  private func adopt(_ url: URL) {
    if process != nil { reachedRunning = true }
    state = .running(url)
    missedHealthChecks = 0
    startMonitor()
  }

  /// A server started from a terminal exits with its terminal. Polling
  /// `/health` is how the app notices, since it has no handle on that process.
  private func startMonitor() {
    monitor?.invalidate()
    monitor = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.checkHealth() }
    }
  }

  private func checkHealth() {
    guard let url = serverURL, !stopping else { return }
    let fingerprint = mode.fingerprint
    Task {
      if await Self.probe(url, fingerprint: fingerprint) != nil {
        missedHealthChecks = 0
        return
      }
      missedHealthChecks += 1
      // An owned process reports its own exit (and restarts itself in place
      // after an npm update); two misses rule out a server that is only busy.
      guard process == nil, missedHealthChecks >= 2, serverURL == url else { return }
      monitor?.invalidate()
      state = .starting
      start()
    }
  }

  // MARK: Launch

  private func launch(_ runtime: Runtime) {
    let process = Process()
    process.executableURL = runtime.executable
    process.arguments = runtime.arguments
    process.environment = runtime.environment
    process.currentDirectoryURL = runtime.directory
    process.standardInput = FileHandle.nullDevice

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self?.consume(data) }
      }
    }
    process.terminationHandler = { [weak self] exited in
      DispatchQueue.main.async {
        MainActor.assumeIsolated { self?.didExit(exited) }
      }
    }

    outputBuffer.removeAll()
    recentOutput.removeAll()
    reachedRunning = false
    adoptAfterExit = nil
    log.begin(command: ([runtime.executable.path] + runtime.arguments).joined(separator: " "))
    do {
      try process.run()
      self.process = process
    } catch {
      log.write("failed to start: \(error.localizedDescription)\n")
      recordFailure("Kanna didn't start: \(error.localizedDescription)")
      return
    }
    // `bun run dev` prints the server's port before Vite serves a page, so
    // wait for the page itself.
    if mode == .development { awaitPage(of: process) }
  }

  private func awaitPage(of process: Process) {
    readiness?.cancel()
    let url = mode.pageURL
    let fingerprint = mode.fingerprint
    readiness = Task {
      while !Task.isCancelled, process.isRunning, self.process === process {
        if let ready = await Self.probe(url, fingerprint: fingerprint) {
          failures = 0
          adopt(ready)
          return
        }
        try? await Task.sleep(for: .milliseconds(500))
      }
    }
  }

  private func consume(_ data: Data) {
    log.write(data)
    outputBuffer.append(data)
    while let newline = outputBuffer.firstIndex(of: 0x0A) {
      let lineData = outputBuffer[outputBuffer.startIndex..<newline]
      outputBuffer.removeSubrange(outputBuffer.startIndex...newline)
      guard let line = String(data: lineData, encoding: .utf8) else { continue }
      handle(line: line)
    }
  }

  /// The CLI's own log lines are the contract (src/server/cli-runtime.ts):
  /// "[kanna] listening on http://127.0.0.1:<port>" once the port is bound
  /// (again after each update restart), and "kanna is already running at
  /// <url>" when a terminal won a race.
  private func handle(line: String) {
    recentOutput.append(line)
    if recentOutput.count > 30 { recentOutput.removeFirst(recentOutput.count - 30) }

    if mode == .installed, let range = line.range(of: "[kanna] listening on http://"),
       let port = Int(line[range.upperBound...].split(separator: ":").last ?? "") {
      reachedRunning = true
      failures = 0
      adopt(Self.localURL(port: port))
    } else if let range = line.range(of: "is already running at "),
              let url = URL(string: String(line[range.upperBound...].split(separator: " ").first ?? "")) {
      adoptAfterExit = url
    }
  }

  private func didExit(_ exited: Process) {
    guard exited === process else { return }
    process = nil
    readiness?.cancel()
    log.write("\n[exited with status \(exited.terminationStatus)]\n")
    if stopping { return }
    monitor?.invalidate()

    if let url = adoptAfterExit {
      state = .starting
      start(preferring: url)
    } else if reachedRunning {
      // It ran and then died: start a fresh one right away.
      state = .starting
      start()
    } else {
      let tail = recentOutput.suffix(6).joined(separator: "\n")
      recordFailure(tail.isEmpty ? "Kanna stopped (status \(exited.terminationStatus))." : tail)
    }
  }

  private func recordFailure(_ message: String) {
    failures += 1
    if failures >= Self.maxFailures {
      state = .failed(message)
      return
    }
    state = .starting
    let delay = Double(failures) * 2
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
      MainActor.assumeIsolated { self?.start() }
    }
  }

  /// "Try Again" after `.failed`, or after installing `kanna` by hand.
  func retry() {
    failures = 0
    state = .starting
    ShellEnvironment.reload()
    start()
  }

  // MARK: Install

  /// `bun install -g kanna-code`, installing Bun first when it's missing (to
  /// ~/.bun, the way bun.sh/install does it for a terminal). Afterwards the
  /// app runs the same `kanna` a terminal would, and npm updates it.
  func install() {
    state = .installing("Starting…")
    log.begin(command: "install kanna-code")
    let environment = ShellEnvironment.current()
    Task.detached {
      let status = Installer.run(environment: environment) { line in
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            self.log.write(line + "\n")
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { self.state = .installing(line) }
          }
        }
      }
      await MainActor.run {
        if status == 0 {
          self.retry()
        } else {
          self.state = .failed("Installing Kanna failed (status \(status)). Show Log has the installer's output.")
        }
      }
    }
  }

  // MARK: Stop

  /// Stop a server this app started, then call `completion`. SIGTERM reaches
  /// the CLI's supervisor, which passes it to the server; the server cancels
  /// running turns (they resume on next start), compacts its logs and marks
  /// the machine offline on kanna.sh, so it gets time to finish. SIGKILL only
  /// if it hangs.
  func stop(completion: @escaping () -> Void) {
    stopping = true
    monitor?.invalidate()
    guard let process, process.isRunning else {
      completion()
      return
    }
    process.terminate()
    let pid = process.processIdentifier
    DispatchQueue.global().async {
      let deadline = Date().addingTimeInterval(20)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
      }
      if process.isRunning { kill(pid, SIGKILL) }
      DispatchQueue.main.async(execute: completion)
    }
  }

  var isOwned: Bool { process != nil }
  var logURL: URL { log.url }

  // MARK: Probe

  /// `http://localhost:<port>`. Always localhost, never 127.0.0.1: the web
  /// client keeps its preferences in localStorage, which is per origin.
  static func localURL(port: Int) -> URL {
    URL(string: "http://localhost:\(port)")!
  }

  /// The server's URL if a Kanna answers /health at `url`. With a
  /// fingerprint, only a local one serving that data dir counts: that's how
  /// the installed server and the dev one are told apart, and why a
  /// kanna-app:// link can't point the window anywhere else. Without one (a
  /// custom server the user typed in), any Kanna at that address does.
  static func probe(_ url: URL, fingerprint: String?) async -> URL? {
    guard let fingerprint else { return await probeAny(url) }
    guard let host = url.host, isLoopback(host), let port = url.port else { return nil }
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
    request.timeoutInterval = 1
    guard let (data, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200,
          let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          body["ok"] as? Bool == true,
          body["instance"] as? String == fingerprint else { return nil }
    return localURL(port: port)
  }

  private static func probeAny(_ url: URL) async -> URL? {
    guard let health = URL(string: "/health", relativeTo: url) else { return nil }
    var request = URLRequest(url: health)
    request.timeoutInterval = 2
    guard let (data, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200,
          let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          body["ok"] as? Bool == true else { return nil }
    return url
  }

  static func isLoopback(_ host: String) -> Bool {
    ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
  }
}

/// How to start the server for a mode. Installed: the `kanna` on the user's
/// PATH, which is the CLI's supervisor, so it restarts in place after an npm
/// update. Development: `bun run dev` in the checkout.
nonisolated struct Runtime {
  enum Located {
    case found(Runtime)
    case notInstalled
    case unavailable(String)
  }

  let executable: URL
  let arguments: [String]
  let directory: URL
  let environment: [String: String]

  static func locate(for mode: ServerMode) -> Located {
    var environment = ShellEnvironment.current()
    // src/server/mac-app.ts: what the app starts exits if the app crashes
    // instead of outliving it.
    environment["KANNA_EXIT_WITH_PARENT"] = "1"
    // The server skips its own login-shell PATH lookup (inheritShellPath in
    // src/server/process-utils.ts); this environment already has it.
    environment["KANNA_SHELL_ENV_IMPORTED"] = "1"

    switch mode {
    case .installed:
      guard let kanna = ShellEnvironment.which("kanna", in: environment) else { return .notInstalled }
      return .found(Runtime(
        executable: URL(fileURLWithPath: kanna),
        arguments: ["--no-open"],
        directory: FileManager.default.homeDirectoryForCurrentUser,
        environment: environment
      ))
    case .development:
      guard let checkout = DevCheckout.url else {
        return .unavailable("Development mode needs a Kanna checkout. Choose one with Server › Choose Checkout…, or switch to Server › Installed Kanna.")
      }
      guard let bun = ShellEnvironment.which("bun", in: environment) else {
        return .unavailable("Development mode runs `bun run dev`, and Bun isn't on your PATH.")
      }
      return .found(Runtime(
        executable: URL(fileURLWithPath: bun),
        arguments: ["run", "./scripts/dev.ts"],
        directory: checkout,
        environment: environment
      ))
    case .custom:
      // connectToCustom never launches anything.
      return .unavailable("A custom server is started by whoever runs it.")
    }
  }
}

/// The user's login-shell environment. An app opened from Finder (or at
/// login) gets launchd's bare one, without the PATH that finds `kanna`,
/// `bun`, `claude` and `codex`, or the variables agents read, like
/// ANTHROPIC_API_KEY, HTTPS_PROXY and cloud credentials. So the app asks an
/// interactive login shell once and hands everything to the server, as if
/// it had been started from a terminal.
nonisolated enum ShellEnvironment {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var cached: [String: String]?

  /// Where installers put things; searched even when the shell's PATH misses
  /// them (a shell profile that failed, or an install from this session).
  private static var fallbackDirectories: [String] {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return ["\(home)/.bun/bin", "\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
  }

  static func current() -> [String: String] {
    lock.lock()
    defer { lock.unlock() }
    if let cached { return cached }
    let loaded = load()
    cached = loaded
    return loaded
  }

  /// After an install that edited the shell profile.
  static func reload() {
    lock.lock()
    cached = nil
    lock.unlock()
  }

  static func which(_ command: String, in environment: [String: String]) -> String? {
    let path = environment["PATH"] ?? ""
    for directory in path.split(separator: ":").map(String.init) + fallbackDirectories {
      let candidate = (directory as NSString).appendingPathComponent(command)
      if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return nil
  }

  private static func load() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    let marker = "__KANNA_SHELL_ENV__"
    let shell = environment["SHELL"] ?? "/bin/zsh"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = ["-ilc", "printf '%s' \(marker); /usr/bin/env -0"]
    process.standardInput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    // oh-my-zsh otherwise asks whether to update, and nobody can answer.
    process.environment = environment.merging(["DISABLE_AUTO_UPDATE": "true"]) { _, new in new }
    let pipe = Pipe()
    process.standardOutput = pipe

    var output = Data()
    let done = DispatchSemaphore(value: 0)
    if (try? process.run()) != nil {
      DispatchQueue.global().async {
        output = pipe.fileHandleForReading.readDataToEndOfFile()
        done.signal()
      }
      // A profile that waits on something (a prompt, a slow plugin) must not
      // keep Kanna from starting.
      if done.wait(timeout: .now() + 5) == .timedOut {
        process.terminate()
        done.wait()
      }
    }

    if let start = output.range(of: Data(marker.utf8))?.upperBound {
      for entry in output[start...].split(separator: 0) {
        guard let pair = String(data: Data(entry), encoding: .utf8),
              let equals = pair.firstIndex(of: "=") else { continue }
        let key = String(pair[..<equals])
        if ["PWD", "OLDPWD", "SHLVL", "_", "DISABLE_AUTO_UPDATE"].contains(key) { continue }
        environment[key] = String(pair[pair.index(after: equals)...])
      }
    }

    var path = (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
    for directory in fallbackDirectories where !path.contains(directory) {
      path.append(directory)
    }
    environment["PATH"] = path.joined(separator: ":")
    return environment
  }
}

/// Installs Bun (when missing) and kanna-code for the "Install Kanna" button.
nonisolated enum Installer {
  private static let script = """
  set -e
  if ! command -v bun >/dev/null 2>&1; then
    echo "Installing Bun…"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
  echo "Installing kanna-code…"
  bun install -g kanna-code
  echo "Installed $(kanna --version 2>/dev/null || echo kanna)"
  """

  /// Runs the install, reporting each output line; returns the exit status.
  static func run(environment: [String: String], onLine: @escaping @Sendable (String) -> Void) -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = ["-c", script]
    process.environment = environment
    process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    process.standardInput = FileHandle.nullDevice
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    guard (try? process.run()) != nil else { return -1 }
    var buffer = Data()
    while true {
      let chunk = pipe.fileHandleForReading.availableData
      if chunk.isEmpty { break }
      buffer.append(chunk)
      // Progress bars redraw with \r; treat it as a line break too.
      while let index = buffer.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
        let line = String(data: buffer[buffer.startIndex..<index], encoding: .utf8) ?? ""
        buffer.removeSubrange(buffer.startIndex...index)
        onLine(line)
      }
    }
    process.waitUntilExit()
    return process.terminationStatus
  }
}

/// ~/Library/Logs/Kanna/server.log: everything the app's server (and the
/// installer) prints. Help › Show Server Log opens it.
final class ServerLog {
  let url: URL
  private var handle: FileHandle?

  init() {
    let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Kanna")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    url = dir.appendingPathComponent("server.log")
  }

  func begin(command: String) {
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    if size > 5_000_000 || !FileManager.default.fileExists(atPath: url.path) {
      FileManager.default.createFile(atPath: url.path, contents: nil)
    }
    handle = handle ?? (try? FileHandle(forWritingTo: url))
    _ = try? handle?.seekToEnd()
    write("\n=== \(Date()) \(command)\n")
  }

  func write(_ text: String) { write(Data(text.utf8)) }

  func write(_ data: Data) {
    try? handle?.write(contentsOf: data)
  }
}

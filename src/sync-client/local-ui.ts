/** Self-contained responsive UI served by the local sync helper. */
export function renderLocalSyncUi({ serverOrigin }: { serverOrigin: string }) {
  const safeJson = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Kanna 同步助手</title>
  <style>
    :root{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#f7f7f8;--panel:#fff;--fg:#202124;--muted:#6e737d;--line:#e5e7eb;--accent:#ef4f70;--accent-soft:#fff0f3;--good:#17834c;--warn:#9a6811;--error:#b42332;--shadow:0 10px 32px #1720330b}
    @media(prefers-color-scheme:dark){:root{--bg:#151619;--panel:#202125;--fg:#f2f2f3;--muted:#a1a3ab;--line:#373940;--accent:#ff7893;--accent-soft:#36232a;--good:#64d69a;--warn:#f0bc64;--error:#ff8c98;--shadow:0 12px 36px #0005}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);min-height:100vh;padding:clamp(18px,5vw,56px) 16px 40px}.shell{max-width:760px;margin:0 auto}.brand{display:flex;align-items:center;gap:12px;margin:0 0 24px}.mark{display:grid;place-items:center;width:42px;height:42px;border-radius:14px;background:var(--accent-soft);color:var(--accent);font-size:22px;font-weight:750}.brand h1{font-size:20px;letter-spacing:-.35px;margin:0}.brand p{font-size:13px;color:var(--muted);margin:4px 0 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow);padding:clamp(18px,4vw,28px)}.eyebrow{color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.05em;text-transform:uppercase}.heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.heading h2{font-size:19px;margin:4px 0 6px;letter-spacing:-.3px}.muted{color:var(--muted)}.subtle{font-size:13px;line-height:1.55;color:var(--muted);margin:0}.pill{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:var(--muted);font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:currentColor}.pill.good{color:var(--good)}.pill.warn{color:var(--warn)}.pill.error{color:var(--error)}.divider{height:1px;background:var(--line);margin:22px 0}.stack{display:flex;flex-direction:column;gap:16px}.field{display:flex;flex-direction:column;gap:7px}.field label{font-size:13px;font-weight:620}.input{width:100%;height:44px;border:1px solid var(--line);border-radius:11px;padding:0 12px;background:var(--panel);color:var(--fg);font:inherit;outline:none}.input:focus,.path-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.button{display:inline-flex;justify-content:center;align-items:center;gap:8px;min-height:42px;border:1px solid var(--line);border-radius:11px;background:var(--panel);color:var(--fg);padding:0 15px;font-family:inherit;font-size:13px;font-weight:600;line-height:1.1;cursor:pointer;text-decoration:none;transition:transform .12s ease,border-color .12s ease,background .12s ease}.button:hover:not(:disabled){border-color:color-mix(in srgb,var(--accent) 45%,var(--line));transform:translateY(-1px)}.button:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 35%,transparent);outline-offset:2px}.button.primary{background:var(--accent);border-color:var(--accent);color:white}.button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 88%,black)}.button.danger{color:var(--error)}.button:disabled{opacity:.54;cursor:wait}.message{border:1px solid var(--line);border-radius:11px;padding:11px 12px;font-size:13px;line-height:1.5}.message.error{border-color:color-mix(in srgb,var(--error) 30%,var(--line));background:color-mix(in srgb,var(--error) 7%,var(--panel));color:var(--error)}.message.info{background:color-mix(in srgb,var(--accent) 5%,var(--panel));color:var(--muted)}.progress{height:6px;background:var(--line);border-radius:10px;overflow:hidden}.progress span{display:block;height:100%;width:42%;background:var(--accent);border-radius:inherit;animation:move 1.35s ease-in-out infinite alternate}@keyframes move{to{transform:translateX(135%)}}.directory{border:1px solid var(--line);border-radius:13px;overflow:hidden}.directory-head{display:flex;align-items:center;gap:9px;padding:10px;border-bottom:1px solid var(--line)}.path-input{flex:1;min-width:0;height:36px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);font:12px ui-monospace,SFMono-Regular,monospace;padding:0 9px;outline:none}.entries{max-height:220px;overflow:auto}.entry{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:42px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--fg);padding:8px 12px;text-align:left;font-family:inherit;font-size:13px;line-height:1.3;cursor:pointer}.entry:last-child{border-bottom:0}.entry:hover{background:var(--bg)}.entry span{overflow-wrap:anywhere}.empty{padding:14px;color:var(--muted);font-size:13px}.detail-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}.detail{min-width:0;border:1px solid var(--line);border-radius:12px;padding:12px}.detail span{display:block;font-size:11px;color:var(--muted);margin-bottom:5px}.detail strong,.detail code{display:block;overflow-wrap:anywhere;font-size:13px;font-weight:580}.dependencies{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.dependency{border:1px solid var(--line);border-radius:10px;padding:9px 10px;font-size:12px;color:var(--muted)}.dependency.ok{color:var(--good);border-color:color-mix(in srgb,var(--good) 30%,var(--line))}.dependency.missing{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 30%,var(--line))}.environment-details{border-top:1px solid var(--line);padding-top:12px}.environment-details summary{cursor:pointer;color:var(--muted);font-size:12px}.environment-details .dependencies{margin-top:10px}.footer{padding:15px 4px 0;text-align:center;color:var(--muted);font-size:11px;line-height:1.5}.hidden{display:none!important}
    @media(max-width:520px){body{padding:20px 12px 30px}.brand{margin-bottom:18px}.brand h1{font-size:18px}.card{border-radius:15px;padding:17px}.heading{flex-direction:column;gap:9px}.heading .pill{align-self:flex-start}.detail-grid{grid-template-columns:1fr}.dependencies{grid-template-columns:1fr}.actions .button{flex:1 1 130px}.directory-head{flex-wrap:wrap}.directory-head .button{flex:1}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="brand"><div class="mark" aria-hidden="true">K</div><div><h1>Kanna 同步助手</h1><p>选择电脑上的项目文件夹，连接到你的 Kanna 工作区</p></div></header>
    <section class="card" aria-labelledby="main-title">
      <div class="heading"><div><div class="eyebrow">Remote workspace</div><h2 id="main-title">连接你的项目</h2><p class="subtle">用户名和密码仅用于登录授权；设备密钥会保存在本机助手数据目录。</p></div><span id="phase-pill" class="pill"><span class="dot"></span><span id="phase-label">正在读取</span></span></div>
      <div id="notice" class="message hidden" role="status" aria-live="polite"></div>
      <div id="error" class="message error hidden" role="alert"></div>
      <div id="progress-area" class="hidden" aria-live="polite"><div id="step-label" class="subtle"></div><div class="progress" style="margin-top:9px"><span></span></div></div>
      <div id="origin-label" class="subtle" style="margin-top:12px"></div>
      <div class="divider"></div>
      <div id="ready-view" class="stack">
        <div class="stack" style="gap:9px"><div style="font-size:14px;font-weight:650">1 · 选择本机项目文件夹</div><p class="subtle">助手只会同步你选中的文件夹。选择一个 Kanna 可用的项目目录；不会上传其他个人文件。</p></div>
        <div class="directory"><div class="directory-head"><input id="browse-path" class="path-input" aria-label="当前浏览路径"><button id="go-path" class="button" type="button">打开</button><button id="select-directory" class="button" type="button">使用此文件夹</button></div><div id="entries" class="entries" role="listbox" aria-label="文件夹列表"></div></div>
        <div id="selected-path" class="message info hidden"></div>
        <div class="divider" style="margin:2px 0"></div>
        <div class="stack" style="gap:9px"><div style="font-size:14px;font-weight:650">2 · 登录并连接</div><p class="subtle">首次连接时输入你登录 Kanna 使用的用户名和密码。此电脑会登记为一台已授权设备。</p></div>
        <form id="connect-form" class="stack" autocomplete="on">
          <div class="field"><label for="username">用户名</label><input id="username" class="input" name="username" autocomplete="username" required></div>
          <div class="field"><label for="password">密码</label><input id="password" class="input" name="password" type="password" autocomplete="current-password" required></div>
          <div class="actions"><button id="connect" class="button primary" type="submit" disabled>连接并开始同步</button><button class="button" type="button" data-action="open-kanna">打开 Kanna</button></div>
        </form>
      </div>
      <div id="active-view" class="stack hidden">
        <div class="detail-grid"><div class="detail"><span>本机文件夹</span><strong id="local-directory"></strong></div><div class="detail"><span>Kanna 项目目录</span><code id="remote-path"></code></div></div>
        <div id="sync-summary" class="message info"></div>
        <div id="conflict-list" class="stack hidden" aria-label="同步冲突"></div>
        <details class="environment-details"><summary>查看运行环境</summary><div id="dependencies" class="dependencies" aria-label="本机依赖状态"></div></details>
        <div class="actions"><button id="pause" class="button" type="button" data-action="pause">暂停同步</button><button id="resume" class="button primary" type="button" data-action="resume">继续同步</button><button class="button" type="button" data-action="restart">重新连接</button><button class="button" type="button" data-action="open-kanna">打开 Kanna</button></div>
        <p class="subtle">关闭网页不会主动停止本机同步。设备在线状态不会显示在 Kanna 设置页中。</p>
      </div>
      <div id="error-view" class="stack hidden"><p class="subtle">检查网络后可以重新连接。重新连接会使用已保存的设备授权。</p><div class="actions"><button class="button primary" type="button" data-action="restart">重新连接</button><button class="button" type="button" data-action="open-kanna">打开 Kanna</button></div><details class="environment-details"><summary>查看准备详情</summary><div class="dependencies" id="error-dependencies" aria-label="本机依赖状态"></div></details></div>
    </section>
    <footer class="footer">需要管理设备授权？请返回 Kanna 网页，在“设置 → 常规 → 同步助手”查看已授权设备。撤销后会阻止新连接；正在进行的同步可能继续，请先在本地助手中暂停同步。</footer>
  </main>
  <script>
  (() => {
    const token = (() => {
      const key = "kanna.sync.token"
      let fragment = ""
      try { fragment = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : "" } catch {}
      if (fragment) {
        try { sessionStorage.setItem(key, fragment) } catch {}
        history.replaceState(null, "", location.pathname + location.search)
        return fragment
      }
      try { return sessionStorage.getItem(key) || "" } catch { return "" }
    })()
    const serverOrigin = ${safeJson(serverOrigin)}
    const ui = {
      status: null,
      currentPath: "",
      parentPath: null,
      entries: [],
      selectedDirectory: "",
      busy: false,
      error: "",
      notice: "",
    }
    const byId = (id) => document.getElementById(id)
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character])
    const labels = { ready: "等待连接", starting: "正在准备", active: "助手已启动", paused: "同步已暂停", error: "需要处理" }
    const errorMessages = {
      invalid_credentials: "用户名或密码不正确，请重新输入。",
      authentication_failed: "登录失败。请检查用户名、密码和网络后重试。",
      device_enrollment_unavailable: "此工作区暂未开放设备授权，请联系管理员。",
      device_enrollment_failed: "这台电脑暂时无法登记，请稍后重试。",
      ssh_unavailable: "本机缺少 OpenSSH 工具。请先安装系统提供的 OpenSSH 客户端，再重新打开助手。",
      ssh_install_failed: "无法准备 Windows SSH 工具。请确认当前用户有权限运行解压出的工具，再重新打开助手。",
      ssh_keygen_failed: "无法在本机生成设备密钥。请确认系统 OpenSSH 工具可用，并检查本机用户目录的写入权限。",
      download_failed: "下载同步工具失败。请检查网络后重试。",
      download_verification_failed: "同步工具的完整性校验失败。请删除助手本机工具缓存后重试，并联系管理员检查发布包。",
      mutagen_install_failed: "无法准备同步组件。请确认本机磁盘空间和写入权限后重试。",
      remote_path_exists: "远程项目目录已存在。请在 Kanna 中确认目录内容后，再选择其他本机项目文件夹。",
      sync_conflict: "同步发现文件冲突。请先备份双方文件，手动比较并合并后，再恢复同步。",
      remote_directory_exists: "远程项目目录已存在。请在 Kanna 中确认目录内容后，再选择其他本机项目文件夹。",
      directory_unavailable: "无法访问所选文件夹。请确认它仍存在且当前用户有读取权限。",
      invalid_project_directory: "该文件夹名称无法作为 Kanna 项目目录。请改选名称较短且不含斜线的文件夹。",
      ssh_connection_failed: "无法连接工作区 SSH 服务。请检查网络，并确认此设备仍在网页的已授权设备列表中。",
      sync_failed: "同步启动或控制失败。请检查网络和本机依赖后重试。",
      mutagen_status_unavailable: "无法读取同步状态。请尝试重新连接；若仍失败，请联系管理员。",
      session_not_found: "找不到此助手管理的同步会话。请尝试重新连接。",
      operation_in_progress: "正在进行其他连接操作，请稍后重试。",
      another_project_active: "此账号已配置另一个本地项目。请返回该项目文件夹重新连接。",
      unsafe_local_directory: "不能同步用户主目录或助手数据所在位置。请选择其中的项目文件夹。",
    }
    async function request(path, options = {}) {
      const headers = new Headers(options.headers || {})
      headers.set("X-Kanna-Token", token)
      if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
      const response = await fetch(path, { ...options, headers, cache: "no-store" })
      const contentType = response.headers.get("content-type") || ""
      const payload = contentType.includes("application/json") ? await response.json() : null
      if (!response.ok) {
        const code = payload && typeof payload.error === "string" ? payload.error : ""
        throw new Error(errorMessages[code] || "操作失败。请检查网络后重试。")
      }
      return payload
    }
    function showError(message) { ui.error = message; ui.notice = ""; render() }
    function showNotice(message) { ui.notice = message; ui.error = ""; render() }
    async function loadStatus() {
      if (!token) { showError("本地授权链接已失效。请重新启动同步助手后打开新窗口。"); return }
      try {
        ui.status = await request("/api/status")
        if (!ui.selectedDirectory && ui.status.localDirectory) ui.selectedDirectory = ui.status.localDirectory
        ui.error = ui.status.error ? (errorMessages[ui.status.error] || String(ui.status.error)) : ""
        render()
      } catch (error) {
        showError(error instanceof Error ? error.message : "暂时无法读取助手状态。")
      }
    }
    async function browse(pathname = "") {
      ui.busy = true; ui.error = ""; render()
      try {
        const suffix = pathname ? \`?path=\${encodeURIComponent(pathname)}\` : ""
        const result = await request(\`/api/browse\${suffix}\`)
        ui.currentPath = result.currentPath
        ui.parentPath = result.parentPath
        ui.entries = Array.isArray(result.entries) ? result.entries : []
        byId("browse-path").value = ui.currentPath
        render()
      } catch (error) {
        showError(error instanceof Error ? error.message : "无法读取此文件夹。")
      } finally { ui.busy = false; render() }
    }
    function dependencyMarkup(dependencies) {
      if (!dependencies) return ""
      const entries = [["ssh", "SSH"], ["sshKeygen", "设备密钥工具"], ["mutagen", "同步组件"]]
      return entries.map(([key, label]) => \`<div class="dependency \${dependencies[key] ? "ok" : "missing"}">\${dependencies[key] ? "✓" : "·"} \${label}：\${dependencies[key] ? "已就绪" : "准备中"}</div>\`).join("")
    }
    function render() {
      const status = ui.status || {}
      const phase = labels[status.phase] || "正在读取"
      const pill = byId("phase-pill")
      pill.className = \`pill \${status.phase === "active" ? "good" : status.phase === "paused" || status.phase === "starting" ? "warn" : status.phase === "error" ? "error" : ""}\`
      byId("phase-label").textContent = phase
      const notice = byId("notice")
      notice.textContent = ui.notice
      notice.classList.toggle("hidden", !ui.notice)
      const error = byId("error")
      error.textContent = ui.error
      error.classList.toggle("hidden", !ui.error)
      const starting = status.phase === "starting"
      const sync = status.sync || {}
      byId("progress-area").classList.toggle("hidden", !starting)
      byId("step-label").textContent = status.step || "正在准备本机同步环境…"
      const active = status.phase === "active" || status.phase === "paused" || sync.state === "conflicts"
      byId("ready-view").classList.toggle("hidden", active || starting)
      byId("active-view").classList.toggle("hidden", !active)
      byId("error-view").classList.toggle("hidden", status.phase !== "error")
      const localDirectory = status.localDirectory || ui.selectedDirectory
      byId("selected-path").textContent = localDirectory ? \`已选择：\${localDirectory}\` : "请先选择本机项目目录。"
      byId("selected-path").classList.toggle("hidden", !localDirectory)
      byId("connect").disabled = ui.busy || !localDirectory
      byId("local-directory").textContent = status.localDirectory || "尚未选择"
      byId("remote-path").textContent = status.remotePath || "连接后显示"
      const syncLabels = { connected: "已连接", scanning: "正在检查文件", syncing: "正在同步", paused: "已暂停", conflicts: "发现冲突", error: "同步错误", stopped: "已停止", unknown: "状态未知" }
      const summary = byId("sync-summary")
      summary.textContent = sync.summary || \`同步状态：\${syncLabels[sync.state] || syncLabels.unknown}\`
      if (sync.conflictCount > 0) summary.textContent += \`（\${sync.conflictCount} 个冲突）\`
      const conflictList = byId("conflict-list")
      const conflicts = Array.isArray(sync.conflicts) ? sync.conflicts : []
      conflictList.innerHTML = conflicts.length ? \`<div style="font-size:13px;font-weight:650">冲突文件</div>\${conflicts.map((item) => \`<div class="detail"><strong>\${escapeHtml(item.path)}</strong><p class="subtle" style="margin-top:5px">两端副本：\${escapeHtml(item.alpha)} · \${escapeHtml(item.beta)}</p></div>\`).join("")}\` : ""
      conflictList.classList.toggle("hidden", !conflicts.length)
      const dependencyContent = dependencyMarkup(status.dependencies)
      byId("dependencies").innerHTML = dependencyContent
      byId("error-dependencies").innerHTML = dependencyContent
      const paused = sync.state === "paused" || status.phase === "paused"
      byId("pause").classList.toggle("hidden", !active || paused)
      byId("resume").classList.toggle("hidden", !active || !paused)
      byId("origin-label").textContent = \`连接目标：\${serverOrigin}\`
      const entries = byId("entries")
      entries.innerHTML = \`\${ui.parentPath ? \`<button class="entry" type="button" data-path="\${escapeHtml(ui.parentPath)}"><span>↰　上一级</span><span aria-hidden="true">›</span></button>\` : ""}\${ui.entries.length ? ui.entries.map((entry) => \`<button class="entry" type="button" role="option" data-path="\${escapeHtml(entry.path)}"><span>📁　\${escapeHtml(entry.name)}</span><span aria-hidden="true">›</span></button>\`).join("") : \`<div class="empty">此文件夹中没有子文件夹</div>\`}\`
      entries.querySelectorAll("[data-path]").forEach((button) => button.addEventListener("click", () => { void browse(button.getAttribute("data-path") || "") }))
      const submitButton = byId("connect")
      submitButton.textContent = ui.busy ? "正在连接…" : "连接并开始同步"
      submitButton.disabled = ui.busy || !localDirectory
      byId("select-directory").disabled = ui.busy
    }
    async function selectDirectory() {
      ui.busy = true; render()
      try {
        const result = await request("/api/select-directory", { method: "POST", body: JSON.stringify({ path: ui.currentPath }) })
        ui.selectedDirectory = result.localDirectory
        showNotice("已选择此文件夹。现在输入 Kanna 登录信息并连接。")
      } catch (error) { showError(error instanceof Error ? error.message : "无法选择此文件夹。") }
      finally { ui.busy = false; render() }
    }
    async function connect(event) {
      event.preventDefault()
      const username = byId("username").value.trim()
      const password = byId("password").value
      const localDirectory = ui.selectedDirectory || (ui.status && ui.status.localDirectory)
      if (!localDirectory) { showError("请先选择本机项目文件夹。"); return }
      ui.busy = true; ui.error = ""; render()
      try {
        await request("/api/start", { method: "POST", body: JSON.stringify({ username, password, localDirectory }) })
        byId("password").value = ""
        showNotice("登录信息已提交，正在安全地设置同步环境。")
        await loadStatus()
      } catch (error) { byId("password").value = ""; showError(error instanceof Error ? error.message : "连接失败，请检查登录信息后重试。") }
      finally { ui.busy = false; render() }
    }
    async function action(name) {
      ui.busy = true; ui.error = ""; render()
      try {
        await request(\`/api/\${name}\`, { method: "POST" })
        if (name === "open-kanna") showNotice("已请求打开 Kanna。若浏览器没有切换，请在浏览器中打开登录页面。")
        else showNotice(name === "pause" ? "已请求暂停同步。" : name === "resume" ? "已请求继续同步。" : "正在重新连接…")
        await loadStatus()
      } catch (error) { showError(error instanceof Error ? error.message : "操作失败，请重试。") }
      finally { ui.busy = false; render() }
    }
    byId("go-path").addEventListener("click", () => { void browse(byId("browse-path").value.trim()) })
    byId("browse-path").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void browse(byId("browse-path").value.trim()) } })
    byId("select-directory").addEventListener("click", () => { void selectDirectory() })
    byId("connect-form").addEventListener("submit", (event) => { void connect(event) })
    document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => { void action(button.getAttribute("data-action")) }))
    byId("open-kanna-link")?.addEventListener("click", (event) => { event.preventDefault(); void action("open-kanna") })
    render()
    void loadStatus().then(() => browse(ui.status && ui.status.localDirectory ? ui.status.localDirectory : ""))
    window.setInterval(() => { void loadStatus() }, 3000)
  })()
  </script>
</body>
</html>`
}

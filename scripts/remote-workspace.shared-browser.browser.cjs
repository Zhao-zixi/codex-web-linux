const { chromium } = require("playwright")
const https = require("node:https")
const { randomBytes } = require("node:crypto")
const fs = require("node:fs")

function assert(condition, label) {
  if (!condition) throw new Error(label)
}

function strictHttpsStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), {
      method: "GET",
      ca: fs.readFileSync("/test/root.crt"),
      rejectUnauthorized: true,
      agent: false,
      headers,
    }, (response) => {
      response.resume()
      response.once("end", () => resolve({ status: response.statusCode ?? 0, setCookie: Boolean(response.headers["set-cookie"]) }))
    })
    request.setTimeout(5_000, () => request.destroy(new Error("request timeout")))
    request.once("error", (error) => reject(new Error(`strict HTTPS request failed (${error.code ?? error.name})`)))
    request.end()
  })
}

function strictHttpsWebSocketStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(url), {
      method: "GET",
      ca: fs.readFileSync("/test/root.crt"),
      rejectUnauthorized: true,
      agent: false,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        ...headers,
      },
    }, (response) => {
      response.resume()
      response.once("end", () => resolve({ status: response.statusCode ?? 0, upgraded: false }))
    })
    request.setTimeout(5_000, () => request.destroy(new Error("request timeout")))
    request.once("upgrade", (response, socket) => {
      socket.destroy()
      resolve({ status: response.statusCode ?? 0, upgraded: true })
    })
    request.once("error", (error) => reject(new Error(`strict HTTPS WebSocket request failed (${error.code ?? error.name})`)))
    request.end()
  })
}

async function waitForPageSession(page, label) {
  await page.waitForFunction(() => Boolean(sessionStorage.getItem("kanna.auth.token")), null, { timeout: 15_000 }).catch(() => {
    throw new Error(`${label}: bearer session was not stored`)
  })
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 }).catch(() => {
    throw new Error(`${label}: service worker did not control the page`)
  })
}

async function login(page, password, label) {
  await page.locator("#kanna-password").waitFor({ timeout: 15_000 }).catch(() => {
    throw new Error(`${label}: password screen did not load`)
  })
  let loginSetCookie = false
  page.on("response", (response) => {
    if (response.url().endsWith("/auth/login") && response.headers()["set-cookie"]) loginSetCookie = true
  })
  await page.locator("#kanna-password").fill(password)
  await page.getByRole("button", { name: "Unlock" }).click()
  await waitForPageSession(page, label)
  assert(!loginSetCookie, `${label}: login set a cookie`)
}

async function fetchWorkspaceMetadata(page, label) {
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/hosted-workspace", { credentials: "omit" })
    return { status: result.status, setCookie: result.headers.has("set-cookie") }
  })
  assert(response.status === 200, `${label}: worker-backed API request failed`)
  assert(!response.setCookie, `${label}: API response exposed Set-Cookie`)
}

async function openWorkspaceSocket(page, projectPath = null) {
  return page.evaluate(async (localPath) => {
    const token = sessionStorage.getItem("kanna.auth.token")
    const ticketResponse = await fetch("/auth/ws-ticket", {
      method: "POST",
      credentials: "omit",
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!ticketResponse.ok) throw new Error("WS ticket request failed")
    const { ticket } = await ticketResponse.json()
    const socket = new WebSocket(`wss://${location.host}/ws`, ["kanna.ws.v1", `kanna.ticket.${ticket}`])
    window.__kannaBrowserE2eSocket = socket
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket did not open")), 10_000)
      socket.addEventListener("open", () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      socket.addEventListener("error", () => {
        clearTimeout(timer)
        reject(new Error("WebSocket upgrade failed"))
      }, { once: true })
    })
    if (socket.protocol !== "kanna.ws.v1") throw new Error("WS ticket protocol was echoed")
    if (!localPath) return { projectId: null, protocol: socket.protocol }
    const projectId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("project.create was not acknowledged")), 15_000)
      socket.addEventListener("message", (event) => {
        let message
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message.type !== "ack" || message.id !== "shared-browser-project-create") return
        clearTimeout(timer)
        if (!message.result?.projectId) reject(new Error("project.create omitted project id"))
        else resolve(message.result.projectId)
      })
      socket.send(JSON.stringify({
        v: 1,
        type: "command",
        id: "shared-browser-project-create",
        command: { type: "project.create", localPath, title: "Shared browser fixture" },
      }))
    })
    return { projectId, protocol: socket.protocol }
  }, projectPath)
}

async function main() {
  let input = ""
  for await (const chunk of process.stdin) input += chunk
  const passwords = input.trimEnd().split("\n")
  assert(passwords.length === 2 && passwords.every((password) => password.length >= 20), "two fixture passwords were not supplied")
  const [originA, originB, projectPath] = process.argv.slice(2)
  assert(originA && originB && projectPath, "browser fixture arguments are missing")
  const browser = await chromium.launch({ headless: true })
  let pageErrors = 0
  let consoleErrors = 0
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const pageA = await context.newPage()
    pageA.on("pageerror", () => { pageErrors += 1 })
    pageA.on("console", (message) => { if (message.type() === "error") consoleErrors += 1 })
    const responseA = await pageA.goto(`${originA}/`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    assert(responseA?.status() === 200, "account A app page did not load over trusted TLS")
    await login(pageA, passwords[0], "account A")
    const securityA = await pageA.evaluate(() => ({
      secure: isSecureContext,
      origin: location.origin,
      controlled: Boolean(navigator.serviceWorker.controller),
      bearerStored: Boolean(sessionStorage.getItem("kanna.auth.token")),
    }))
    assert(securityA.secure && securityA.controlled && securityA.bearerStored, "account A secure worker session is incomplete")
    await fetchWorkspaceMetadata(pageA, "account A")
    const spoofedRequestIgnored = await pageA.evaluate(async () => {
      const channel = new MessageChannel()
      let replied = false
      channel.port1.onmessage = () => { replied = true }
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
        data: { type: "kanna.auth.request", requestId: crypto.randomUUID() },
        source: window,
        ports: [channel.port2],
      }))
      await new Promise((resolve) => setTimeout(resolve, 50))
      channel.port1.close()
      return !replied
    })
    assert(spoofedRequestIgnored, "page-auth bridge answered a message from a non-worker source")

    const pageB = await context.newPage()
    pageB.on("pageerror", () => { pageErrors += 1 })
    pageB.on("console", (message) => { if (message.type() === "error") consoleErrors += 1 })
    const responseB = await pageB.goto(`${originB}/`, { waitUntil: "domcontentloaded", timeout: 30_000 })
    assert(responseB?.status() === 200, "account B app page did not load over trusted TLS")
    const isolatedBeforeLogin = await pageB.evaluate(() => !sessionStorage.getItem("kanna.auth.token"))
    assert(isolatedBeforeLogin, "account B inherited a session from account A")
    const unauthenticatedB = await pageB.evaluate(async () => (await fetch("/api/hosted-workspace", { credentials: "omit" })).status)
    assert(unauthenticatedB === 401, "account B accepted an account A session before its own login")
    await login(pageB, passwords[1], "account B")
    const securityB = await pageB.evaluate(() => ({
      secure: isSecureContext,
      origin: location.origin,
      controlled: Boolean(navigator.serviceWorker.controller),
      bearerStored: Boolean(sessionStorage.getItem("kanna.auth.token")),
    }))
    assert(securityB.secure && securityB.controlled && securityB.bearerStored, "account B secure worker session is incomplete")
    assert(securityA.origin !== securityB.origin, "the two accounts did not receive distinct origins")
    await fetchWorkspaceMetadata(pageB, "account B")

    const tokenA = await pageA.evaluate(() => sessionStorage.getItem("kanna.auth.token"))
    const tokenB = await pageB.evaluate(() => sessionStorage.getItem("kanna.auth.token"))
    assert(tokenA && tokenB, "both accounts must hold their own bearer session")
    const crossPortBearer = await strictHttpsStatus(`${securityB.origin}/api/hosted-workspace`, {
      Origin: securityB.origin,
      Authorization: `Bearer ${tokenA}`,
    })
    const ownPortBearer = await strictHttpsStatus(`${securityB.origin}/api/hosted-workspace`, {
      Origin: securityB.origin,
      Authorization: `Bearer ${tokenB}`,
    })
    assert(crossPortBearer.status === 401, "account B accepted account A's bearer on B's exact origin")
    assert(ownPortBearer.status === 200, "account B's own bearer was not accepted on B's exact origin")

    const ticketAResult = await pageA.evaluate(async () => {
      const token = sessionStorage.getItem("kanna.auth.token")
      const response = await fetch("/auth/ws-ticket", {
        method: "POST",
        credentials: "omit",
        headers: { Authorization: `Bearer ${token}` },
      })
      const payload = await response.json()
      return { status: response.status, ticket: payload.ticket }
    })
    assert(ticketAResult.status === 200 && typeof ticketAResult.ticket === "string", "account A did not issue a test WebSocket ticket")
    const crossPortTicket = await strictHttpsWebSocketStatus(`${securityB.origin}/ws`, {
      Host: new URL(securityB.origin).host,
      Origin: securityB.origin,
      "Sec-WebSocket-Protocol": `kanna.ws.v1, kanna.ticket.${ticketAResult.ticket}`,
    })
    assert(crossPortTicket.status === 401 && !crossPortTicket.upgraded, "account B accepted account A's WebSocket ticket")

    await pageB.close()
    const noClientB = await context.newPage()
    const noClientBResponse = await noClientB.goto(`${securityB.origin}/api/hosted-workspace`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    })
    assert(noClientBResponse?.status() === 401, "account B protected navigation succeeded with no B app client while A remained open")
    await noClientB.close()

    const project = await openWorkspaceSocket(pageA, projectPath)
    await pageA.screenshot({ path: "/test/output/final-shared-workspace.png", fullPage: true })
    const fileBase = `${originA}/api/projects/${encodeURIComponent(project.projectId)}/files`
    const range = await pageA.evaluate(async (url) => {
      const response = await fetch(`${url}/large.bin/content`, {
        credentials: "omit",
        headers: { Range: "bytes=0-1023" },
      })
      const reader = response.body?.getReader()
      if (!reader) return { status: response.status, contentRange: response.headers.get("content-range"), chunkSize: 0 }
      const { value } = await reader.read()
      await reader.cancel()
      return {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        chunkSize: value?.byteLength ?? 0,
      }
    }, fileBase)
    assert(range.status === 206 && range.contentRange?.startsWith("bytes 0-1023/") && range.chunkSize > 0, "large file Range response was not streamed as 206")

    const pngUrl = `${fileBase}/pixel.png/content`
    const imageLoaded = await pageA.evaluate((url) => new Promise((resolve) => {
      const image = new Image()
      const timeout = setTimeout(() => resolve(false), 10_000)
      image.onload = () => { clearTimeout(timeout); resolve(image.naturalWidth === 1 && image.naturalHeight === 1) }
      image.onerror = () => { clearTimeout(timeout); resolve(false) }
      image.src = url
      document.body.append(image)
    }), pngUrl)
    assert(imageLoaded, "native image request did not load through the worker")

    const videoResult = await pageA.evaluate((url) => new Promise((resolve) => {
      const video = document.createElement("video")
      video.preload = "metadata"
      const timeout = setTimeout(() => resolve(false), 10_000)
      video.onloadedmetadata = () => { clearTimeout(timeout); resolve(video.videoWidth === 32 && video.videoHeight === 32) }
      video.onerror = () => { clearTimeout(timeout); resolve(false) }
      video.src = url
      document.body.append(video)
    }), `${fileBase}/sample.webm/content`)
    assert(videoResult, "native video request did not load through the worker")

    const iframeEvidence = { responses: [], failures: [] }
    pageA.on("response", (response) => {
      if (!response.url().includes("/files/fixture.html/content")) return
      const headers = response.headers()
      iframeEvidence.responses.push({
        status: response.status(),
        contentType: headers["content-type"] ?? null,
        framePolicy: headers["x-frame-options"] ?? null,
        csp: headers["content-security-policy"] ?? null,
        attachment: headers["content-disposition"]?.toLowerCase().startsWith("attachment") ?? false,
      })
    })
    pageA.on("requestfailed", (request) => {
      if (request.url().includes("/files/fixture.html/content")) {
        iframeEvidence.failures.push(request.failure()?.errorText?.slice(0, 120) ?? "unknown")
      }
    })
    const iframeResult = await pageA.evaluate((url) => new Promise((resolve) => {
      const frame = document.createElement("iframe")
      const timeout = setTimeout(() => resolve(false), 10_000)
      frame.onload = () => {
        clearTimeout(timeout)
        const document = frame.contentDocument
        resolve({
          ok: document?.contentType === "text/plain" && document.body?.innerText.includes("Kanna shared browser fixture") && typeof frame.contentWindow?.kannaFixtureExecuted === "undefined",
          textPlain: document?.contentType === "text/plain",
          fixtureTextVisible: document?.body?.innerText.includes("Kanna shared browser fixture") ?? false,
          fixtureScriptBlocked: typeof frame.contentWindow?.kannaFixtureExecuted === "undefined",
          readyState: frame.contentDocument?.readyState ?? "unavailable",
          urlPath: new URL(frame.src).pathname,
        })
      }
      frame.onerror = () => { clearTimeout(timeout); resolve({ ok: false, frameError: true, urlPath: new URL(frame.src).pathname }) }
      frame.src = url
      document.body.append(frame)
    }), `${fileBase}/fixture.html/content`)
    assert(iframeResult?.ok === true && iframeEvidence.responses.some((response) => response.status === 200 && response.contentType?.startsWith("text/plain") && !response.attachment), `native iframe request did not load as inert text through the worker (${JSON.stringify({ iframeResult, iframeEvidence })})`)

    const completeFileFetch = await pageA.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "omit" })
      const reader = response.body?.getReader()
      if (!reader) return { status: response.status, bytes: 0 }
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
      }
      return { status: response.status, bytes }
    }, `${fileBase}/large.bin/content`)
    const downloadEvidence = { response: null, failed: null, cdpRequests: [], cdpResponses: [], cdpFailures: [] }
    const downloadCdp = await context.newCDPSession(pageA)
    await downloadCdp.send("Network.enable")
    downloadCdp.on("Network.requestWillBeSent", (event) => {
      if (new URL(event.request.url).pathname.endsWith("/files/large.bin/content")) {
        downloadEvidence.cdpRequests.push({ resourceType: event.type, initiatorType: event.initiator.type })
      }
    })
    downloadCdp.on("Network.responseReceived", (event) => {
      if (new URL(event.response.url).pathname.endsWith("/files/large.bin/content")) {
        const headers = event.response.headers
        downloadEvidence.cdpResponses.push({
          status: event.response.status,
          mimeType: event.response.mimeType,
          fromServiceWorker: event.response.fromServiceWorker,
          contentType: headers["content-type"] ?? headers["Content-Type"] ?? null,
          contentLength: headers["content-length"] ?? headers["Content-Length"] ?? null,
          disposition: headers["content-disposition"] ?? headers["Content-Disposition"] ?? null,
        })
      }
    })
    downloadCdp.on("Network.loadingFailed", (event) => {
      if (event.type === "Document" || event.type === "Fetch" || event.type === "Other") {
        downloadEvidence.cdpFailures.push({ type: event.type, errorText: event.errorText.slice(0, 120), canceled: event.canceled ?? false, blockedReason: event.blockedReason ?? null })
      }
    })
    context.on("response", (response) => {
      if (!response.url().includes("/files/large.bin/content")) return
      const headers = response.headers()
      downloadEvidence.response = {
        status: response.status(),
        contentType: headers["content-type"] ?? null,
        contentLength: headers["content-length"] ?? null,
        disposition: headers["content-disposition"] ?? null,
        urlOrigin: new URL(response.url()).origin,
      }
    })
    context.on("requestfailed", (request) => {
      if (request.url().includes("/files/large.bin/content")) downloadEvidence.failed = request.failure()?.errorText?.slice(0, 120) ?? "unknown"
    })
    await pageA.evaluate((url) => {
      const button = document.createElement("button")
      button.id = "kanna-e2e-download"
      button.type = "button"
      button.textContent = "download fixture"
      button.style.cssText = "position:fixed;top:8px;left:150px;z-index:2147483647;background:#fff;color:#000;padding:8px;border:1px solid #000"
      button.addEventListener("click", () => window.open(url, "_blank", "noopener,noreferrer"))
      document.body.append(button)
    }, `${fileBase}/large.bin/content`)
    let resolveDownload
    const downloadPromise = new Promise((resolve) => { resolveDownload = resolve })
    const watchDownload = (page) => page.on("download", (download) => resolveDownload(download))
    watchDownload(pageA)
    context.on("page", watchDownload)
    await pageA.locator("#kanna-e2e-download").click()
    const downloadResult = await Promise.race([downloadPromise, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))])
    context.off("page", watchDownload)
    assert(downloadResult, `native download event did not fire (${JSON.stringify(downloadEvidence)})`)
    const downloadFilename = downloadResult.suggestedFilename()
    const downloadSavePath = "/tmp/kanna-shared-browser-download.bin"
    let downloadSaveError = null
    try { await downloadResult.saveAs(downloadSavePath) } catch (error) { downloadSaveError = String(error?.message ?? error).slice(0, 160) }
    const downloadFailure = await downloadResult.failure()
    const downloadedData = downloadSaveError ? null : await require("node:fs/promises").readFile(downloadSavePath)
    const downloadedBytes = downloadedData?.byteLength ?? 0
    const crypto = require("node:crypto")
    const downloadedSha256 = downloadedData ? crypto.createHash("sha256").update(downloadedData).digest("hex") : null
    const expectedSha256 = crypto.createHash("sha256").update(Buffer.alloc(4 * 1024 * 1024, 0x4b)).digest("hex")
    const nativeDownload = downloadFilename === "large.bin" && downloadFailure === null && downloadedBytes === 4 * 1024 * 1024 && downloadedSha256 === expectedSha256

    const workerRestartEvidence = { registrationPreserved: false, versionId: null, stopped: false, rangeStatus: 0, rangeBytes: 0, woken: false }
    const serviceWorkerCdp = await context.newCDPSession(pageA)
    const serviceWorkerVersions = new Map()
    const rememberServiceWorkerVersions = (registrations) => {
      for (const registration of registrations ?? []) {
        if (registration.scopeURL !== `${originA}/`) continue
        for (const version of registration.versions ?? []) serviceWorkerVersions.set(version.versionId, version)
      }
    }
    serviceWorkerCdp.on("ServiceWorker.workerRegistrationUpdated", (event) => rememberServiceWorkerVersions(event.registrations))
    serviceWorkerCdp.on("ServiceWorker.workerVersionUpdated", (event) => {
      for (const version of event.versions ?? []) serviceWorkerVersions.set(version.versionId, version)
    })
    await serviceWorkerCdp.send("ServiceWorker.enable")
    const registrationBeforeStop = await pageA.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      return {
        scope: registration?.scope ?? null,
        scriptUrl: registration?.active?.scriptURL ?? null,
        state: registration?.active?.state ?? null,
        controllerUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
      }
    })
    assert(registrationBeforeStop.scope === `${originA}/` && registrationBeforeStop.scriptUrl === `${originA}/kanna-auth-sw.js`
      && registrationBeforeStop.state === "activated" && registrationBeforeStop.controllerUrl === registrationBeforeStop.scriptUrl,
    `CDP worker stop setup did not find the active controlled registration (${JSON.stringify(registrationBeforeStop)})`)
    const registrationDeadline = Date.now() + 3_000
    while (!serviceWorkerVersions.size && Date.now() < registrationDeadline) await new Promise((resolve) => setTimeout(resolve, 50))
    const activeServiceWorker = [...serviceWorkerVersions.values()].find((version) => version.scriptURL === registrationBeforeStop.scriptUrl && version.status === "activated")
    assert(activeServiceWorker?.versionId, `CDP did not report the active worker version (${JSON.stringify([...serviceWorkerVersions.values()])})`)
    workerRestartEvidence.versionId = activeServiceWorker.versionId
    workerRestartEvidence.registrationPreserved = true
    await serviceWorkerCdp.send("ServiceWorker.stopWorker", { versionId: activeServiceWorker.versionId })
    const stoppedDeadline = Date.now() + 5_000
    while (Date.now() < stoppedDeadline) {
      const version = serviceWorkerVersions.get(activeServiceWorker.versionId)
      if (version?.runningStatus === "stopped") { workerRestartEvidence.stopped = true; break }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert(workerRestartEvidence.stopped, `CDP worker did not report stopped (${JSON.stringify(serviceWorkerVersions.get(activeServiceWorker.versionId))})`)
    const stoppedWorkerRange = await pageA.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "omit", headers: { Range: "bytes=0-1023" } })
      const body = await response.arrayBuffer()
      return {
        status: response.status,
        contentRange: response.headers.get("content-range"),
        bytes: body.byteLength,
        registration: await navigator.serviceWorker.getRegistration().then((registration) => ({
          scope: registration?.scope ?? null,
          scriptUrl: registration?.active?.scriptURL ?? null,
          state: registration?.active?.state ?? null,
        })),
      }
    }, `${fileBase}/large.bin/content`)
    workerRestartEvidence.rangeStatus = stoppedWorkerRange.status
    workerRestartEvidence.rangeBytes = stoppedWorkerRange.bytes
    const wakeDeadline = Date.now() + 3_000
    while (Date.now() < wakeDeadline) {
      const version = serviceWorkerVersions.get(activeServiceWorker.versionId)
      if (version?.runningStatus === "running") { workerRestartEvidence.woken = true; break }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert(stoppedWorkerRange.status === 206 && stoppedWorkerRange.contentRange === "bytes 0-1023/4194304" && stoppedWorkerRange.bytes === 1024
      && stoppedWorkerRange.registration.scope === `${originA}/`
      && stoppedWorkerRange.registration.scriptUrl === registrationBeforeStop.scriptUrl
      && stoppedWorkerRange.registration.state === "activated"
      && workerRestartEvidence.woken,
    `stopped worker did not wake for protected range request (${JSON.stringify({ workerRestartEvidence, stoppedWorkerRange })})`)
    await serviceWorkerCdp.detach()

    const popup = await pageA.evaluate((url) => {
      const link = document.createElement("a")
      link.href = url
      link.target = "_blank"
      link.id = "kanna-e2e-open-new-tab"
      link.textContent = "open fixture"
      link.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647;background:#fff;color:#000;padding:8px;border:1px solid #000"
      document.body.append(link)
      window.__kannaE2eNewTabClick = null
      document.addEventListener("click", (event) => {
        if (event.target !== link) return
        window.__kannaE2eNewTabClick = {
          isTrusted: event.isTrusted,
          defaultPrevented: event.defaultPrevented,
          connected: link.isConnected,
          target: link.target,
          rel: link.rel,
          urlPath: new URL(link.href).pathname,
        }
      }, { capture: true, once: true })
      return true
    }, `${fileBase}/fixture.html/content`)
    assert(popup, "new tab link was not created")
    const newTabEvidence = { pagesBefore: context.pages().length, popup: false, pageEvent: false, download: false, response: null, failed: null, console: [] }
    newTabEvidence.dom = await pageA.evaluate(() => {
      const link = document.querySelector("#kanna-e2e-open-new-tab")
      if (!link) return { exists: false }
      const rect = link.getBoundingClientRect()
      const style = getComputedStyle(link)
      const top = document.elementFromPoint(Math.max(0, rect.left + rect.width / 2), Math.max(0, rect.top + rect.height / 2))
      return {
        exists: true,
        connected: link.isConnected,
        target: link.target,
        rel: link.rel,
        urlPath: new URL(link.href).pathname,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        viewport: { width: innerWidth, height: innerHeight, scrollY },
        display: style.display,
        visibility: style.visibility,
        pointerEvents: style.pointerEvents,
        topElement: top ? { tag: top.tagName, className: typeof top.className === "string" ? top.className.slice(0, 100) : "" } : null,
      }
    })
    let observedPage = null
    context.on("page", (page) => {
      newTabEvidence.pageEvent = true
      observedPage = page
      page.on("download", () => { newTabEvidence.download = true })
      page.on("response", (response) => {
        if (response.url().includes("/files/fixture.html/content")) {
          const headers = response.headers()
          newTabEvidence.response = {
            status: response.status(),
            contentType: headers["content-type"] ?? null,
            disposition: headers["content-disposition"] ?? null,
            urlOrigin: new URL(response.url()).origin,
          }
        }
      })
      page.on("requestfailed", (request) => {
        if (request.url().includes("/files/fixture.html/content")) newTabEvidence.failed = request.failure()?.errorText?.slice(0, 120) ?? "unknown"
      })
    })
    pageA.on("popup", (page) => { newTabEvidence.popup = true; observedPage = page })
    pageA.on("download", () => { newTabEvidence.download = true })
    pageA.on("response", (response) => {
      if (response.url().includes("/files/fixture.html/content")) {
        const headers = response.headers()
        newTabEvidence.response = {
          status: response.status(),
          contentType: headers["content-type"] ?? null,
          disposition: headers["content-disposition"] ?? null,
          urlOrigin: new URL(response.url()).origin,
        }
      }
    })
    pageA.on("requestfailed", (request) => {
      if (request.url().includes("/files/fixture.html/content")) newTabEvidence.failed = request.failure()?.errorText?.slice(0, 120) ?? "unknown"
    })
    pageA.on("console", (message) => {
      if (message.type() === "error" && /popup|window.open|blocked/i.test(message.text())) newTabEvidence.console.push(message.text().slice(0, 120))
    })
    let newTab = null
    try {
      await pageA.locator("#kanna-e2e-open-new-tab").click()
    } catch (error) {
      newTabEvidence.clickError = String(error?.message ?? error).slice(0, 1800)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    newTab = observedPage
    if (!newTab && !newTabEvidence.pageEvent) {
      try { newTab = await context.waitForEvent("page", { timeout: 3_000 }) } catch {}
    }
    newTabEvidence.pagesAfter = context.pages().length
    newTabEvidence.trigger = await pageA.evaluate(() => window.__kannaE2eNewTabClick)
    if (!newTab) throw new Error(`new-tab trigger produced no popup (${JSON.stringify(newTabEvidence)})`)
    newTabEvidence.pagesAfter = context.pages().length
    await newTab.waitForLoadState("domcontentloaded", { timeout: 10_000 })
    const newTabText = await newTab.evaluate(() => ({
      contentType: document.contentType,
      fixtureVisible: document.body.innerText.includes("Kanna shared browser fixture"),
    }))
    assert(newTabText.contentType === "text/plain" && newTabText.fixtureVisible, "new tab did not receive the inert file content from an existing app client")

    const unregisterResult = await pageA.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      if (!registration || !(await registration.unregister())) throw new Error("worker restart setup failed")
      return {
        unregistered: true,
        tokenStored: Boolean(sessionStorage.getItem("kanna.auth.token")),
        hadController: Boolean(navigator.serviceWorker.controller),
        registrationActive: Boolean(registration.active),
      }
    })
    await pageA.reload({ waitUntil: "domcontentloaded" })
    const workerRestartState = await pageA.evaluate(async () => {
      const token = sessionStorage.getItem("kanna.auth.token")
      const expiresAt = Number(sessionStorage.getItem("kanna.auth.expiresAt"))
      const anonymousResponse = await fetch("/auth/status", { credentials: "omit", cache: "no-store" })
      const anonymous = await anonymousResponse.json()
      const bearerResponse = token ? await fetch("/auth/status", { credentials: "omit", cache: "no-store", headers: { Authorization: `Bearer ${token}` } }) : null
      const bearer = bearerResponse ? await bearerResponse.json() : null
      const registrations = await navigator.serviceWorker.getRegistrations()
      return {
        tokenStored: Boolean(token),
        expiryValid: Number.isFinite(expiresAt) && expiresAt > Date.now(),
        anonymous: { authMode: anonymous.authMode ?? null, authenticated: anonymous.authenticated ?? null },
        bearer: bearer ? { status: bearerResponse.status, authMode: bearer.authMode ?? null, authenticated: bearer.authenticated ?? null } : null,
        registrations: registrations.map((registration) => ({
          scopePath: new URL(registration.scope).pathname,
          active: registration.active?.state ?? null,
          installing: registration.installing?.state ?? null,
          waiting: registration.waiting?.state ?? null,
        })),
        controllerPath: navigator.serviceWorker.controller ? new URL(navigator.serviceWorker.controller.scriptURL).pathname : null,
        passwordGateVisible: Boolean(document.querySelector("#kanna-password")),
      }
    })
    try {
      await waitForPageSession(pageA, "worker restart")
    } catch {
      throw new Error(`worker restart recovery failed (${JSON.stringify({ unregisterResult, workerRestartState })})`)
    }
    await fetchWorkspaceMetadata(pageA, "worker restart")
    const logoutSocket = await openWorkspaceSocket(pageA)
    assert(logoutSocket.protocol === "kanna.ws.v1", "logout socket negotiated an unexpected protocol")

    const logout = await pageA.evaluate(async () => {
      const token = sessionStorage.getItem("kanna.auth.token")
      const socket = window.__kannaBrowserE2eSocket
      const socketClose = new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }))
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "omit",
        headers: { Authorization: `Bearer ${token}` },
      })
      return {
        status: response.status,
        authenticated: (await (await fetch("/auth/status", { credentials: "omit" })).json()).authenticated,
        socketCloseCode: await Promise.race([socketClose, new Promise((resolve) => setTimeout(() => resolve(0), 3000))]),
      }
    })
    assert(logout.status === 200 && logout.authenticated === false && logout.socketCloseCode === 1008, "server logout did not revoke the bearer session and close its WebSocket")
    const staleApi = await pageA.evaluate(async () => (await fetch("/api/hosted-workspace", { credentials: "omit" })).status)
    assert(staleApi === 401, "worker continued to authorize requests after logout")
    const protectedMediaAfterLogout = await pageA.evaluate((url) => new Promise((resolve) => {
      const image = new Image()
      const timeout = setTimeout(() => resolve(false), 10_000)
      image.onerror = () => { clearTimeout(timeout); resolve(true) }
      image.onload = () => { clearTimeout(timeout); resolve(false) }
      image.src = url
    }), pngUrl)
    assert(protectedMediaAfterLogout, "protected native media remained accessible after logout")
    await newTab.close()
    await pageA.close()
    const noClientPage = await context.newPage()
    const noClientResponse = await noClientPage.goto(`${originA}/api/projects/${encodeURIComponent(project.projectId)}/files/fixture.html/content`, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    })
    assert(noClientResponse?.status() === 401, "a protected new-tab navigation succeeded after all app clients closed")
    assert(pageErrors === 0, "browser reported an uncaught page error")

    const report = {
      result: "pass",
      strictTls: true,
      secureOrigins: [securityA.origin, securityB.origin],
      distinctOriginSessions: true,
      noCookies: true,
      crossPortAuth: { accountABearerOnB: crossPortBearer.status, accountBBearerOnB: ownPortBearer.status, accountAWebSocketTicketOnB: crossPortTicket.status },
      noClientWithOtherAccountOpen: noClientBResponse?.status() ?? 0,
      workerControlledBothOrigins: true,
      apiViaWorker: true,
      spoofedWorkerRequestIgnored: spoofedRequestIgnored,
      rangeStatus: range.status,
      rangeContentRange: range.contentRange,
      rangeFirstChunkBytes: range.chunkSize,
      nativeImage: imageLoaded,
      nativeVideo: videoResult,
      nativeIframeText: iframeResult,
      nativeDownload: { succeeded: nativeDownload, filename: downloadFilename, urlPath: new URL(downloadResult.url()).pathname, failure: downloadFailure, saveError: downloadSaveError, downloadedBytes, downloadedSha256, completeFileFetch, ...downloadEvidence },
      newTabWithClient: true,
      newTabWithoutClients: 401,
      workerRestart: { unregisterReloadRecovery: true, cdpStopAndWake: workerRestartEvidence },
      logoutRevokedApi: true,
      logoutRevokedNativeMedia: protectedMediaAfterLogout,
      logoutClosedWebSocket: logout.socketCloseCode,
      browserPageErrors: pageErrors,
      browserConsoleErrors: consoleErrors,
    }
    process.stdout.write(JSON.stringify(report) + "\n")
    assert(nativeDownload, `native download failed (${JSON.stringify(report.nativeDownload)})`)
    await noClientPage.close()
    await context.close()
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  process.stderr.write(`shared browser E2E failed: ${String(error.message).slice(0, 900)}\n`)
  process.exit(1)
})

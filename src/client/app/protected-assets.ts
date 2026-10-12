import { useEffect, useState } from "react"
import { getClientAuthMode, kannaFetch, registerAuthResourceCleanup } from "./auth-client"

const activeRequests = new Set<AbortController>()
const activeObjectUrls = new Set<string>()

/** Plain-HTTP bearer pages cannot authorize browser-native API requests with a Service Worker. */
export function needsProtectedAssetFetch(url: string) {
  if (typeof window === "undefined" || window.isSecureContext || getClientAuthMode() !== "bearer") return false
  try {
    const parsed = new URL(url, window.location.href)
    return parsed.origin === window.location.origin && parsed.pathname.startsWith("/api/")
  } catch {
    return false
  }
}

function makeObjectUrl(blob: Blob) {
  const url = URL.createObjectURL(blob)
  activeObjectUrls.add(url)
  return url
}

function releaseObjectUrl(url: string | null) {
  if (!url) return
  if (activeObjectUrls.delete(url)) URL.revokeObjectURL(url)
}

export function clearProtectedAssets() {
  for (const controller of activeRequests) controller.abort()
  activeRequests.clear()
  for (const url of activeObjectUrls) URL.revokeObjectURL(url)
  activeObjectUrls.clear()
}

registerAuthResourceCleanup(clearProtectedAssets)

/** Fetches only safe inline media; callers must never use this URL for HTML or SVG documents. */
export function useProtectedMediaUrl(url: string, kind: "image" | "video" | "pdf") {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const fetchRequired = needsProtectedAssetFetch(url)

  useEffect(() => {
    if (!fetchRequired) {
      setObjectUrl(null)
      return
    }
    const controller = new AbortController()
    activeRequests.add(controller)
    let createdUrl: string | null = null
    setObjectUrl(null)
    void kannaFetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`Media request failed (${response.status})`)
      const blob = await response.blob()
      const contentType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() ?? ""
      const allowed = kind === "image"
        ? /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/.test(contentType)
        : kind === "video"
          ? contentType.startsWith("video/")
          : contentType === "application/pdf"
      if (!allowed || controller.signal.aborted) return
      createdUrl = makeObjectUrl(blob)
      setObjectUrl(createdUrl)
    }).catch(() => {}).finally(() => activeRequests.delete(controller))
    return () => {
      controller.abort()
      activeRequests.delete(controller)
      releaseObjectUrl(createdUrl)
    }
  }, [fetchRequired, kind, url])

  return fetchRequired ? objectUrl : url
}

/** Downloads protected resources without placing credentials in a URL or opening active content. */
export async function downloadProtectedAsset(url: string, filename: string) {
  if (!needsProtectedAssetFetch(url)) return false
  const controller = new AbortController()
  activeRequests.add(controller)
  try {
    const response = await kannaFetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Download failed (${response.status})`)
    const blob = new Blob([await response.blob()], { type: "application/octet-stream" })
    if (controller.signal.aborted) return true
    const objectUrl = makeObjectUrl(blob)
    const anchor = document.createElement("a")
    anchor.href = objectUrl
    anchor.download = filename
    anchor.rel = "noopener noreferrer"
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    // Safari may begin consuming the object URL after click returns.
    window.setTimeout(() => releaseObjectUrl(objectUrl), 60_000)
    return true
  } finally {
    activeRequests.delete(controller)
  }
}

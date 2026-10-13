import type { StateStorage } from "zustand/middleware"

let persistencePauseDepth = 0

export function isWorkspacePersistencePaused() {
  return persistencePauseDepth > 0
}

export async function withWorkspacePersistencePaused<T>(callback: () => Promise<T> | T): Promise<T> {
  persistencePauseDepth += 1
  try {
    return await callback()
  } finally {
    persistencePauseDepth -= 1
  }
}

export function gatewayWorkspaceStorageKey(baseKey: string, userId: string | null) {
  const scope = userId && /^[a-f0-9]{32}$/.test(userId) ? userId : "locked"
  return `${baseKey}.gateway.${scope}`
}

/** A localStorage adapter whose key can be rebound before persisted stores hydrate. */
export const workspaceLocalStorage: StateStorage = {
  getItem(name) {
    if (typeof window === "undefined") return null
    try {
      return window.localStorage.getItem(name)
    } catch {
      return null
    }
  },
  setItem(name, value) {
    if (isWorkspacePersistencePaused() || typeof window === "undefined") return
    try {
      window.localStorage.setItem(name, value)
    } catch {
      // Storage can be unavailable in private browsing or after quota is reached.
    }
  },
  removeItem(name) {
    if (typeof window === "undefined") return
    try {
      window.localStorage.removeItem(name)
    } catch {
      // Storage can be unavailable in private browsing.
    }
  },
}

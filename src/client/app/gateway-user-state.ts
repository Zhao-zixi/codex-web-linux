import { clearBearerSession } from "./auth-client"
import { CHAT_TABS_STORAGE_KEY, DIFF_REVIEW_STORAGE_KEY_PREFIX } from "../lib/storageKeys"
import {
  gatewayWorkspaceStorageKey,
  withWorkspacePersistencePaused,
} from "../lib/workspace-storage"
import {
  discardPendingChatInputPersistence,
  flushChatInputPersistence,
  useChatInputStore,
} from "../stores/chatInputStore"
import {
  readStoredChatTabs,
  removeStoredChatTabs,
  setChatTabsStorageKey,
  useChatTabsStore,
} from "../stores/chatTabsStore"
import { useDiffCommitStore } from "../stores/diffCommitStore"
import { useRightSidebarStore } from "../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"

const GATEWAY_TAB_USER_KEY = "kanna:gateway-tab-user-id"

let activeGatewayUserId: string | null = null
let storageBound = false
let transitionQueue: Promise<void> = Promise.resolve()

function runSerialized<T>(callback: () => Promise<T>): Promise<T> {
  const result = transitionQueue.then(callback, callback)
  transitionQueue = result.then(() => undefined, () => undefined)
  return result
}

function storageNames(userId: string | null) {
  return {
    chatInput: gatewayWorkspaceStorageKey("chat-input-drafts", userId),
    chatTabs: gatewayWorkspaceStorageKey(CHAT_TABS_STORAGE_KEY, userId),
    diffCommit: gatewayWorkspaceStorageKey("diff-commit-selections", userId),
    rightSidebar: gatewayWorkspaceStorageKey("right-sidebar-layouts", userId),
    terminalLayout: gatewayWorkspaceStorageKey("terminal-layouts", userId),
  }
}

function resetStoreMemory() {
  useChatInputStore.setState(useChatInputStore.getInitialState(), true)
  useChatTabsStore.setState({ tabs: [], recentChatIds: [] })
  useDiffCommitStore.setState(useDiffCommitStore.getInitialState(), true)
  useRightSidebarStore.setState(useRightSidebarStore.getInitialState(), true)
  useTerminalLayoutStore.setState(useTerminalLayoutStore.getInitialState(), true)
}

function bindStorageNames(userId: string | null) {
  const names = storageNames(userId)
  useChatInputStore.persist.setOptions({ name: names.chatInput })
  useDiffCommitStore.persist.setOptions({ name: names.diffCommit })
  useRightSidebarStore.persist.setOptions({ name: names.rightSidebar })
  useTerminalLayoutStore.persist.setOptions({ name: names.terminalLayout })
  setChatTabsStorageKey(names.chatTabs)
}

async function rehydrateStoreNamespaces() {
  await Promise.all([
    Promise.resolve(useChatInputStore.persist.rehydrate()),
    Promise.resolve(useDiffCommitStore.persist.rehydrate()),
    Promise.resolve(useRightSidebarStore.persist.rehydrate()),
    Promise.resolve(useTerminalLayoutStore.persist.rehydrate()),
  ])
  useChatTabsStore.setState({ tabs: readStoredChatTabs(), recentChatIds: [] })
}

function clearDiffReviewSessionState(nextUserId: string | null) {
  try {
    const previousUserId = window.sessionStorage.getItem(GATEWAY_TAB_USER_KEY)
    if (!nextUserId || previousUserId !== nextUserId) {
      for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = window.sessionStorage.key(index)
        if (key?.startsWith(DIFF_REVIEW_STORAGE_KEY_PREFIX)) window.sessionStorage.removeItem(key)
      }
    }
    if (nextUserId) window.sessionStorage.setItem(GATEWAY_TAB_USER_KEY, nextUserId)
    else window.sessionStorage.removeItem(GATEWAY_TAB_USER_KEY)
  } catch {
    // Session storage may be unavailable; persistent stores remain user scoped.
  }
}

/** Bind browser-private workspace state to the server-confirmed gateway user. */
export function bindGatewayUserStorage(userId: string | null): Promise<void> {
  if (userId !== null && !/^[a-f0-9]{32}$/.test(userId)) {
    return Promise.reject(new Error("Invalid gateway user identity"))
  }
  return runSerialized(async () => {
    if (storageBound && activeGatewayUserId === userId) return

    if (activeGatewayUserId) flushChatInputPersistence()
    else discardPendingChatInputPersistence()

    try {
      await withWorkspacePersistencePaused(async () => {
        resetStoreMemory()
        bindStorageNames(userId)
        clearDiffReviewSessionState(userId)
        if (userId) await rehydrateStoreNamespaces()
        else useChatTabsStore.setState({ tabs: [], recentChatIds: [] })
      })
    } catch (error) {
      await withWorkspacePersistencePaused(async () => {
        resetStoreMemory()
        bindStorageNames(null)
        clearDiffReviewSessionState(null)
      })
      activeGatewayUserId = null
      storageBound = false
      throw error
    }

    activeGatewayUserId = userId
    storageBound = true
  })
}

/** Compatibility wrapper for callers that only need to reconcile a signed-in user. */
export function reconcileGatewayUser(userId: string): Promise<void> {
  return bindGatewayUserStorage(userId)
}

/** Logout removes only the currently bound user's browser state and bearer token. */
export function clearGatewayUserLocalState(options: { clearAuth?: boolean } = {}): Promise<void> {
  return runSerialized(async () => {
    if (options.clearAuth) clearBearerSession()
    discardPendingChatInputPersistence()

    const currentNames = storageNames(activeGatewayUserId)
    await withWorkspacePersistencePaused(async () => {
      resetStoreMemory()
      useChatInputStore.persist.setOptions({ name: currentNames.chatInput })
      useDiffCommitStore.persist.setOptions({ name: currentNames.diffCommit })
      useRightSidebarStore.persist.setOptions({ name: currentNames.rightSidebar })
      useTerminalLayoutStore.persist.setOptions({ name: currentNames.terminalLayout })
      setChatTabsStorageKey(currentNames.chatTabs)
      useChatInputStore.persist.clearStorage()
      useDiffCommitStore.persist.clearStorage()
      useRightSidebarStore.persist.clearStorage()
      useTerminalLayoutStore.persist.clearStorage()
      removeStoredChatTabs(currentNames.chatTabs)
      clearDiffReviewSessionState(null)

      bindStorageNames(null)
      resetStoreMemory()
    })

    activeGatewayUserId = null
    storageBound = true
  })
}

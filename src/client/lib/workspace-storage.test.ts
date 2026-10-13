import { afterEach, expect, test } from "bun:test"
import {
  gatewayWorkspaceStorageKey,
  withWorkspacePersistencePaused,
  workspaceLocalStorage,
} from "./workspace-storage"

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

function installWindow() {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear() { values.clear() },
    getItem(key) { return values.get(key) ?? null },
    key(index) { return [...values.keys()][index] ?? null },
    removeItem(key) { values.delete(key) },
    setItem(key, value) { values.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage } as unknown as Window,
  })
  return storage
}

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

test("gateway persistence keys are isolated by stable user id", () => {
  expect(gatewayWorkspaceStorageKey("chat-input-drafts", "a".repeat(32)))
    .toBe(`chat-input-drafts.gateway.${"a".repeat(32)}`)
  expect(gatewayWorkspaceStorageKey("chat-input-drafts", null)).toBe("chat-input-drafts.gateway.locked")
})

test("persistence pause suppresses writes while leaving namespace reads available", async () => {
  installWindow()
  workspaceLocalStorage.setItem("drafts.gateway.user-a", "saved")

  await withWorkspacePersistencePaused(async () => {
    workspaceLocalStorage.setItem("drafts.gateway.user-a", "must-not-overwrite")
    expect(workspaceLocalStorage.getItem("drafts.gateway.user-a")).toBe("saved")
  })

  workspaceLocalStorage.setItem("drafts.gateway.user-a", "new")
  expect(workspaceLocalStorage.getItem("drafts.gateway.user-a")).toBe("new")
})

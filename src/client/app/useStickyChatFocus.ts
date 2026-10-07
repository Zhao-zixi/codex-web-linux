import { useEffect, type RefObject } from "react"
import {
  hasActiveFocusOverlay,
  hasActiveTextSelection,
  RESTORE_CHAT_INPUT_FOCUS_EVENT,
  resolveChatFocusAction,
  shouldComposerClaimFocus,
} from "./chatFocusPolicy"

interface StickyChatFocusOptions {
  rootRef: RefObject<HTMLElement | null>
  fallbackRef: RefObject<HTMLTextAreaElement | null>
  enabled: boolean
  canCancel: boolean
  /** Changes on every arrival at a chat, the open one picked again included. */
  arrivalKey: string
}

/**
 * How long an arrival holds focus in the composer. Past a menu's close
 * animation, which is what hands focus elsewhere latest.
 */
const ARRIVAL_CLAIM_MS = 1000
/**
 * How many times one arrival takes focus back. Something that insists on
 * having it (a focus trap this didn't recognise) wins, instead of the two
 * passing it back and forth for the whole second.
 */
const ARRIVAL_CLAIM_LIMIT = 4

export function useStickyChatFocus({ rootRef, fallbackRef, enabled, canCancel, arrivalKey }: StickyChatFocusOptions) {
  // Arriving at a chat puts focus in its composer, and holds it there until
  // you do something or a second has passed. The composer focuses itself when
  // it mounts, but that is one moment, and focus is handed around after it: a
  // right-click menu gives it back to the row it opened on once its close
  // animation ends, by which time the chat made from that menu is already up.
  // It also covers what a mount can't: the chat that was already open, picked
  // again in the sidebar, and a composer that mounted disabled (a page loaded
  // on a chat, before the sidebar has said which project it is in).
  //
  // Only with a real keyboard, as the branch picker's field is: on a phone
  // this would raise the on-screen keyboard over the chat you came to read.
  useEffect(() => {
    if (!enabled) return
    if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return

    let claimsLeft = ARRIVAL_CLAIM_LIMIT
    const claim = (target: Element | null) => {
      const fallback = fallbackRef.current
      if (claimsLeft === 0) return
      if (!shouldComposerClaimFocus({ target, fallback, hasActiveOverlay: hasActiveFocusOverlay(document) })) return
      claimsLeft -= 1
      fallback?.focus({ preventScroll: true })
    }
    const handleFocusIn = (event: FocusEvent) => {
      claim(event.target instanceof Element ? event.target : null)
    }
    // A press or a key is you deciding where focus goes next.
    const release = () => {
      window.clearTimeout(timeoutId)
      document.removeEventListener("focusin", handleFocusIn)
      window.removeEventListener("pointerdown", release, true)
      window.removeEventListener("keydown", release, true)
    }
    const timeoutId = window.setTimeout(release, ARRIVAL_CLAIM_MS)
    document.addEventListener("focusin", handleFocusIn)
    window.addEventListener("pointerdown", release, true)
    window.addEventListener("keydown", release, true)
    claim(document.activeElement)
    return release
  }, [arrivalKey, enabled, fallbackRef])

  useEffect(() => {
    if (!enabled) return

    let rafId = 0
    let pointerStartTarget: Element | null = null

    const restoreFocusIfNeeded = (pointerEndTarget: EventTarget | null) => {
      const target = pointerEndTarget instanceof Element ? pointerEndTarget : null
      const root = rootRef.current
      const fallback = fallbackRef.current

      if (resolveChatFocusAction({
        trigger: "pointer",
        activeElement: document.activeElement,
        pointerStartTarget,
        pointerEndTarget: target,
        root,
        fallback,
        hasActiveOverlay: hasActiveFocusOverlay(document),
        hasActiveSelection: hasActiveTextSelection(window.getSelection()),
      }) !== "restore") {
        pointerStartTarget = null
        return
      }

      fallback?.focus({ preventScroll: true })
      pointerStartTarget = null
    }

    const handlePointerDown = (event: PointerEvent) => {
      cancelAnimationFrame(rafId)
      pointerStartTarget = event.target instanceof Element ? event.target : null
    }

    const handlePointerUp = (event: PointerEvent) => {
      cancelAnimationFrame(rafId)
      rafId = window.requestAnimationFrame(() => {
        restoreFocusIfNeeded(event.target)
      })
    }

    const handleRestoreFocus = () => {
      pointerStartTarget = null
      const fallback = fallbackRef.current
      if (!fallback || fallback.disabled) return
      fallback.focus({ preventScroll: true })
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return

      const fallback = fallbackRef.current
      if (resolveChatFocusAction({
        trigger: "escape",
        activeElement: document.activeElement,
        fallback,
        hasActiveOverlay: hasActiveFocusOverlay(document),
        canCancel,
        defaultPrevented: event.defaultPrevented,
      }) !== "escape-focus") {
        return
      }

      event.preventDefault()
      fallback?.focus({ preventScroll: true })
    }

    window.addEventListener("pointerdown", handlePointerDown, true)
    window.addEventListener("pointerup", handlePointerUp, true)
    window.addEventListener("keydown", handleKeyDown, true)
    window.addEventListener(RESTORE_CHAT_INPUT_FOCUS_EVENT, handleRestoreFocus)
    return () => {
      cancelAnimationFrame(rafId)
      window.removeEventListener("pointerdown", handlePointerDown, true)
      window.removeEventListener("pointerup", handlePointerUp, true)
      window.removeEventListener("keydown", handleKeyDown, true)
      window.removeEventListener(RESTORE_CHAT_INPUT_FOCUS_EVENT, handleRestoreFocus)
    }
  }, [canCancel, enabled, fallbackRef, rootRef])
}

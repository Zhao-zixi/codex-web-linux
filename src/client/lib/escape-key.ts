import { CHAT_INPUT_ATTRIBUTE } from "../app/chatFocusPolicy"

/**
 * What a press of Escape does on the chat page, in one order instead of one
 * that depends on where focus is:
 *
 *   1. Whatever is nearer the key and has a use for it keeps it: an open
 *      menu, select, popover or dialog (the command palette), a composer's
 *      skill or project list, an IME composition, a text field that is not a
 *      chat composer (a search box, the plan's edit box, a terminal).
 *   2. The viewer's pane, if it is open, closes. From anywhere, the main
 *      composer and a previewed chat's composer included, turn running or not.
 *   3. Only with no pane open does Escape reach a running turn, and then it
 *      has to be held (`hold-to-confirm`): a press only starts the hold.
 *
 * One press does one thing. The key repeats while it is held, and a repeat
 * never acts: the press that closed the pane cannot go on to start a hold,
 * and one that closed a menu cannot go on to close the pane. Nor is a repeat
 * passed on, to whatever is last in line for Escape (leaving the sidebar's
 * focus mode): holding the key is how a turn is stopped now, and a hold
 * that ran a moment past its turn stopping would otherwise leak there.
 * Nothing more happens until the key is let go and pressed again.
 *
 * The decision is `resolveEscapePress`, pure, for tests. The two readers
 * under it gather its inputs from the page. Two handlers act on the answer:
 * the viewer's (`ViewerSurface`, first, at the window) and the composer's
 * (`ChatInput`).
 */

export interface EscapePress {
  /** The key was already down: an auto-repeat of an earlier press. */
  repeat: boolean
  /** Something nearer has a use for the key (step 1 above). */
  claimed: boolean
  /** The viewer's pane is on screen. */
  paneOpen: boolean
  /** Focus is in a chat composer whose chat has a turn running. */
  canInterrupt: boolean
}

export type EscapeAction =
  /** Not ours. Leave the event alone, for whoever claimed it or comes after. */
  | "pass"
  /** To swallow and do nothing with: a repeat of a press already spent. */
  | "ignore"
  | "close-pane"
  /** Begin the hold that interrupts the turn if it is kept up. */
  | "hold-to-interrupt"

export function resolveEscapePress(press: EscapePress): EscapeAction {
  if (press.claimed) return "pass"
  if (press.repeat) return "ignore"
  if (press.paneOpen) return "close-pane"
  if (press.canInterrupt) return "hold-to-interrupt"
  return "pass"
}

/**
 * A menu, select, popover or dialog open over the page, Radix's or a
 * composer's own list (which carries the same `data-state`). Tooltips don't
 * count; they close with whatever else the key does.
 */
const OPEN_LAYER_SELECTOR = "[role='menu'][data-state='open'], [role='listbox'][data-state='open'], [role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"

export function hasOpenLayer(): boolean {
  return Boolean(document.querySelector(OPEN_LAYER_SELECTOR))
}

function isTextField(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  return element.isContentEditable || element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT"
}

/** Marks a viewer card whose fields keep Escape (see `ViewerSurface`'s `fieldsKeepEscape`). */
export const VIEWER_FIELDS_KEEP_ESCAPE_ATTRIBUTE = "data-fields-keep-escape"

/**
 * Whether something nearer than the pane and the turn has a use for this
 * Escape. Read at the window, before any of them has heard the key, so it
 * goes by what is open and where focus is, not by `defaultPrevented`.
 */
export function isEscapeClaimed(event: Pick<KeyboardEvent, "isComposing" | "keyCode" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  // With a modifier it is some other shortcut.
  if (event.metaKey || event.ctrlKey || event.altKey) return true
  // Escape during an IME composition cancels the composition. 229 is what
  // Safari reports for the keydown that ends one, after `isComposing` is off.
  if (event.isComposing || event.keyCode === 229) return true
  if (hasOpenLayer()) return true

  const active = document.activeElement
  if (!isTextField(active)) return false
  // A chat composer's Escape is the page's: its own lists are open layers,
  // counted above, and past those it closes the pane or holds to stop.
  if (active.hasAttribute(CHAT_INPUT_ATTRIBUTE)) return false
  // Any other field keeps it, to clear itself or close its editor. Except in
  // a viewer card that has no use for the key but closing, as before.
  const viewer = active.closest("[data-viewer-surface]")
  return !viewer || viewer.hasAttribute(VIEWER_FIELDS_KEEP_ESCAPE_ATTRIBUTE)
}

/** Whether a viewer card is on screen and in use: not one that is leaving, or covered by another. */
export function isViewerPaneOpen(): boolean {
  for (const surface of document.querySelectorAll("[data-viewer-surface]")) {
    if (!surface.closest("[inert]")) return true
  }
  return false
}

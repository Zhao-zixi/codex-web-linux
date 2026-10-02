/**
 * Whether the click being handled right now asks to open its target in the
 * background: Cmd held on a Mac, Ctrl elsewhere, as a browser reads a click
 * on a link. A chat opened this way gets a tab and is not switched to.
 *
 * Read off the event in flight rather than passed down: the things a chat can
 * be clicked in hand their owners a chat id, through several layers, and none
 * of them carry the event. Only meaningful called from inside a click handler.
 */
export function isBackgroundOpenClick() {
  const event = typeof window === "undefined" ? undefined : window.event
  if (!(event instanceof MouseEvent)) return false
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform)
  return isMac ? event.metaKey : event.ctrlKey
}

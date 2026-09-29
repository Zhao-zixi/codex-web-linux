import koffi from "koffi"

/**
 * The AppKit calls Electron has no API for, made through the Objective-C
 * runtime with koffi (a prebuilt FFI, nothing to compile).
 *
 * Electron gives a window no toolbar, and on macOS 26 a window without one
 * gets 16pt corners and traffic lights near the edge. An empty unified
 * NSToolbar gives it the shape of a macOS 26 sidebar app: 26pt corners,
 * traffic lights centered 26pt down. So this adds one, then reads the shape
 * back from the window, since it differs between macOS versions.
 */
export interface WindowShape {
  /** Where the page may start drawing to the right of the traffic lights. */
  trafficLightsInset: number
  /** How far down the lights' centers are; title-bar content centers there. */
  trafficLightsCenter: number
  cornerRadius: number
  /** The close button's top-left, from the window's top-left, where the
   *  toolbar lays the traffic lights out. For setWindowButtonPosition. */
  trafficLights: { x: number; y: number } | null
}

/** macOS 26's unified toolbar, for when a value can't be read. */
export const FALLBACK_SHAPE: WindowShape = { trafficLightsInset: 91, trafficLightsCenter: 26, cornerRadius: 26, trafficLights: null }

type Pointer = unknown
type Rect = { x: number; y: number; width: number; height: number }

let runtime: ReturnType<typeof loadRuntime> | null | undefined

function loadRuntime() {
  const objc = koffi.load("/usr/lib/libobjc.A.dylib")
  const NSRect = koffi.struct("KannaNSRect", { x: "double", y: "double", width: "double", height: "double" })
  const NSPoint = koffi.struct("KannaNSPoint", { x: "double", y: "double" })
  // One declaration per signature: objc_msgSend takes whatever the method does.
  const send = {
    id: objc.func("objc_msgSend", "void *", ["void *", "void *"]),
    idWithId: objc.func("objc_msgSend", "void *", ["void *", "void *", "void *"]),
    idWithString: objc.func("objc_msgSend", "void *", ["void *", "void *", "str"]),
    idWithLong: objc.func("objc_msgSend", "void *", ["void *", "void *", "long"]),
    voidWithLong: objc.func("objc_msgSend", "void", ["void *", "void *", "long"]),
    voidWithBool: objc.func("objc_msgSend", "void", ["void *", "void *", "bool"]),
    performLater: objc.func("objc_msgSend", "void", ["void *", "void *", "void *", "void *", "double"]),
    boolWithSelector: objc.func("objc_msgSend", "bool", ["void *", "void *", "void *"]),
    double: objc.func("objc_msgSend", "double", ["void *", "void *"]),
    rect: objc.func("objc_msgSend", NSRect, ["void *", "void *"]),
    rectConvert: objc.func("objc_msgSend", NSRect, ["void *", "void *", NSRect, "void *"]),
    point: objc.func("objc_msgSend", NSPoint, ["void *", "void *"]),
    long: objc.func("objc_msgSend", "long", ["void *", "void *"]),
    // +[NSEvent mouseEventWithType:location:modifierFlags:timestamp:
    //   windowNumber:context:eventNumber:clickCount:pressure:]
    mouseEvent: objc.func("objc_msgSend", "void *", [
      "void *", "void *", "ulong", NSPoint, "ulong", "double", "long", "void *", "long", "long", "float",
    ]),
  }
  const getClass = objc.func("void *objc_getClass(const char *)")
  const selector = objc.func("void *sel_registerName(const char *)")
  return { send, getClass, sel: (name: string) => selector(name) as Pointer }
}

function objc() {
  if (runtime === undefined) {
    try {
      runtime = loadRuntime()
    } catch (error) {
      console.error("[kanna] no Objective-C runtime; the window keeps Electron's shape", error)
      runtime = null
    }
  }
  return runtime
}

/**
 * The window's setup: an empty unified toolbar with no separator,
 * no title-bar line, no tabs. Resolves the shape the page needs once the
 * toolbar is in, or the fallback.
 *
 * AppKit attaches the toolbar on the next run-loop turn, not inside this
 * call: `setToolbar:` lays the window out again, Electron answers with a
 * synchronous `resize` into JavaScript, and V8 aborts on that re-entry
 * while koffi's call is still on the stack.
 */
export function shapeWindow(handle: Buffer): Promise<WindowShape> {
  const rt = objc()
  if (!rt) return Promise.resolve(FALLBACK_SHAPE)
  const { send, sel, getClass } = rt
  let window: Pointer
  try {
    // Electron's handle is the window's NSView.
    window = send.id(koffi.decode(handle, "void *"), sel("window"))
    send.voidWithLong(window, sel("setToolbarStyle:"), 3) // NSWindowToolbarStyleUnified
    send.voidWithLong(window, sel("setTitlebarSeparatorStyle:"), 1) // NSTitlebarSeparatorStyleNone
    send.voidWithLong(window, sel("setTabbingMode:"), 2) // NSWindowTabbingModeDisallowed
    const identifier = send.idWithString(getClass("NSString"), sel("stringWithUTF8String:"), "Main")
    const toolbar = send.idWithId(send.id(getClass("NSToolbar"), sel("alloc")), sel("initWithIdentifier:"), identifier)
    send.voidWithBool(toolbar, sel("setShowsBaselineSeparator:"), false)
    send.performLater(window, sel("performSelector:withObject:afterDelay:"), sel("setToolbar:"), toolbar, 0)
  } catch (error) {
    console.error("[kanna] couldn't shape the window", error)
    return Promise.resolve(FALLBACK_SHAPE)
  }
  return new Promise((resolve) => {
    let tries = 0
    const check = () => {
      if (send.id(window, sel("toolbar")) || ++tries > 60) resolve(readShape(window))
      else setTimeout(check, 16)
    }
    setTimeout(check, 0)
  })
}

/** Where the toolbar put the traffic lights, and the corner radius. Getters
 *  only, so nothing here lays the window out. */
function readShape(window: Pointer): WindowShape {
  const { send, sel } = objc()!
  try {
    let inset = FALLBACK_SHAPE.trafficLightsInset
    let center = FALLBACK_SHAPE.trafficLightsCenter
    let trafficLights: WindowShape["trafficLights"] = null
    const windowHeight = (send.rect(window, sel("frame")) as Rect).height
    const frameOf = (button: Pointer) => send.rectConvert(button, sel("convertRect:toView:"), send.rect(button, sel("bounds")), null) as Rect
    const close = send.idWithLong(window, sel("standardWindowButton:"), 0) // NSWindowCloseButton
    if (close) {
      const frame = frameOf(close)
      trafficLights = { x: Math.round(frame.x), y: Math.round(windowHeight - (frame.y + frame.height)) }
    }
    const zoom = send.idWithLong(window, sel("standardWindowButton:"), 2) // NSWindowZoomButton
    if (zoom) {
      const frame = frameOf(zoom)
      const maxX = frame.x + frame.width
      const fromTop = windowHeight - (frame.y + frame.height / 2)
      // 12pt of air after the green light, as the system leaves before a
      // toolbar's first item.
      if (maxX > 0) inset = Math.round(maxX + 12)
      if (maxX > 0 && fromTop > 0) center = Math.round(fromTop)
    }
    // NSWindow has no public corner radius; this private one is read-only
    // and only styles the sidebar, so a miss just means the fallback.
    let radius = FALLBACK_SHAPE.cornerRadius
    if (send.boolWithSelector(window, sel("respondsToSelector:"), sel("_cornerRadius"))) {
      const read = send.double(window, sel("_cornerRadius")) as number
      if (read > 0) radius = read
    }
    return { trafficLightsInset: inset, trafficLightsCenter: center, cornerRadius: radius, trafficLights }
  } catch (error) {
    console.error("[kanna] couldn't read the window's shape", error)
    return FALLBACK_SHAPE
  }
}

/**
 * Drags the window from a mousedown the page saw on its title bar. The page
 * decides by the element under the mouse (preload.ts), so a control floating
 * over a title bar always gets its click. Electron's `-webkit-app-region`
 * can't promise that: its drag areas are rectangles Chromium recomputes on
 * its own schedule, and a stale one over an animating sidebar swallowed the
 * sidebar toggle's clicks.
 *
 * The page's mousedown reaches this process as a message, so there's no
 * NSEvent to hand AppKit; this makes one at the mouse's current spot, which
 * is where it went down a few milliseconds ago. It starts on the next
 * run-loop turn for the reason shapeWindow's toolbar does: the drag moves
 * the window, and Electron reports moves into JavaScript synchronously.
 */
export function dragWindow(handle: Buffer) {
  const rt = objc()
  if (!rt) return
  const { send, sel, getClass } = rt
  try {
    const window = send.id(koffi.decode(handle, "void *"), sel("window"))
    const location = send.point(window, sel("mouseLocationOutsideOfEventStream"))
    const uptime = send.double(send.id(getClass("NSProcessInfo"), sel("processInfo")), sel("systemUptime"))
    const windowNumber = send.long(window, sel("windowNumber"))
    const event = send.mouseEvent(
      getClass("NSEvent"),
      sel("mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:"),
      1, // NSEventTypeLeftMouseDown
      location,
      0,
      uptime,
      windowNumber,
      null,
      0,
      1,
      1
    )
    if (event) send.performLater(window, sel("performSelector:withObject:afterDelay:"), sel("performWindowDragWithEvent:"), event, 0)
  } catch (error) {
    console.error("[kanna] couldn't drag the window", error)
  }
}

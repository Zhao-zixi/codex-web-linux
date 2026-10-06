import { describe, expect, test } from "bun:test"
import { Script, runInNewContext } from "node:vm"
import { buildVisualizationDocument, VISUALIZATION_CONTENT_CSP } from "./visualization-document"
import { prepareVisualizationDocument } from "../shared/visualization-host"

async function parse(html: string) {
  const frames: Array<Record<string, string | null>> = []
  const scripts: string[] = []
  let index = -1
  await new HTMLRewriter().on("iframe", { element(el) {
    frames.push(Object.fromEntries(["srcdoc", "sandbox", "title"].map(name => [name, el.getAttribute(name)])))
  } }).on("script", { element() { scripts.push(""); index++ }, text(text) { scripts[index] += text.text } })
    .transform(new Response(html)).text()
  return { frames, scripts }
}

// HTMLRewriter preserves character references in attributes.
const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

describe("visualization document isolation", () => {
  test("host shell contains authored markup only inside one escaped, script-only iframe", async () => {
    const attack = '</iframe><script>window.pwned=true</script><iframe src="https://bad.invalid">'
    const html = buildVisualizationDocument(attack, '"><script>bad()</script>', 360)
    const shell = await parse(html)
    expect(shell.frames).toHaveLength(1)
    expect(shell.frames[0]!.sandbox).toBe("allow-scripts")
    expect(shell.scripts).toHaveLength(1)
    expect(shell.scripts[0]).not.toContain("window.pwned")
    expect(html).toContain("frame-src about:")
    const inner = decode(shell.frames[0]!.srcdoc!)
    expect(inner).toContain(VISUALIZATION_CONTENT_CSP)
    expect(inner.indexOf("Content-Security-Policy")).toBeLessThan(inner.indexOf("window.pwned"))
    expect(inner).toContain("connect-src 'none'")
    expect(inner).toContain("form-action 'none'")
    expect(inner).toContain("frame-src 'none'")
  })

  test("host and content bridge JavaScript compiles, including literal script delimiters in data", async () => {
    const shell = await parse(buildVisualizationDocument('<p>Example</p>', 'A </script> title', 360))
    const content = await parse(decode(shell.frames[0]!.srcdoc!))
    for (const code of [...shell.scripts, ...content.scripts]) expect(() => new Script(code)).not.toThrow()
  })

  test("bridge accepts only its own frame, bounds size, rejects unsafe links, and updates theme without replacing content", async () => {
    const shell = await parse(buildVisualizationDocument('<p>Example</p>', 'Example', 360))
    const events: Record<string, (event: any) => void> = {}
    const forwarded: unknown[] = [], themes: unknown[] = []
    const child = { postMessage: (value: unknown) => themes.push(value) }
    const parent = { postMessage: (value: unknown) => forwarded.push(value) }
    const frame = { contentWindow: child, style: { height: "360px" }, addEventListener: () => {} }
    const window = {}, style = { colorScheme: "" }
    runInNewContext(shell.scripts[0]!, { document: { getElementById: () => frame, documentElement: { style } }, window, parent,
      matchMedia: () => ({ matches: false }), addEventListener: (name: string, fn: any) => { events[name] = fn }, URL })
    const message = (source: unknown, data: unknown) => events.message!({ source, data })
    forwarded.length = 0
    message({}, { type: 'kanna:resize', height: 999 })
    message(child, { type: 'kanna:resize', height: Infinity })
    message(child, { type: 'kanna:link', url: 'javascript:alert(1)' })
    message(child, { type: 'kanna:link', url: 'https://user:secret@example.com' })
    expect(forwarded).toEqual([])
    message(child, { type: 'kanna:resize', height: 99999 })
    expect(frame.style.height).toBe('2400px')
    message(child, { type: 'kanna:resize', height: 190.2 })
    expect(frame.style.height).toBe('191px')
    message(parent, { type: 'kanna:theme', theme: { appearance: 'dark' } })
    expect(style.colorScheme).toBe('dark')
    expect(themes.at(-1)).toEqual({ type: 'kanna:theme', theme: { appearance: 'dark' } })
    message(parent, { type: 'kanna:theme', theme: null })
    expect(style.colorScheme).toBe('dark')
    message(parent, { type: 'kanna:theme', theme: { appearance: 'light' } })
    expect(style.colorScheme).toBe('light')
    expect(frame).not.toHaveProperty('srcdoc')
  })

  test("loading a saved document supplies fonts and first-paint theme without escaping its sandbox", async () => {
    const authored = '<p>Body &amp; text</p><script>const example = "</iframe>";</script>'
    const theme = { appearance: 'dark' as const, variables: { '--font-sans': '"Body", sans-serif', '--foreground': '#fafafa' } }
    const fontCss = '@font-face{font-family:"Body";src:url("data:font/woff2;base64,dGVzdA==")}';
    const saved = buildVisualizationDocument(authored, 'Example', 360)
    const shell = await parse(prepareVisualizationDocument(saved, theme, fontCss))
    expect(shell.frames).toHaveLength(1)
    expect(shell.frames[0]!.sandbox).toBe('allow-scripts')
    const inner = decode(shell.frames[0]!.srcdoc!)
    expect(inner).toContain(authored)
    expect(inner).toContain(fontCss)
    expect(inner).toContain('--font-sans:"Body", sans-serif')
    expect(inner.indexOf(fontCss)).toBeLessThan(inner.indexOf(authored))
    expect(inner).toContain(VISUALIZATION_CONTENT_CSP)
    for (const script of shell.scripts) expect(() => new Script(script)).not.toThrow()
    // This load-time bootstrap also repairs the original shell, which did not
    // apply theme updates to its own root. It must reject messages from children.
    const style = { colorScheme: '' }, parent = {}, events: Record<string, (event: any) => void> = {}
    runInNewContext(shell.scripts[0]!, { document: { documentElement: { style } }, parent, window: {},
      addEventListener: (name: string, fn: any) => { events[name] = fn } })
    expect(style.colorScheme).toBe('dark')
    events.message!({ source: {}, data: { type: 'kanna:theme', theme: { appearance: 'light' } } })
    expect(style.colorScheme).toBe('dark')
    events.message!({ source: parent, data: { type: 'kanna:theme', theme: { appearance: 'light' } } })
    expect(style.colorScheme).toBe('light')
  })
})

export interface VisualizationTheme {
  appearance: "light" | "dark"
  variables: Record<string, string>
}

/** The base text size, for a document saved before it was the document's own. The iOS app adds the same rule (`VisualizationSurface`). */
export const VISUALIZATION_BASE_SIZE_CSS = "html,body{font-size:16px}"

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const decodeAttribute = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

/** Adapt immutable saved shells at load time, including ones made before the host
 * forwarded fonts and appearance. Only the generated shell and its escaped srcdoc
 * are touched; authored markup stays inside the same opaque-origin sandbox. */
export function prepareVisualizationDocument(html: string, theme: VisualizationTheme, fontCss: string): string {
  const variables = Object.entries(theme.variables)
    .filter(([key, value]) => /^--[a-z0-9-]+$/.test(key) && value.length < 300 && !/[;{}<>]|url\s*\(/i.test(value))
    .map(([key, value]) => `${key}:${value}`).join(";")
  // Documents saved while the base size was 14px carry it in their own
  // stylesheet. This sits after that and before anything authored.
  const css = `${fontCss}:root{color-scheme:${theme.appearance};${variables}}html{-webkit-font-smoothing:antialiased}${VISUALIZATION_BASE_SIZE_CSS}`
  // A key pressed in the frame never reaches the page around it. Escape is
  // the page's way out of a pane, so one the visualization has no use for is
  // passed up. Heard last, so the page's own handlers answer it first.
  const escape = `<script>addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) parent.postMessage({type:'kanna:escape', repeat:event.repeat}, '*');
  });</script>`
  const prepared = html.replace(/\bsrcdoc="([^"]*)"/, (_, source: string) => {
    const inner = decodeAttribute(source).replace("</head>", `<style>${css}</style>${escape}</head>`)
    return `srcdoc="${escapeAttribute(inner)}"`
  })
  // Browsers paint an opaque canvas when an iframe and its document disagree on
  // color-scheme. The shell must follow the theme as well as its inner document.
  const bootstrap = `<script>(()=>{
    const apply = appearance => { if (appearance === 'light' || appearance === 'dark') document.documentElement.style.colorScheme = appearance; };
    apply('${theme.appearance}');
    addEventListener('message', event => {
      if (event.source === parent && parent !== window && event.data?.type === 'kanna:theme') apply(event.data.theme?.appearance);
      // The saved shell passes on only the messages it knew when it was written.
      const frame = document.getElementById('visualization');
      if (frame && event.source === frame.contentWindow && parent !== window && event.data?.type === 'kanna:escape') parent.postMessage({type:'kanna:escape', repeat:event.data.repeat === true}, '*');
    });
  })();</script>`
  return prepared.replace("</head>", `${bootstrap}</head>`)
}

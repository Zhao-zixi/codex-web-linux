export interface VisualizationTheme {
  appearance: "light" | "dark"
  variables: Record<string, string>
}

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const decodeAttribute = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

/** Adapt immutable saved shells at load time, including ones made before the host
 * forwarded fonts and appearance. Only the generated shell and its escaped srcdoc
 * are touched; authored markup stays inside the same opaque-origin sandbox. */
export function prepareVisualizationDocument(html: string, theme: VisualizationTheme, fontCss: string): string {
  const variables = Object.entries(theme.variables)
    .filter(([key, value]) => /^--[a-z0-9-]+$/.test(key) && value.length < 300 && !/[;{}<>]|url\s*\(/i.test(value))
    .map(([key, value]) => `${key}:${value}`).join(";")
  const css = `${fontCss}:root{color-scheme:${theme.appearance};${variables}}html{-webkit-font-smoothing:antialiased}`
  const prepared = html.replace(/\bsrcdoc="([^"]*)"/, (_, source: string) => {
    const inner = decodeAttribute(source).replace("</head>", `<style>${css}</style></head>`)
    return `srcdoc="${escapeAttribute(inner)}"`
  })
  // Browsers paint an opaque canvas when an iframe and its document disagree on
  // color-scheme. The shell must follow the theme as well as its inner document.
  const bootstrap = `<script>(()=>{
    const apply = appearance => { if (appearance === 'light' || appearance === 'dark') document.documentElement.style.colorScheme = appearance; };
    apply('${theme.appearance}');
    addEventListener('message', event => {
      if (event.source === parent && parent !== window && event.data?.type === 'kanna:theme') apply(event.data.theme?.appearance);
    });
  })();</script>`
  return prepared.replace("</head>", `${bootstrap}</head>`)
}

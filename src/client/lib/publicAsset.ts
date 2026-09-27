/**
 * URL of a file in `public/`, under the base the bundle was built with.
 *
 * The app is built at base "/", but the kanna.sh demo is built at "./" and
 * served from /demo/, where a hard-coded "/editor-icons/…" would reach the
 * site's root instead of the demo's copy. Vite inlines `BASE_URL` at build
 * time; under Bun's test runner it is unset, so fall back to "/".
 */
export function publicAssetUrl(path: string) {
  const base = import.meta.env.BASE_URL ?? "/"
  return `${base}${path.replace(/^\//, "")}`
}

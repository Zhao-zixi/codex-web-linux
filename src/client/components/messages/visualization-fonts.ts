import regular from "../../../../public/fonts/body-regular.woff2?inline"
import italic from "../../../../public/fonts/body-regular-italic.woff2?inline"
import medium from "../../../../public/fonts/body-medium.woff2?inline"
import semibold from "../../../../public/fonts/body-semibold.woff2?inline"

// A font-family name does not share the parent document's loaded fonts. Embed
// the same assets so the opaque iframe needs neither network access nor cookies.
export const visualizationFontCss = [
  [regular, 400, "normal"], [italic, 400, "italic"],
  [medium, 500, "normal"], [semibold, 600, "normal"],
].map(([src, weight, style]) => `@font-face{font-family:"Body";src:url("${src}") format("woff2");font-weight:${weight};font-style:${style};font-display:swap}`).join("")

// Must stay the first import: it swaps in the fake WebSocket and storage
// before any client module evaluates.
import { readThemeParam } from "./environment"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import "@fontsource-variable/bricolage-grotesque"
import { App } from "../client/app/App"
import { ThemeProvider } from "../client/hooks/useTheme"
import { useAppSettingsStore } from "../client/stores/appSettingsStore"
import { createDemoAppSettings } from "./backend"
import { DEMO_FEATURED_CHAT_ID } from "./scenario"
import "@xterm/xterm/css/xterm.css"
import "../index.css"

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

// Seeded before the first render so ThemeProvider starts on the demo's theme
// instead of "system" and flipping once the settings snapshot arrives.
useAppSettingsStore.getState().setFromServer(createDemoAppSettings(readThemeParam()))

// A memory router: the demo lives at kanna.sh/demo/, inside an iframe, and
// must not push its /chat/... routes into the host page's address bar.
createRoot(container).render(
  <StrictMode>
    <MemoryRouter initialEntries={[`/chat/${DEMO_FEATURED_CHAT_ID}`]}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </MemoryRouter>
  </StrictMode>
)

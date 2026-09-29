import { app } from "electron"
import path from "node:path"

// `bun run start` runs unpackaged: keep its preferences and web data apart
// from a packaged copy's, as Kanna Dev keeps apart from Kanna. Its own module,
// imported first by main.ts, because other modules read prefs as they load.
if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), `${app.getName()} Dev`))

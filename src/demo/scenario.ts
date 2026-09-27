import type { AgentProvider } from "../shared/types"
import { TurnScript, todo, type DemoTurn } from "./script"

/**
 * Everything the demo shows: three made-up projects, the chats in them, and
 * the script that answers whatever a visitor types. None of it is real code
 * or a real conversation; it is written to look like a normal day in Kanna.
 */

export const DEMO_HOME = "/Users/you"

export interface DemoProjectSeed {
  id: string
  title: string
  localPath: string
  repoOwner: string
  branchName: string
  /** Read by the scripted reply when nothing in the project matches the prompt. */
  entryFile: string
  /** The committed tree. Chats edit a copy of it. */
  files: Record<string, string>
}

export interface DemoChatSeed {
  id: string
  projectId: string
  title: string
  turns: DemoTurn[]
  /** When the chat last moved, relative to page load. */
  minutesAgo: number
  unread?: boolean
  /** Commit the tree after this chat, so its edits leave the diff panel. */
  commitAfter?: boolean
  /**
   * The last turn is still streaming when the demo opens: steps before this
   * index are already in the transcript, the rest play live.
   */
  liveFromStep?: number
}

function projectPath(name: string) {
  return `${DEMO_HOME}/Projects/${name}`
}

// ---------------------------------------------------------------------------
// tidepool: a surf forecast web app
// ---------------------------------------------------------------------------

const TIDEPOOL = projectPath("tidepool")

const TIDEPOOL_FORECAST_CARD = `import { formatFeet } from "../lib/units"
import type { Forecast } from "../lib/types"

export function ForecastCard({ forecast }: { forecast: Forecast }) {
  return (
    <article className="forecast-card">
      <header>
        <h2>{forecast.spot}</h2>
        <time>{forecast.day}</time>
      </header>
      <p className="wave-height">{formatFeet(forecast.waveHeightM)}</p>
      <p className="swell">
        {forecast.swellPeriodS}s swell from {forecast.swellDirection}
      </p>
    </article>
  )
}
`

const TIDEPOOL_UNITS = `const FEET_PER_METER = 3.28084

export function formatFeet(meters: number) {
  return \`\${(meters * FEET_PER_METER).toFixed(1)} ft\`
}
`

const TIDEPOOL_TIDE_CHART = `import type { TidePoint } from "../lib/types"

const WIDTH = 320
const HEIGHT = 96

export function TideChart({ points }: { points: TidePoint[] }) {
  const times = points.map((point) => new Date(point.time).getTime())
  const start = Math.min(...times)
  const span = Math.max(...times) - start
  const path = points
    .map((point, index) => {
      const x = ((times[index]! - start) / span) * WIDTH
      const y = HEIGHT - point.heightM * 40
      return \`\${index === 0 ? "M" : "L"}\${x.toFixed(1)},\${y.toFixed(1)}\`
    })
    .join(" ")

  return (
    <svg viewBox={\`0 0 \${WIDTH} \${HEIGHT}\`} className="tide-chart">
      <path d={path} />
    </svg>
  )
}
`

const TIDEPOOL_TYPES = `export interface Forecast {
  spot: string
  day: string
  waveHeightM: number
  swellPeriodS: number
  swellDirection: string
}

export interface TidePoint {
  /** Local time from the tide API, e.g. "2026-09-26 06:00". */
  time: string
  heightM: number
}
`

const TIDEPOOL_APP = `import { ForecastCard } from "./components/ForecastCard"
import { TideChart } from "./components/TideChart"
import { useForecast } from "./hooks/useForecast"

export function App() {
  const { forecasts, tides } = useForecast("ocean-beach")
  return (
    <main>
      <h1>tidepool</h1>
      {forecasts.map((forecast) => (
        <ForecastCard key={forecast.day} forecast={forecast} />
      ))}
      <TideChart points={tides} />
    </main>
  )
}
`

const TIDEPOOL_PACKAGE = `{
  "name": "tidepool",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "bun test"
  },
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vite": "^7.1.0"
  }
}
`

const TIDEPOOL_README = `# tidepool

Surf forecasts for the spots you actually paddle out at.

\`\`\`sh
bun install
bun run dev
\`\`\`
`

// ---------------------------------------------------------------------------
// ledger-api: a small payments API
// ---------------------------------------------------------------------------

const LEDGER = projectPath("ledger-api")

const LEDGER_INDEX = `import { Hono } from "hono"
import { charges } from "./routes/charges"
import { customers } from "./routes/customers"
import { requireApiKey } from "./middleware/auth"

const app = new Hono()

app.get("/health", (c) => c.json({ ok: true }))
app.use("/v1/*", requireApiKey)
app.route("/v1/charges", charges)
app.route("/v1/customers", customers)

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch,
}
`

const LEDGER_CHARGES = `import { Hono } from "hono"
import { z } from "zod"
import { db } from "../db"

const CreateCharge = z.object({
  customerId: z.string(),
  amountCents: z.number().int().positive(),
  currency: z.enum(["usd", "eur", "gbp"]),
})

export const charges = new Hono()

charges.get("/", async (c) => {
  const rows = await db.charges.list({ limit: 50 })
  return c.json({ data: rows })
})

charges.post("/", async (c) => {
  const body = CreateCharge.parse(await c.req.json())
  const charge = await db.charges.create(body)
  return c.json(charge, 201)
})
`

const LEDGER_CUSTOMERS = `import { Hono } from "hono"
import { db } from "../db"

export const customers = new Hono()

customers.get("/:id", async (c) => {
  const customer = await db.customers.find(c.req.param("id"))
  if (!customer) return c.json({ error: "not_found" }, 404)
  return c.json(customer)
})
`

const LEDGER_AUTH = `import type { MiddlewareHandler } from "hono"

export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const key = c.req.header("authorization")?.replace(/^Bearer /, "")
  if (!key || !(await isValidKey(key))) {
    return c.json({ error: "invalid_api_key" }, 401)
  }
  await next()
}

async function isValidKey(key: string) {
  return key.startsWith("sk_live_") || key.startsWith("sk_test_")
}
`

const LEDGER_PACKAGE = `{
  "name": "ledger-api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "hono": "^4.9.0",
    "zod": "^4.1.0"
  }
}
`

const LEDGER_RATE_LIMIT = `import type { MiddlewareHandler } from "hono"

interface Window {
  count: number
  resetAt: number
}

/**
 * Fixed-window limit per API key. In memory, so each instance counts on its
 * own; fine for one box, not for a fleet.
 */
export function rateLimit(options: { limit: number; windowMs: number }): MiddlewareHandler {
  const windows = new Map<string, Window>()

  return async (c, next) => {
    const key = c.req.header("authorization") ?? "anonymous"
    const now = Date.now()
    const window = windows.get(key)

    if (!window || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs })
    } else if (window.count >= options.limit) {
      c.header("Retry-After", String(Math.ceil((window.resetAt - now) / 1000)))
      return c.json({ error: "rate_limited" }, 429)
    } else {
      window.count += 1
    }

    await next()
  }
}
`

// ---------------------------------------------------------------------------
// portfolio: a personal site
// ---------------------------------------------------------------------------

const PORTFOLIO = projectPath("portfolio")

const PORTFOLIO_INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Sam Rivera</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <section class="hero">
      <img src="/images/hero.jpg" alt="Sunset over the harbor" />
      <h1>Hi, I'm Sam. I build calm software.</h1>
    </section>
  </body>
</html>
`

const PORTFOLIO_STYLES = `.hero {
  display: grid;
  place-items: center;
}

.hero img {
  width: 100%;
  object-fit: cover;
}
`

export const DEMO_PROJECTS: DemoProjectSeed[] = [
  {
    id: "demo-project-tidepool",
    title: "tidepool",
    localPath: TIDEPOOL,
    repoOwner: "you",
    branchName: "main",
    entryFile: "src/App.tsx",
    files: {
      "README.md": TIDEPOOL_README,
      "package.json": TIDEPOOL_PACKAGE,
      "src/App.tsx": TIDEPOOL_APP,
      "src/components/ForecastCard.tsx": TIDEPOOL_FORECAST_CARD,
      "src/components/TideChart.tsx": TIDEPOOL_TIDE_CHART,
      "src/lib/types.ts": TIDEPOOL_TYPES,
      "src/lib/units.ts": TIDEPOOL_UNITS,
    },
  },
  {
    id: "demo-project-ledger",
    title: "ledger-api",
    localPath: LEDGER,
    repoOwner: "you",
    branchName: "docs/readme",
    entryFile: "src/index.ts",
    files: {
      "package.json": LEDGER_PACKAGE,
      "src/index.ts": LEDGER_INDEX,
      "src/middleware/auth.ts": LEDGER_AUTH,
      "src/routes/charges.ts": LEDGER_CHARGES,
      "src/routes/customers.ts": LEDGER_CUSTOMERS,
    },
  },
  {
    id: "demo-project-portfolio",
    title: "portfolio",
    localPath: PORTFOLIO,
    repoOwner: "you",
    branchName: "main",
    entryFile: "index.html",
    files: {
      "index.html": PORTFOLIO_INDEX,
      "styles.css": PORTFOLIO_STYLES,
    },
  },
]

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

function unitsToggleTurn(): DemoTurn {
  const prompt = "The forecast card only shows wave height in feet. Add a toggle so people can switch to meters, and remember their choice."
  const script = new TurnScript("claude", "opus")
    .init()
    .say("I'll start with how the card formats heights today.", 900)
    .grep("formatFeet", [
      "src/components/ForecastCard.tsx:1:import { formatFeet } from \"../lib/units\"",
      "src/components/ForecastCard.tsx:11:      <p className=\"wave-height\">{formatFeet(forecast.waveHeightM)}</p>",
      "src/lib/units.ts:3:export function formatFeet(meters: number) {",
    ].join("\n"))
    .read("src/components/ForecastCard.tsx", TIDEPOOL_FORECAST_CARD, `${TIDEPOOL}/src/components/ForecastCard.tsx`)
    .read("src/lib/units.ts", TIDEPOOL_UNITS, `${TIDEPOOL}/src/lib/units.ts`)
    .todos([
      todo("Replace formatFeet with a unit-aware formatHeight", "Replacing formatFeet", "in_progress"),
      todo("Persist the chosen unit", "Persisting the chosen unit", "pending"),
      todo("Add the ft/m toggle to ForecastCard", "Adding the toggle", "pending"),
      todo("Cover formatHeight with tests", "Writing tests", "pending"),
    ])
    .edit(
      "src/lib/units.ts",
      `${TIDEPOOL}/src/lib/units.ts`,
      "export function formatFeet(meters: number) {\n  return `${(meters * FEET_PER_METER).toFixed(1)} ft`\n}",
      "export type HeightUnit = \"ft\" | \"m\"\n\nexport function formatHeight(meters: number, unit: HeightUnit) {\n  if (unit === \"m\") return `${meters.toFixed(1)} m`\n  return `${(meters * FEET_PER_METER).toFixed(1)} ft`\n}",
    )
    .write("src/hooks/useHeightUnit.ts", `${TIDEPOOL}/src/hooks/useHeightUnit.ts`, `import { useEffect, useState } from "react"
import type { HeightUnit } from "../lib/units"

const STORAGE_KEY = "tidepool:height-unit"

function readStoredUnit(): HeightUnit {
  return localStorage.getItem(STORAGE_KEY) === "m" ? "m" : "ft"
}

export function useHeightUnit() {
  const [unit, setUnit] = useState<HeightUnit>(readStoredUnit)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, unit)
  }, [unit])

  const toggle = () => setUnit((current) => (current === "ft" ? "m" : "ft"))
  return { unit, toggle }
}
`)
    .edit(
      "src/components/ForecastCard.tsx",
      `${TIDEPOOL}/src/components/ForecastCard.tsx`,
      "import { formatFeet } from \"../lib/units\"\nimport type { Forecast } from \"../lib/types\"",
      "import { formatHeight } from \"../lib/units\"\nimport type { Forecast } from \"../lib/types\"\nimport { useHeightUnit } from \"../hooks/useHeightUnit\"",
    )
    .edit(
      "src/components/ForecastCard.tsx",
      `${TIDEPOOL}/src/components/ForecastCard.tsx`,
      "export function ForecastCard({ forecast }: { forecast: Forecast }) {\n  return (",
      "export function ForecastCard({ forecast }: { forecast: Forecast }) {\n  const { unit, toggle } = useHeightUnit()\n  return (",
    )
    .edit(
      "src/components/ForecastCard.tsx",
      `${TIDEPOOL}/src/components/ForecastCard.tsx`,
      "      <p className=\"wave-height\">{formatFeet(forecast.waveHeightM)}</p>",
      "      <p className=\"wave-height\">\n        {formatHeight(forecast.waveHeightM, unit)}\n        <button type=\"button\" onClick={toggle} aria-label=\"Switch height unit\">\n          {unit === \"ft\" ? \"m\" : \"ft\"}\n        </button>\n      </p>",
    )
    .write("src/lib/units.test.ts", `${TIDEPOOL}/src/lib/units.test.ts`, `import { describe, expect, test } from "bun:test"
import { formatHeight } from "./units"

describe("formatHeight", () => {
  test("converts meters to feet", () => {
    expect(formatHeight(1.5, "ft")).toBe("4.9 ft")
  })

  test("keeps meters as meters", () => {
    expect(formatHeight(1.5, "m")).toBe("1.5 m")
  })
})
`)
    .bash("bun test src/lib", "Run the units tests", [
      "bun test v1.3.5",
      "",
      "src/lib/units.test.ts:",
      "✓ formatHeight > converts meters to feet [0.21ms]",
      "✓ formatHeight > keeps meters as meters [0.04ms]",
      "",
      " 2 pass",
      " 0 fail",
      " 2 expect() calls",
      "Ran 2 tests across 1 file. [18.00ms]",
    ].join("\n"))
    .todos([
      todo("Replace formatFeet with a unit-aware formatHeight", "Replacing formatFeet", "completed"),
      todo("Persist the chosen unit", "Persisting the chosen unit", "completed"),
      todo("Add the ft/m toggle to ForecastCard", "Adding the toggle", "completed"),
      todo("Cover formatHeight with tests", "Writing tests", "completed"),
    ])
  const summary = [
    "Wave heights now switch between feet and meters, and the choice survives a reload.",
    "",
    "- **`formatHeight`** replaces `formatFeet` in `src/lib/units.ts` and takes the unit to show.",
    "- **`useHeightUnit`** (`src/hooks/useHeightUnit.ts`) keeps the choice in `localStorage`.",
    "- **`ForecastCard`** has a small ft/m button beside the height.",
    "",
    "`bun test src/lib` passes. `formatFeet` had no other callers, so nothing else needed to change.",
  ].join("\n")
  script.say(summary, 1300).finish(summary, { usedTokens: 38_412, maxTokens: 1_000_000 })
  return { prompt, provider: "claude", model: "opus", steps: script.steps }
}

function safariTideChartTurn(): DemoTurn {
  const prompt = "The tide chart is blank in Safari but fine in Chrome. Can you figure out why?"
  const script = new TurnScript("codex", "gpt-5.6-sol")
    .init()
    .say("A chart that renders in Chrome but not Safari is usually date parsing. Checking how the chart reads its timestamps.", 1000)
    .grep("new Date\\(", "src/components/TideChart.tsx:7:  const times = points.map((point) => new Date(point.time).getTime())")
    .read("src/lib/types.ts", TIDEPOOL_TYPES, `${TIDEPOOL}/src/lib/types.ts`)
    .say("That's it. The API sends `\"2026-09-26 06:00\"`, with a space instead of a `T`. Chrome parses that; Safari returns `Invalid Date`, and a single `NaN` in the SVG path makes Safari drop the whole path.", 1400)
    .edit(
      "src/components/TideChart.tsx",
      `${TIDEPOOL}/src/components/TideChart.tsx`,
      "  const times = points.map((point) => new Date(point.time).getTime())",
      "  const times = points.map((point) => parseTideTime(point.time))",
    )
    .edit(
      "src/components/TideChart.tsx",
      `${TIDEPOOL}/src/components/TideChart.tsx`,
      "const HEIGHT = 96\n",
      "const HEIGHT = 96\n\n// The tide API sends \"2026-09-26 06:00\". Chrome parses that; Safari returns\n// Invalid Date, and one NaN in the path makes Safari draw nothing at all.\nfunction parseTideTime(value: string) {\n  return new Date(value.replace(\" \", \"T\")).getTime()\n}\n",
    )
    .bash("bun test", "Run the test suite", [
      "bun test v1.3.5",
      "",
      "src/components/TideChart.test.tsx:",
      "✓ TideChart > draws one segment per tide point [3.12ms]",
      "✓ TideChart > parses the API's space-separated times [0.38ms]",
      "",
      " 2 pass",
      " 0 fail",
      "Ran 2 tests across 1 file. [41.00ms]",
    ].join("\n"))
  const summary = [
    "Fixed. Safari can't parse the tide API's `\"2026-09-26 06:00\"` timestamps, so every point became `NaN` and the path came out empty.",
    "",
    "`TideChart` now goes through `parseTideTime`, which swaps the space for a `T` so both engines read it as ISO 8601. The comment beside it says why, so nobody \"simplifies\" it back.",
  ].join("\n")
  script.say(summary, 1200).finish(summary, { usedTokens: 21_906, maxTokens: 400_000 })
  return { prompt, provider: "codex", model: "gpt-5.6-sol", steps: script.steps }
}

const DEPLOY_WORKFLOWS: Record<string, string> = {
  "Cloudflare Pages": `name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: pages deploy dist --project-name=tidepool
`,
  Vercel: `name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx vercel deploy --prod --token=\${{ secrets.VERCEL_TOKEN }}
`,
  Netlify: `name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: bunx netlify deploy --prod --dir=dist
        env:
          NETLIFY_AUTH_TOKEN: \${{ secrets.NETLIFY_AUTH_TOKEN }}
`,
}

const DEPLOY_SECRETS: Record<string, string> = {
  "Cloudflare Pages": "CLOUDFLARE_API_TOKEN",
  Vercel: "VERCEL_TOKEN",
  Netlify: "NETLIFY_AUTH_TOKEN",
}

function deployTurn(): DemoTurn {
  const prompt = "Set up automatic deploys whenever I push to main."
  const script = new TurnScript("claude", "opus")
    .init()
    .say("I'll check what the build produces before picking a setup.", 900)
    .read("package.json", TIDEPOOL_PACKAGE, `${TIDEPOOL}/package.json`)
    .bash("bun run build", "Build the app", [
      "$ tsc -b && vite build",
      "vite v7.1.4 building for production...",
      "✓ 38 modules transformed.",
      "dist/index.html                   0.46 kB │ gzip:  0.30 kB",
      "dist/assets/index-B7kQ2mXa.css    3.12 kB │ gzip:  1.18 kB",
      "dist/assets/index-Dq1P9vLr.js   196.40 kB │ gzip: 61.87 kB",
      "✓ built in 612ms",
    ].join("\n"), 2200)
    .say("It's a static build in `dist/`, so any static host works. One question before I write the workflow.", 900)
    .ask({
      header: "Host",
      question: "Where should tidepool deploy?",
      options: [
        { label: "Cloudflare Pages", description: "Static hosting on Cloudflare's edge. The free tier covers this app." },
        { label: "Vercel", description: "Git-connected deploys with a preview URL for every branch." },
        { label: "Netlify", description: "Much like Vercel; the build runs on Netlify's side." },
      ],
    }, (answer) => {
      const host = DEPLOY_WORKFLOWS[answer] ? answer : "Cloudflare Pages"
      const secret = DEPLOY_SECRETS[host]!
      const summary = [
        `Every push to \`main\` now builds tidepool and deploys it to ${host}.`,
        "",
        `The workflow is in \`.github/workflows/deploy.yml\`. It needs one repository secret, \`${secret}\`, before the first run. Add it under **Settings → Secrets and variables → Actions**.`,
      ].join("\n")
      return new TurnScript("claude", "opus")
        .say(`${host} it is. I'll add a GitHub Actions workflow that builds and deploys on every push to \`main\`.`, 900)
        .write(".github/workflows/deploy.yml", `${TIDEPOOL}/.github/workflows/deploy.yml`, DEPLOY_WORKFLOWS[host]!)
        .say(summary, 1200)
        .finish(summary, { usedTokens: 17_330, maxTokens: 1_000_000 })
        .steps
    })
  return { prompt, provider: "claude", model: "opus", steps: script.steps }
}

const LEDGER_README = `# ledger-api

A small payments API: customers and charges, behind API-key auth.

## Setup

\`\`\`sh
bun install
bun run dev     # http://localhost:8787
bun test
\`\`\`

\`PORT\` overrides the port.

## Authentication

Every \`/v1\` route needs an API key as a bearer token. Keys start with
\`sk_live_\` or \`sk_test_\`.

\`\`\`sh
curl -H "Authorization: Bearer sk_test_123" http://localhost:8787/v1/charges
\`\`\`

A missing or unknown key gets \`401 {"error": "invalid_api_key"}\`.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| \`GET\` | \`/health\` | No auth. |
| \`GET\` | \`/v1/charges\` | The 50 most recent charges. |
| \`POST\` | \`/v1/charges\` | \`customerId\`, \`amountCents\`, \`currency\` (\`usd\`, \`eur\`, \`gbp\`). Limited to 20 requests a minute per key. |
| \`GET\` | \`/v1/customers/:id\` | \`404\` when the customer doesn't exist. |
`

function readmeTurn(): DemoTurn {
  const prompt = "Write a README for this API: setup, auth, and the endpoints."
  const script = new TurnScript("claude", "opus")
    .init()
    .say("I'll map the routes before writing anything.", 800)
    .glob("src/**/*.ts", [
      `${LEDGER}/src/index.ts`,
      `${LEDGER}/src/middleware/auth.ts`,
      `${LEDGER}/src/middleware/rateLimit.ts`,
      `${LEDGER}/src/routes/charges.ts`,
      `${LEDGER}/src/routes/customers.ts`,
    ].join("\n"))
    .read("src/index.ts", LEDGER_INDEX, `${LEDGER}/src/index.ts`)
    .read("src/middleware/auth.ts", LEDGER_AUTH, `${LEDGER}/src/middleware/auth.ts`)
    .read("src/routes/charges.ts", LEDGER_CHARGES, `${LEDGER}/src/routes/charges.ts`)
    .read("package.json", LEDGER_PACKAGE, `${LEDGER}/package.json`)
    .say("Four routes, one auth scheme, and a rate limit on creating charges. Writing it up.", 1200)
    .write("README.md", `${LEDGER}/README.md`, LEDGER_README)
  const summary = [
    "Added `README.md` with setup, authentication, and a table of every endpoint.",
    "",
    "I took the details from the code rather than guessing: the key prefixes come from `isValidKey`, the 50-row page from `GET /v1/charges`, and the 20-per-minute limit from the `rateLimit` call on `POST /v1/charges`.",
  ].join("\n")
  script.say(summary, 1400).finish(summary, { usedTokens: 26_118, maxTokens: 1_000_000 })
  return { prompt, provider: "claude", model: "opus", steps: script.steps }
}

function rateLimitTurn(): DemoTurn {
  const prompt = "Add rate limiting to POST /v1/charges, 20 requests a minute per API key."
  const script = new TurnScript("codex", "gpt-5.6-sol")
    .init()
    .read("src/routes/charges.ts", LEDGER_CHARGES, `${LEDGER}/src/routes/charges.ts`)
    .grep("rateLimit|ratelimit", "No matches found")
    .say("There's no limiter yet, so I'll add a small middleware rather than pull in a dependency.", 900)
    .write("src/middleware/rateLimit.ts", `${LEDGER}/src/middleware/rateLimit.ts`, LEDGER_RATE_LIMIT)
    .edit(
      "src/routes/charges.ts",
      `${LEDGER}/src/routes/charges.ts`,
      "import { db } from \"../db\"\n",
      "import { db } from \"../db\"\nimport { rateLimit } from \"../middleware/rateLimit\"\n",
    )
    .edit(
      "src/routes/charges.ts",
      `${LEDGER}/src/routes/charges.ts`,
      "charges.post(\"/\", async (c) => {",
      "charges.post(\"/\", rateLimit({ limit: 20, windowMs: 60_000 }), async (c) => {",
    )
    .bash("bun test", "Run the test suite", [
      "bun test v1.3.5",
      "",
      "src/routes/charges.test.ts:",
      "✓ POST /v1/charges > creates a charge [4.80ms]",
      "✓ POST /v1/charges > returns 429 after 20 requests [2.11ms]",
      "✓ POST /v1/charges > counts each API key separately [1.02ms]",
      "",
      " 3 pass",
      " 0 fail",
      "Ran 3 tests across 1 file. [52.00ms]",
    ].join("\n"))
  const summary = [
    "`POST /v1/charges` now allows 20 requests a minute per API key and answers `429` with a `Retry-After` header past that.",
    "",
    "The limiter lives in `src/middleware/rateLimit.ts` and keeps its counts in memory, so each instance limits on its own. That's fine on one server; behind a load balancer it would need a shared store.",
  ].join("\n")
  script.say(summary, 1200).finish(summary, { usedTokens: 19_774, maxTokens: 400_000 })
  return { prompt, provider: "codex", model: "gpt-5.6-sol", steps: script.steps }
}

function heroImageTurn(): DemoTurn {
  const prompt = "The hero image on my site takes forever to show up. Make it load faster."
  const script = new TurnScript("cursor", "composer-2.5")
    .init()
    .read("index.html", PORTFOLIO_INDEX, `${PORTFOLIO}/index.html`)
    .say("The browser discovers the hero late, fetches it at normal priority, and doesn't know its size until it arrives. All three are fixable in the markup.", 1000)
    .edit(
      "index.html",
      `${PORTFOLIO}/index.html`,
      "      <img src=\"/images/hero.jpg\" alt=\"Sunset over the harbor\" />",
      "      <img\n        src=\"/images/hero.jpg\"\n        alt=\"Sunset over the harbor\"\n        width=\"1600\"\n        height=\"900\"\n        fetchpriority=\"high\"\n        decoding=\"async\"\n      />",
    )
    .edit(
      "index.html",
      `${PORTFOLIO}/index.html`,
      "    <link rel=\"stylesheet\" href=\"/styles.css\" />",
      "    <link rel=\"stylesheet\" href=\"/styles.css\" />\n    <link rel=\"preload\" as=\"image\" href=\"/images/hero.jpg\" fetchpriority=\"high\" />",
    )
  const summary = [
    "The hero now starts downloading as soon as the page does:",
    "",
    "- a `preload` in `<head>`, so the browser doesn't wait to find the `<img>`",
    "- `fetchpriority=\"high\"`, so it goes ahead of other images",
    "- `width` and `height`, so the layout doesn't jump when it lands",
  ].join("\n")
  script.say(summary, 1100).finish(summary, { usedTokens: 12_450, maxTokens: 200_000 })
  return { prompt, provider: "cursor", model: "composer-2.5", steps: script.steps }
}

/** The chat the demo opens on. */
export const DEMO_FEATURED_CHAT_ID = "demo-chat-units"

// Order matters: each project's chats replay in this order onto one working
// tree, and `commitAfter` snapshots it as the new HEAD.
export function createDemoChats(): DemoChatSeed[] {
  return [
    {
      id: "demo-chat-safari",
      projectId: "demo-project-tidepool",
      title: "Fix blank tide chart in Safari",
      turns: [safariTideChartTurn()],
      minutesAgo: 48,
      unread: true,
      commitAfter: true,
    },
    {
      id: DEMO_FEATURED_CHAT_ID,
      projectId: "demo-project-tidepool",
      title: "Add a feet/meters toggle",
      turns: [unitsToggleTurn()],
      minutesAgo: 4,
    },
    {
      id: "demo-chat-deploy",
      projectId: "demo-project-tidepool",
      title: "Set up deploys on push",
      turns: [deployTurn()],
      minutesAgo: 12,
    },
    {
      id: "demo-chat-rate-limit",
      projectId: "demo-project-ledger",
      title: "Rate limit charge creation",
      turns: [rateLimitTurn()],
      minutesAgo: 190,
      commitAfter: true,
    },
    {
      id: "demo-chat-readme",
      projectId: "demo-project-ledger",
      title: "Write the API README",
      turns: [readmeTurn()],
      minutesAgo: 1,
      liveFromStep: 5,
    },
    {
      id: "demo-chat-hero",
      projectId: "demo-project-portfolio",
      title: "Speed up the hero image",
      turns: [heroImageTurn()],
      minutesAgo: 60 * 26,
      commitAfter: true,
    },
  ]
}

// ---------------------------------------------------------------------------
// The scripted reply to anything a visitor types
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "before", "could", "does", "doesn't", "from", "have", "into",
  "just", "make", "more", "only", "please", "should", "some", "than", "that", "their", "them", "then",
  "there", "these", "they", "this", "what", "when", "where", "which", "while", "will", "with", "would", "your",
])

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok Build",
  pi: "Pi",
}

function pickKeyword(prompt: string) {
  const words = prompt.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []
  return words
    .filter((word) => !STOP_WORDS.has(word))
    .sort((left, right) => right.length - left.length)[0] ?? null
}

function grepFiles(files: ReadonlyMap<string, string>, keyword: string) {
  const hits: Array<{ path: string; line: number; text: string }> = []
  for (const [path, content] of files) {
    content.split("\n").forEach((text, index) => {
      if (text.toLowerCase().includes(keyword)) hits.push({ path, line: index + 1, text })
    })
  }
  return hits
}

export function titleFromPrompt(prompt: string) {
  const firstLine = prompt.trim().split("\n")[0] ?? ""
  const words = firstLine.replace(/[.?!]+$/, "").split(/\s+/).slice(0, 7).join(" ")
  const title = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words
  return title ? title[0]!.toUpperCase() + title.slice(1) : "New chat"
}

export interface ScriptedReplyContext {
  prompt: string
  provider: AgentProvider
  model: string
  project: DemoProjectSeed
  files: ReadonlyMap<string, string>
  /** `git status --short` as it will read once PLAN.md is written. */
  gitStatusAfterPlan: string
  firstTurn: boolean
}

/**
 * Nothing real can answer a visitor's prompt, so the reply says so, and
 * then runs a turn that is honest about its own work: the grep searches
 * the demo project's actual files, the plan it writes shows up in the diff
 * panel, and `git status` reports the real demo tree.
 */
export function composeScriptedReply(context: ScriptedReplyContext): DemoTurn {
  const { prompt, provider, model, project, files } = context
  const script = new TurnScript(provider, model)
  if (context.firstTurn) script.init()

  const keyword = pickKeyword(prompt)
  script.say(`Let me look for where this lives in ${project.title}.`, 900)

  const hits = keyword ? grepFiles(files, keyword) : []
  if (keyword) {
    script.grep(keyword, hits.length > 0
      ? hits.slice(0, 6).map((hit) => `${hit.path}:${hit.line}:${hit.text}`).join("\n")
      : "No matches found")
  }

  const readPath = hits[0]?.path ?? project.entryFile
  script.read(readPath, files.get(readPath) ?? "", `${project.localPath}/${readPath}`)

  const planTitle = prompt.trim().split("\n")[0]!.slice(0, 80)
  script.todos([
    todo("Find the code this touches", "Finding the code this touches", "completed"),
    todo("Write up a plan", "Writing up a plan", "in_progress"),
    todo("Check the working tree", "Checking the working tree", "pending"),
  ])
  script.write("PLAN.md", `${project.localPath}/PLAN.md`, [
    `# Plan: ${planTitle}`,
    "",
    `1. Start in \`${readPath}\`${hits.length > 0 ? `, where "${keyword}" shows up` : ""}.`,
    "2. Make the change in small edits that are easy to review.",
    "3. Add or update tests that cover it.",
    "4. Run the tests and read the diff before committing.",
    "",
  ].join("\n"))
  script.bash("git status --short", "Show the working tree", context.gitStatusAfterPlan, 500)
  script.todos([
    todo("Find the code this touches", "Finding the code this touches", "completed"),
    todo("Write up a plan", "Writing up a plan", "completed"),
    todo("Check the working tree", "Checking the working tree", "completed"),
  ])

  const summary = [
    "I wrote a plan to `PLAN.md`. You can see it in the diff panel on the right.",
    "",
    `This chat is part of Kanna's in-browser demo, so a script is answering instead of ${PROVIDER_LABELS[provider]}. With Kanna installed, the agent works on your real code: it reads and edits files, runs commands, and asks you when it needs a decision.`,
    "",
    "```sh",
    "bun install -g kanna-code",
    "```",
  ].join("\n")
  script.say(summary, 1200).finish(summary, { usedTokens: 9_000 + prompt.length * 4, maxTokens: 1_000_000 })
  return { prompt, provider, model, steps: script.steps }
}

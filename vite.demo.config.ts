import path from "node:path"
import { rm } from "node:fs/promises"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { messageScrollerPatch } from "./vite-plugin-message-scroller"

// The playable demo on kanna.sh: the real client on a fake in-browser backend
// (src/demo). kanna-site copies this folder into its public/demo.
const DEMO_OUT_DIR = path.resolve(import.meta.dirname, "dist/demo")
const UNUSED_PUBLIC_ENTRIES = [
  ".DS_Store",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "manifest.webmanifest",
  "screenshot-light.png",
  "screenshot.png",
]

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/demo"),
  plugins: [
    messageScrollerPatch(),
    react(),
    {
      name: "prune-demo-public-assets",
      async closeBundle() {
        await Promise.all(
          UNUSED_PUBLIC_ENTRIES.map((entry) =>
            rm(path.join(DEMO_OUT_DIR, entry), { force: true, recursive: true }),
          ),
        )
      },
    },
  ],
  publicDir: path.resolve(import.meta.dirname, "public"),
  base: "./",
  build: {
    outDir: DEMO_OUT_DIR,
    emptyOutDir: true,
  },
})

#!/bin/bash
# Build the Debug app and open it.
#
#   ./run.sh              keeps the last choice (Debug builds start in Development)
#   ./run.sh --dev        this checkout's `bun run dev`: Vite on 5174, ~/.kanna-dev
#   ./run.sh --installed  the globally installed `kanna`, as users get it
#
# Developer › Installed Kanna / Development Checkout switches the same setting
# from inside the app. Either way the app adopts a server that is already
# running (a terminal's `kanna` or `bun run dev`) instead of starting its own.
set -euo pipefail
cd "$(dirname "$0")"
APP=build/debug/Build/Products/Debug/Kanna.app

case "${1:-}" in
  --dev) defaults write sh.kanna.mac serverMode development ;;
  --installed) defaults write sh.kanna.mac serverMode installed ;;
  "") ;;
  *) echo "usage: run.sh [--dev|--installed]" >&2; exit 1 ;;
esac

xcodegen generate --quiet
xcodebuild -project Kanna.xcodeproj -scheme Kanna -configuration Debug \
  -derivedDataPath build/debug -quiet build

pkill -x Kanna || true
open "$APP"

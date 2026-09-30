#!/bin/bash
# Removes Kanna from this Mac: Kanna for Mac (and Kanna Dev), the kanna
# command, Kanna's data, the app's preferences, web data and logs, its
# permissions, and this Mac's Kanna Cloud pairing. Optionally Bun and the
# agent CLIs the setup wizard installs.
#
# Kanna › Uninstall Kanna… runs this from the app bundle (src/uninstall.ts),
# with the user's choices as flags. By hand:
#
#   bash uninstall.sh              Kanna, its data and Bun; asks first
#   bash uninstall.sh --agents     also every agent CLI below, and its sign-in
#   bash uninstall.sh --keep-bun   leave Bun (remove only kanna-code)
#
# Choices:
#   --keep-cli      keep the kanna command (kanna-code), and so Bun, which
#                   it's installed in
#   --keep-data     keep ~/.kanna (chats, projects, settings)
#   --keep-cloud    keep this Mac in the Fleet on kanna.sh
#   --keep-bun      keep Bun
#   --claude --codex --cursor --gh --grok   remove that CLI and its sign-in
#   --agents        all five
# From the app:
#   --yes           don't ask
#   --after-pid N   wait for process N (the app) to quit before removing it
#   --app PATH      also remove this app bundle, wherever it is
set -u

YES=false
KEEP_CLI=false
KEEP_DATA=false
KEEP_CLOUD=false
KEEP_BUN=false
AFTER_PID=""
APP_PATH=""
CLAUDE=false CODEX=false CURSOR=false GH=false GROK=false
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=true ;;
    --keep-cli) KEEP_CLI=true ;;
    --keep-data) KEEP_DATA=true ;;
    --keep-cloud) KEEP_CLOUD=true ;;
    --keep-bun) KEEP_BUN=true ;;
    --claude) CLAUDE=true ;;
    --codex) CODEX=true ;;
    --cursor) CURSOR=true ;;
    --gh) GH=true ;;
    --grok) GROK=true ;;
    --agents) CLAUDE=true CODEX=true CURSOR=true GH=true GROK=true ;;
    --after-pid) shift; AFTER_PID="${1:-}" ;;
    --app) shift; APP_PATH="${1:-}" ;;
    *) echo "unknown option: $1 (see the top of this file)" >&2; exit 1 ;;
  esac
  shift
done

# kanna-code lives in Bun's global folder: removing Bun removes it too.
$KEEP_CLI && KEEP_BUN=true

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

if ! $YES; then
  echo "This removes Kanna from this Mac."
  $KEEP_DATA || echo "It also deletes your chats, projects and settings (~/.kanna)."
  $KEEP_BUN || echo "It also removes Bun (~/.bun) and its lines in your shell profiles."
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Nothing removed."; exit 0; }
fi

export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if [ -n "$AFTER_PID" ]; then
  step "Waiting for Kanna to quit"
  for _ in $(seq 1 60); do
    kill -0 "$AFTER_PID" 2>/dev/null || break
    sleep 0.5
  done
fi

if ! $KEEP_CLOUD; then
  step "Taking this Mac off Kanna Cloud"
  # Frees its kanna.sh address and removes its tunnel and DNS record. Needs
  # kanna and cloud.json, so it goes first.
  if command -v kanna >/dev/null 2>&1 && [ -f "$HOME/.kanna/cloud.json" ]; then
    kanna pair --remove || echo "  kanna pair --remove failed; delete this Mac at https://kanna.sh/fleet instead."
  else
    echo "  Not paired (or kanna is already gone). If it's still listed, delete it at https://kanna.sh/fleet."
  fi
fi

step "Quitting Kanna"
# A server kept running after the app quit, or a terminal's: stopped
# cleanly first. pkill below catches a kanna from before `kanna stop`.
command -v kanna >/dev/null 2>&1 && kanna stop >/dev/null 2>&1
osascript -e 'tell application id "sh.kanna.mac" to quit' >/dev/null 2>&1
osascript -e 'tell application id "sh.kanna.mac.dev" to quit' >/dev/null 2>&1
sleep 1
pkill -f "Kanna.app/Contents/MacOS" 2>/dev/null
pkill -f "Kanna Dev.app/Contents/MacOS" 2>/dev/null
pkill -f "kanna-code" 2>/dev/null
echo "  Done."

step "Removing the apps"
rm -rf /Applications/Kanna.app "/Applications/Kanna Dev.app" "$HOME/Applications/Kanna.app"
# The copy that ran this, if it lives somewhere else (Downloads, a build).
case "$APP_PATH" in
  *.app) rm -rf "$APP_PATH" ;;
esac
echo "  Done."

if ! $KEEP_CLI; then
  step "Removing the kanna command$($KEEP_BUN || echo " and Bun")"
  command -v bun >/dev/null 2>&1 && bun remove -g kanna-code >/dev/null 2>&1
  command -v npm >/dev/null 2>&1 && npm uninstall -g kanna-code >/dev/null 2>&1
fi
if ! $KEEP_BUN; then
  rm -rf "$HOME/.bun"
  # Bun's installer adds a "# bun" block (BUN_INSTALL, PATH, completions).
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$rc" ] || continue
    if grep -qE 'BUN_INSTALL|\.bun/_bun|^# bun( completions)?$' "$rc"; then
      cp "$rc" "$rc.before-kanna-uninstall"
      sed -i '' -E '/BUN_INSTALL|\.bun\/_bun|^# bun( completions)?$/d' "$rc"
      echo "  Removed Bun's lines from $rc (backup: $rc.before-kanna-uninstall)"
    fi
  done
fi
$KEEP_CLI || echo "  Done."

step "Removing Kanna's $($KEEP_DATA || echo "data, ")preferences, web data and logs"
$KEEP_DATA || rm -rf "$HOME/.kanna" "$HOME/.kanna-dev"
defaults delete sh.kanna.mac >/dev/null 2>&1
defaults delete sh.kanna.mac.dev >/dev/null 2>&1
# The app's settings and web data live in Application Support/Kanna (Kanna
# Dev: `bun run start` in macos/); the rest is from the WKWebView app it was
# until 2.0.
rm -rf "$HOME"/Library/"Application Support"/Kanna \
       "$HOME"/Library/"Application Support"/"Kanna Dev" \
       "$HOME"/Library/Caches/sh.kanna.mac* \
       "$HOME"/Library/WebKit/sh.kanna.mac* \
       "$HOME"/Library/HTTPStorages/sh.kanna.mac* \
       "$HOME"/Library/"Saved Application State"/sh.kanna.mac*.savedState \
       "$HOME"/Library/"Application Support"/sh.kanna.mac* \
       "$HOME"/Library/Logs/Kanna
echo "  Done."

step "Resetting permissions"
# Full Disk Access, microphone and the other privacy grants.
tccutil reset All sh.kanna.mac >/dev/null 2>&1
tccutil reset All sh.kanna.mac.dev >/dev/null 2>&1
# The kanna.sh sign-in that app versions up to 1.1.0 kept. The app deletes
# it itself before running this; by hand macOS may ask to allow it.
while security delete-generic-password -s sh.kanna.cloud >/dev/null 2>&1; do :; done
echo "  Done."

if $CLAUDE || $CODEX || $CURSOR || $GH || $GROK; then
  step "Removing agent CLIs"
  if $CLAUDE; then
    rm -rf "$HOME/.local/bin/claude" "$HOME/.local/share/claude" "$HOME/.claude" "$HOME/.claude.json"
    echo "  Claude Code"
  fi
  if $CODEX; then
    command -v npm >/dev/null 2>&1 && npm uninstall -g @openai/codex >/dev/null 2>&1
    command -v bun >/dev/null 2>&1 && bun remove -g @openai/codex >/dev/null 2>&1
    rm -rf "$HOME/.codex"
    echo "  Codex"
  fi
  if $CURSOR; then
    # ~/.cursor stays: the Cursor editor keeps its settings there too.
    rm -rf "$HOME/.local/bin/cursor-agent" "$HOME/.local/share/cursor-agent"
    echo "  Cursor CLI"
  fi
  if $GH; then
    command -v brew >/dev/null 2>&1 && brew uninstall gh >/dev/null 2>&1
    rm -f "$HOME/.local/bin/gh"
    rm -rf "$HOME/.config/gh"
    echo "  GitHub CLI"
  fi
  if $GROK; then
    rm -rf "$HOME/.local/bin/grok" "$HOME/.grok"
    echo "  Grok"
  fi
fi

if [ -t 1 ]; then
  step "Left for you"
  echo "  - System Settings › General › Login Items: remove Kanna if it's still listed (opening it now)."
  echo "  - System Settings › Notifications: remove Kanna for a fresh notifications prompt."
  echo "  - Open a new terminal: this one still has the old PATH."
  open "x-apple.systempreferences:com.apple.LoginItems-Settings.extension" >/dev/null 2>&1
fi

step "Check"
left=""
for path in /Applications/Kanna.app "$HOME/Library/Preferences/sh.kanna.mac.plist"; do
  [ -e "$path" ] && left="$left\n  $path"
done
$KEEP_DATA || { [ -e "$HOME/.kanna" ] && left="$left\n  $HOME/.kanna"; }
$KEEP_BUN || { [ -e "$HOME/.bun" ] && left="$left\n  $HOME/.bun"; }
if [ -n "$left" ]; then
  printf "  Still here:%b\n" "$left"
  message="Kanna is uninstalled, but a few files are left. See /tmp/kanna-uninstall.log."
else
  echo "  Kanna is gone. Start over at https://kanna.sh/downloads/mac/Kanna.dmg"
  message="Kanna is uninstalled."
fi
# From the app, nothing is left on screen to say it finished.
if $YES; then
  osascript -e "display notification \"$message\" with title \"Kanna\"" >/dev/null 2>&1
fi

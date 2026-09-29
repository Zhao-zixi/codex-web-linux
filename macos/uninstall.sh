#!/bin/bash
# Removes Kanna from this Mac completely, to test the first-run flow from
# scratch: Kanna for Mac (and Kanna Dev), the kanna command and the Bun it
# came with, all of Kanna's data, the app's preferences, web data and logs,
# its permissions and Keychain item, and this Mac's Kanna Cloud pairing.
#
#   bash uninstall.sh            everything above
#   bash uninstall.sh --agents   also the agent CLIs the setup wizard installs
#                                (Claude Code, Codex, Cursor, GitHub CLI) and
#                                their sign-ins
#   bash uninstall.sh --keep-bun leave Bun alone (remove only kanna-code)
#
# Meant for a test machine. It asks once before it starts.
set -u

AGENTS=false
KEEP_BUN=false
for arg in "$@"; do
  case "$arg" in
    --agents) AGENTS=true ;;
    --keep-bun) KEEP_BUN=true ;;
    *) echo "usage: uninstall.sh [--agents] [--keep-bun]" >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

echo "This removes Kanna and all of its data from this Mac (chats, settings, the Kanna Cloud pairing)."
$AGENTS && echo "It also removes Claude Code, Codex, the Cursor CLI and the GitHub CLI, and their sign-ins."
$KEEP_BUN || echo "It also removes Bun (~/.bun) and its lines in your shell profiles."
read -r -p "Continue? [y/N] " answer
[[ "$answer" =~ ^[Yy]$ ]] || { echo "Nothing removed."; exit 0; }

export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

step "1. Taking this Mac off Kanna Cloud"
# Frees its kanna.sh address and removes its tunnel and DNS record. Needs
# kanna, so it goes first.
if command -v kanna >/dev/null 2>&1 && [ -f "$HOME/.kanna/cloud.json" ]; then
  kanna pair --remove || echo "  kanna pair --remove failed; delete this Mac at https://kanna.sh/fleet instead."
else
  echo "  Not paired (or kanna is already gone). If it's still listed, delete it at https://kanna.sh/fleet."
fi

step "2. Quitting Kanna"
osascript -e 'tell application id "sh.kanna.mac" to quit' >/dev/null 2>&1
osascript -e 'tell application id "sh.kanna.mac.dev" to quit' >/dev/null 2>&1
sleep 2
pkill -f "Kanna.app/Contents/MacOS" 2>/dev/null
pkill -f "Kanna Dev.app/Contents/MacOS" 2>/dev/null
pkill -f "kanna-code" 2>/dev/null
echo "  Done."

step "3. Removing the apps"
rm -rf /Applications/Kanna.app "/Applications/Kanna Dev.app" "$HOME/Applications/Kanna.app"
echo "  Done."

step "4. Removing the kanna command$($KEEP_BUN || echo " and Bun")"
command -v bun >/dev/null 2>&1 && bun remove -g kanna-code >/dev/null 2>&1
command -v npm >/dev/null 2>&1 && npm uninstall -g kanna-code >/dev/null 2>&1
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
echo "  Done."

step "5. Removing Kanna's data, preferences, web data and logs"
rm -rf "$HOME/.kanna" "$HOME/.kanna-dev"
defaults delete sh.kanna.mac >/dev/null 2>&1
defaults delete sh.kanna.mac.dev >/dev/null 2>&1
rm -rf "$HOME"/Library/Caches/sh.kanna.mac* \
       "$HOME"/Library/WebKit/sh.kanna.mac* \
       "$HOME"/Library/HTTPStorages/sh.kanna.mac* \
       "$HOME"/Library/"Saved Application State"/sh.kanna.mac*.savedState \
       "$HOME"/Library/"Application Support"/sh.kanna.mac* \
       "$HOME"/Library/Logs/Kanna
echo "  Done."

step "6. Resetting permissions and the Keychain"
# Full Disk Access, microphone and the other privacy grants.
tccutil reset All sh.kanna.mac >/dev/null 2>&1
tccutil reset All sh.kanna.mac.dev >/dev/null 2>&1
# The kanna.sh sign-in that app versions up to 1.1.0 kept. macOS may ask
# to allow this; click Allow.
while security delete-generic-password -s sh.kanna.cloud >/dev/null 2>&1; do :; done
echo "  Done."

if $AGENTS; then
  step "7. Removing the agent CLIs"
  rm -rf "$HOME/.local/bin/claude" "$HOME/.local/share/claude" "$HOME/.claude" "$HOME/.claude.json"
  command -v npm >/dev/null 2>&1 && npm uninstall -g @openai/codex >/dev/null 2>&1
  command -v bun >/dev/null 2>&1 && bun remove -g @openai/codex >/dev/null 2>&1
  rm -rf "$HOME/.codex"
  # ~/.cursor stays: the Cursor editor keeps its settings there too.
  rm -f "$HOME/.local/bin/cursor-agent"
  command -v brew >/dev/null 2>&1 && brew uninstall gh >/dev/null 2>&1
  rm -f "$HOME/.local/bin/gh"
  rm -rf "$HOME/.config/gh"
  echo "  Done."
fi

step "Left for you"
echo "  - System Settings › General › Login Items: remove Kanna if it's still listed (opening it now)."
echo "  - System Settings › Notifications: remove Kanna for a fresh notifications prompt."
echo "  - kanna.sh in your browser: sign out to test signing in during the claim."
echo "  - Open a new terminal: this one still has the old PATH."
open "x-apple.systempreferences:com.apple.LoginItems-Settings.extension" >/dev/null 2>&1

step "Check"
left=""
for path in /Applications/Kanna.app "$HOME/.kanna" "$HOME/Library/Preferences/sh.kanna.mac.plist"; do
  [ -e "$path" ] && left="$left\n  $path"
done
$KEEP_BUN || { [ -e "$HOME/.bun" ] && left="$left\n  $HOME/.bun"; }
if [ -n "$left" ]; then
  printf "  Still here:%b\n" "$left"
else
  echo "  Kanna is gone. Start over at https://kanna.sh/downloads/mac/Kanna.dmg"
fi

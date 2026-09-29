#!/bin/bash
# Build Kanna for Mac.
#
#   ./build.sh             Kanna.app in dist/, signed, not notarized: for this Mac
#   ./build.sh --open      the same, then quit any running Kanna and open this one
#   ASC_PROFILE=<asc profile> ./build.sh --release
#                          notarized DMG, update zip and latest-mac.yml in
#                          dist/release, not uploaded
#   ASC_PROFILE=<asc profile> ./build.sh --publish
#                          --release, then upload to the kanna-releases R2
#                          bucket, which kanna.sh serves at /downloads/mac/
#                          (kanna-site, src/worker/mac-releases.ts): the
#                          homepage's Download for Mac button and every
#                          installed app's update check (src/updates.ts) see
#                          it at once
#
# This ships only the window. Kanna itself is the npm package and releases
# with /release as always; run this when macos/ changes, after bumping
# "version" in package.json. The build number is the commit count, so it only
# goes up.
#
# Signed with the Developer ID (SIGN_IDENTITY overrides it) even for this Mac:
# Full Disk Access and the microphone grant are tied to the signature, so a
# stable one keeps them across rebuilds.
#
# One-time setup:
#   - The Developer ID Application certificate in the login keychain.
#   - An `asc` profile (asc auth login) whose App Store Connect API key
#     notarizes: asc talks to Apple's Notary API with it directly.
#   - uv, for dmgbuild (run through uvx; see dmg-settings.py).
set -euo pipefail
cd "$(dirname "$0")"

MODE=local
case "${1:-}" in
  --open) MODE=open ;;
  --release) MODE=release ;;
  --publish) MODE=publish ;;
  "") ;;
  *) echo "usage: build.sh [--open | --release | --publish]" >&2; exit 1 ;;
esac
if [ "$MODE" = release ] || [ "$MODE" = publish ]; then
  : "${ASC_PROFILE:?set ASC_PROFILE to the asc profile that notarizes (asc auth status)}"
fi

IDENTITY=${SIGN_IDENTITY:-"Jake Mor (QK9365HKRK)"}
VERSION=$(node -p 'require("./package.json").version')
BUILD_NUMBER=$(git rev-list --count HEAD)

# 1. Bundle the main process and preloads, then package and sign Kanna.app
#    (electron-builder.yml). It signs inside out, with entitlements.plist.
bun install --frozen-lockfile
bun run build
rm -rf dist
bunx electron-builder --mac --publish never \
  -c.mac.identity="$IDENTITY" -c.buildVersion="$BUILD_NUMBER"
APP=$(ls -d dist/mac*/Kanna.app | head -1)
codesign --verify --deep --strict "$APP"
echo "built Kanna for Mac $VERSION ($BUILD_NUMBER): $APP"

if [ "$MODE" = open ]; then
  osascript -e 'tell application id "sh.kanna.mac" to quit' >/dev/null 2>&1 || true
  while pgrep -f "Kanna.app/Contents/MacOS/Kanna" >/dev/null; do sleep 0.2; done
  open "$APP"
fi
if [ "$MODE" = local ] || [ "$MODE" = open ]; then exit 0; fi

OUT="$(pwd)/dist/release"
mkdir -p "$OUT"
notarize() {
  asc --profile "$ASC_PROFILE" notarization submit --file "$1" --wait --timeout 1h --output table
}

# 2. Notarize the app and staple its ticket, so it opens without a network
#    check from the DMG and from the update zip alike.
ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
notarize "$OUT/notarize.zip"
rm "$OUT/notarize.zip"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

# 3. The update zip: what electron-updater downloads and Squirrel installs.
#    ditto keeps the bundle's symlinks and signature intact, as zip wouldn't.
ZIP="Kanna-$VERSION-mac.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT/$ZIP"

# 4. The DMG: the app and an Applications shortcut (dmg-settings.py). Signed
#    and notarized itself too, so Gatekeeper trusts the image before it
#    trusts what's in it.
DMG="Kanna-$VERSION.dmg"
uvx --from 'dmgbuild==1.6.5' dmgbuild -s dmg-settings.py -D app="$APP" "Kanna" "$OUT/$DMG"
codesign --force --timestamp --sign "Developer ID Application: $IDENTITY" "$OUT/$DMG"
notarize "$OUT/$DMG"
# Apple's stapler, not `asc notarization staple`: stapling rewrites the DMG,
# and asc then fails its own check that the file didn't change.
xcrun stapler staple "$OUT/$DMG"
xcrun stapler validate "$OUT/$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$OUT/$DMG"
cp "$OUT/$DMG" "$OUT/Kanna.dmg"

# 5. The update feed electron-updater reads (its "generic" provider format):
#    the newest version and its zip, which it checks against the hash.
sha512() { openssl dgst -sha512 -binary "$1" | base64; }
cat > "$OUT/latest-mac.yml" <<EOF
version: $VERSION
files:
  - url: $ZIP
    sha512: $(sha512 "$OUT/$ZIP")
    size: $(stat -f %z "$OUT/$ZIP")
path: $ZIP
sha512: $(sha512 "$OUT/$ZIP")
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
EOF

# 6. Publish. The versioned files go up before the ones that point at them.
if [ "$MODE" = publish ]; then
  # The Cloudflare account kanna.sh and the bucket live in; without it, a
  # login that can see several accounts refuses to pick one.
  export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-7c389c8055f3e4aba40ec6500c07ff3b}
  for file in "$DMG" "$ZIP" Kanna.dmg latest-mac.yml; do
    bunx wrangler@4 r2 object put "kanna-releases/mac/$file" --file "$OUT/$file" --remote
  done
  echo "published Kanna for Mac $VERSION: https://kanna.sh/downloads/mac/Kanna.dmg"
fi

echo
echo "done: $OUT"
ls -lh "$OUT"

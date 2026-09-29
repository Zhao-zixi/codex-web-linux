#!/bin/bash
# Build a notarized Kanna.app for release, plus its Sparkle appcast.
#
#   ASC_PROFILE=<asc profile> ./build.sh [--publish]
#
#   --test stops at a signed DMG, not notarized and not published: quick
#   builds to hand to a test Mac, which then needs right-click › Open once.
#   --publish uploads the result to the kanna-releases R2 bucket, which
#   kanna.sh serves at /downloads/mac/ (kanna-site, src/worker/mac-releases.ts):
#   the homepage's Download for Mac button and every installed app's update
#   check see it at once. Without it the build stays local.
#   SIGN_IDENTITY overrides the Developer ID it signs with.
#
# This ships only the window. Kanna itself is the npm package and releases
# with /release as always; run this when macos/ changes, after bumping
# MARKETING_VERSION in project.yml.
#
# One-time setup:
#   - A Developer ID Application certificate in the login keychain.
#   - An `asc` profile (asc auth login) whose App Store Connect API key
#     notarizes: asc talks to Apple's Notary API with it directly.
#   - uv, for dmgbuild (run through uvx; see dmg-settings.py).
#   - Sparkle's update-signing key in the keychain: generate_keys --account
#     kanna (in build/derived/SourcePackages/artifacts once the package
#     resolves). Its public half is SPARKLE_PUBLIC_KEY in project.yml.
#
# Output in build/release: Kanna-<version>.dmg, Kanna.dmg (the fixed "latest"
# download link) and appcast.xml, served next to each other at the URL in
# project.yml (KANNA_APPCAST_URL).
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(pwd)/build/release"

SIGN_IDENTITY=${SIGN_IDENTITY:-"Developer ID Application: Jake Mor (QK9365HKRK)"}
PUBLISH=false
TEST=false
case "${1:-}" in
  --publish) PUBLISH=true ;;
  --test) TEST=true ;;
  "") ;;
  *) echo "usage: build.sh [--publish | --test]" >&2; exit 1 ;;
esac
$TEST || : "${ASC_PROFILE:?set ASC_PROFILE to the asc profile that notarizes (asc auth status)}"

BUILD_NUMBER=$(git rev-list --count HEAD)
rm -rf "$OUT"
mkdir -p "$OUT"

# 1. Build unsigned; signing happens below, inside out.
xcodegen generate --quiet
xcodebuild -project Kanna.xcodeproj -scheme Kanna -configuration Release \
  -derivedDataPath build/derived -archivePath build/Kanna.xcarchive -quiet archive \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGNING_ALLOWED=NO
APP="$OUT/Kanna.app"
ditto build/Kanna.xcarchive/Products/Applications/Kanna.app "$APP"
VERSION=$(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString)
echo "building Kanna for Mac $VERSION ($BUILD_NUMBER)"

# 2. Sign Sparkle's helpers in the order Sparkle documents, then the app.
sign() { codesign --force --timestamp --options runtime --sign "$SIGN_IDENTITY" "$@"; }
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework"
sign "$SPARKLE/Versions/B/XPCServices/Installer.xpc"
sign --preserve-metadata=entitlements "$SPARKLE/Versions/B/XPCServices/Downloader.xpc"
sign "$SPARKLE/Versions/B/Autoupdate"
sign "$SPARKLE/Versions/B/Updater.app"
sign "$SPARKLE"
sign --entitlements Kanna/Kanna.entitlements "$APP"
codesign --verify --deep --strict "$APP"

# 3. The DMG: the app and an Applications shortcut (dmg-settings.py). Signed
# itself too, so Gatekeeper trusts the image before it trusts what's in it.
DMG="$OUT/Kanna-$VERSION.dmg"
uvx --from 'dmgbuild==1.6.5' dmgbuild -s dmg-settings.py -D app="$APP" "Kanna" "$DMG"
codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG"
# The app as a user gets it: still sealed once copied into the image.
MOUNT=$(hdiutil attach -readonly -nobrowse -noautoopen "$DMG" | tail -1 | awk -F'\t' '{print $NF}')
codesign --verify --deep --strict "$MOUNT/Kanna.app"
hdiutil detach -quiet "$MOUNT"

if $TEST; then
  rm -rf "$APP"
  echo
  echo "test build (signed, not notarized): $DMG"
  exit 0
fi

# 4. Notarize the DMG (its ticket covers the app inside) and staple it, so it
# opens without a network check.
asc --profile "$ASC_PROFILE" notarization submit --file "$DMG" --wait --timeout 1h --output table
# Apple's stapler, not `asc notarization staple`: stapling rewrites the DMG,
# and asc then fails its own check that the file didn't change.
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
spctl --assess --type open --context context:primary-signature --verbose "$DMG"
cp "$DMG" "$OUT/Kanna.dmg"

# 5. The appcast, signed with the EdDSA key in the keychain. Sparkle installs
# from the DMG; with earlier DMGs next to this one it also writes deltas.
GENERATE_APPCAST=$(find build/derived/SourcePackages/artifacts -path '*/bin/generate_appcast' -type f | head -1)
mkdir -p "$OUT/appcast"
cp "$DMG" "$OUT/appcast/"
"$GENERATE_APPCAST" --account kanna "$OUT/appcast"
mv "$OUT/appcast/appcast.xml" "$OUT/appcast.xml"
rm -rf "$OUT/appcast" "$APP"

# 6. Publish. The versioned DMG goes up before the files that point at it.
if $PUBLISH; then
  # The Cloudflare account kanna.sh and the bucket live in; without it, a
  # login that can see several accounts refuses to pick one.
  export CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-7c389c8055f3e4aba40ec6500c07ff3b}
  for file in "Kanna-$VERSION.dmg" Kanna.dmg appcast.xml; do
    bunx wrangler@4 r2 object put "kanna-releases/mac/$file" --file "$OUT/$file" --remote
  done
  echo "published Kanna for Mac $VERSION: https://kanna.sh/downloads/mac/Kanna.dmg"
fi

echo
echo "done: $OUT"
ls -lh "$OUT"

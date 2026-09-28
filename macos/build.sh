#!/bin/bash
# Build a notarized Kanna.app for release, plus its Sparkle appcast.
#
#   SIGN_IDENTITY="Developer ID Application: … (TEAMID)" \
#   NOTARY_PROFILE=kanna-notary \
#   SPARKLE_PUBLIC_KEY=… \
#   ./build.sh
#
# This ships only the window. Kanna itself is the npm package and releases
# with /release as always; run this when macos/ changes, after bumping
# MARKETING_VERSION in project.yml.
#
# One-time setup:
#   - A Developer ID Application certificate in the login keychain.
#   - xcrun notarytool store-credentials kanna-notary …  (App Store Connect API key)
#   - Sparkle's generate_keys (in build/derived/SourcePackages/artifacts once the
#     package resolves) makes the EdDSA key pair: the private half stays in the
#     keychain, the public half goes in SPARKLE_PUBLIC_KEY.
#
# Output in build/release: Kanna-<version>.zip, Kanna.zip and appcast.xml, to
# upload next to each other at the URL in project.yml (KANNA_APPCAST_URL).
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(pwd)/build/release"

: "${SIGN_IDENTITY:?set SIGN_IDENTITY to a Developer ID Application identity (security find-identity -v -p codesigning)}"
: "${NOTARY_PROFILE:?set NOTARY_PROFILE to a notarytool keychain profile}"
: "${SPARKLE_PUBLIC_KEY:?set SPARKLE_PUBLIC_KEY (Sparkle generate_keys -p)}"

BUILD_NUMBER=$(git rev-list --count HEAD)
rm -rf "$OUT"
mkdir -p "$OUT"

# 1. Build unsigned; signing happens below, inside out.
xcodegen generate --quiet
xcodebuild -project Kanna.xcodeproj -scheme Kanna -configuration Release \
  -derivedDataPath build/derived -archivePath build/Kanna.xcarchive -quiet archive \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" SPARKLE_PUBLIC_KEY="$SPARKLE_PUBLIC_KEY" CODE_SIGNING_ALLOWED=NO
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

# 3. Notarize and staple.
ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
spctl --assess --type execute --verbose "$APP"
rm "$OUT/notarize.zip"

ditto -c -k --keepParent "$APP" "$OUT/Kanna-$VERSION.zip"
cp "$OUT/Kanna-$VERSION.zip" "$OUT/Kanna.zip"

# 4. The appcast, signed with the EdDSA key in the keychain.
GENERATE_APPCAST=$(find build/derived/SourcePackages/artifacts -path '*/bin/generate_appcast' -type f | head -1)
mkdir -p "$OUT/appcast"
cp "$OUT/Kanna-$VERSION.zip" "$OUT/appcast/"
"$GENERATE_APPCAST" "$OUT/appcast"
mv "$OUT/appcast/appcast.xml" "$OUT/appcast.xml"
rm -rf "$OUT/appcast"

echo
echo "done: $OUT"
ls -lh "$OUT"

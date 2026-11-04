#!/usr/bin/env bash
set -euo pipefail

case "${PURE_BUILD_PLATFORM:-}" in
  macos|ios) ;;
  *) echo 'PURE_BUILD_PLATFORM must be macos or ios.' >&2; exit 1 ;;
esac
python3 scripts/ci/artifacts.py verify-frontend

if [[ "$PURE_BUILD_PLATFORM" == 'macos' ]]; then
  npm run tauri build -- --bundles app --target aarch64-apple-darwin --ci --config '{"build":{"beforeBuildCommand":""}}'
  APP_PATH=$(find src-tauri/target/aarch64-apple-darwin/release/bundle/macos -maxdepth 1 -type d -name '*.app' -print -quit)
  test -n "$APP_PATH"
  APP_EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")
  lipo -verify_arch arm64 "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE"
  lipo -archs "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE"
  codesign --force --deep --sign - "$APP_PATH"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" pure-macos.zip
else
  if [[ ! -d src-tauri/gen/apple ]]; then
    npm run tauri ios init -- --ci
  fi
  npm run tauri icon -- public/pure.png
  cmp src-tauri/icons/ios/AppIcon-512@2x.png src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
  npm run tauri ios build -- --ci --no-sign --target aarch64 --config '{"build":{"beforeBuildCommand":""}}'
  IOS_IPA=$(find src-tauri/gen/apple/build/arm64 -maxdepth 1 -name '*.ipa' -type f -print -quit)
  test -n "$IOS_IPA"
  cp "$IOS_IPA" pure-ios-unsigned.ipa
fi
python3 scripts/ci/artifacts.py record-native "$PURE_BUILD_PLATFORM"

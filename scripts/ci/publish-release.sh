#!/usr/bin/env bash
set -euo pipefail

# A stale run must not modify the release, even when manually re-run later.
LATEST_MAIN_SHA=$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq '.object.sha')
if [[ "$GITHUB_SHA" != "$LATEST_MAIN_SHA" ]]; then
  echo '::notice::main has changed; keeping the existing release.'
  exit 0
fi
python3 scripts/ci/artifacts.py verify-release
TAG='latest-build'
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" release/pure-macos.zip release/pure-ios-unsigned.ipa release/build-info.json --clobber
else
  gh release create "$TAG" release/pure-macos.zip release/pure-ios-unsigned.ipa release/build-info.json \
    --target "$GITHUB_SHA" --title 'pure (Latest macOS & iOS Build)' \
    --notes 'macOS and unsigned iOS packages built and verified together from main. See build-info.json for the source commit and package digests.'
fi

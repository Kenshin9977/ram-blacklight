#!/bin/sh
# Fetch the content blocker used by the "+ubol" modes: uBlock Origin Lite, official release, pinned and checked.
# uBlock Origin (MV2) is not used: Chrome dropped MV2 extensions in 2025 (see src/measure.js).
set -eu
cd "$(dirname "$0")/.."
VERSION=2026.1110.1816
SHA256=85fe5909366e8ada66c5b331bbdbf69cf5100245ed6161b1e4e2f1f848ec7d03
ZIP="uBOLite_${VERSION}.chromium.zip"
mkdir -p extensions/_dl
[ -f "extensions/_dl/$ZIP" ] || curl -fsSL -o "extensions/_dl/$ZIP" "https://github.com/uBlockOrigin/uBOL-home/releases/download/${VERSION}/${ZIP}"
echo "${SHA256}  extensions/_dl/${ZIP}" | sha256sum -c -
rm -rf extensions/ubol
mkdir -p extensions/ubol
unzip -q "extensions/_dl/$ZIP" -d extensions/ubol
grep '"version"' extensions/ubol/manifest.json

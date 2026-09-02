#!/usr/bin/env bash
# NASSCAD 4.7.0 — fetch-assets.sh
# Downloads the two OpenCASCADE WASM binaries that are distributed as
# GitHub release assets instead of being committed to the repository.
#
# Usage:  ./scripts/fetch-assets.sh
#         TAG=v4.7.0 ./scripts/fetch-assets.sh     # a specific release
#         FORCE=1 ./scripts/fetch-assets.sh        # re-download

set -euo pipefail

REPO="${REPO:-Nx-Nass/Nasscad_4.7.0}"
TAG="${TAG:-latest}"
FORCE="${FORCE:-0}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "$TAG" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/$TAG"
fi

# name:expected_size_in_bytes
ASSETS=(
  "opencascade.wasm.data.js:87818741"
  "opencascade.wasm.wasm:65864037"
)

filesize() { wc -c < "$1" | tr -d ' '; }

echo "NASSCAD 4.7.0 - fetching WASM assets from $BASE"

for entry in "${ASSETS[@]}"; do
  name="${entry%%:*}"
  size="${entry##*:}"
  dest="$ROOT/$name"

  if [ -f "$dest" ] && [ "$FORCE" != "1" ]; then
    if [ "$(filesize "$dest")" = "$size" ]; then
      echo "  [skip] $name already present"
      continue
    fi
    echo "  [warn] $name present but wrong size - re-downloading"
  fi

  printf '  [get ] %s (%s MB)... ' "$name" "$((size / 1048576))"
  if ! curl -fsSL --retry 3 -o "$dest.part" "$BASE/$name"; then
    rm -f "$dest.part"
    echo "FAILED"
    exit 1
  fi

  got="$(filesize "$dest.part")"
  if [ "$got" != "$size" ]; then
    rm -f "$dest.part"
    echo "FAILED"
    echo "$name: expected $size bytes, got $got. Aborted." >&2
    exit 1
  fi

  mv "$dest.part" "$dest"
  echo "ok"
done

echo
echo "Done. Serve the folder over HTTP, then open NASSCAD_V4_7_0.htm :"
echo "  python3 -m http.server 8080"
echo "  http://localhost:8080/NASSCAD_V4_7_0.htm"

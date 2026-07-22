#!/usr/bin/env bash
set -euo pipefail

TARGET="${CHROMIUM_LIB_ROOT:-${HOME:-/data}/.local/chromium-libs}"
APT_ROOT="$TARGET/apt"
DEB_DIR="$TARGET/debs"
EXTRACT_ROOT="$TARGET/root"

mkdir -p "$APT_ROOT/lists/partial" "$APT_ROOT/cache/archives/partial" "$DEB_DIR" "$EXTRACT_ROOT"

APT_OPTS=(
  -o "Dir::State::Lists=$APT_ROOT/lists"
  -o "Dir::Cache=$APT_ROOT/cache"
  -o Debug::NoLocking=true
)

apt-get "${APT_OPTS[@]}" update
(
  cd "$DEB_DIR"
  apt-get "${APT_OPTS[@]}" download \
    libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libatspi2.0-0t64 libxcomposite1 libxdamage1
  for package in ./*.deb; do
    dpkg-deb -x "$package" "$EXTRACT_ROOT"
  done
)

LIB_DIR="$EXTRACT_ROOT/usr/lib/x86_64-linux-gnu"
printf 'Chromium user-space libraries installed in %s\n' "$LIB_DIR"
printf 'ContentBrain discovers this path automatically on Hostinger. Elsewhere set CHROMIUM_LIB_DIR=%s\n' "$LIB_DIR"

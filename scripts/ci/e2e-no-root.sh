#!/usr/bin/env bash
# Runs the browser tests on a shared Linux CI host (e.g. a Jenkins container) without root.
#
# Chromium needs ~20 system libraries (glib, nss, atk, gbm, ...) that bare CI images lack, and
# installing them system-wide needs root. Instead, this script downloads the missing Debian/Ubuntu
# packages as the current user (apt with its own folders, no locks, nothing installed), unpacks
# them into a private folder, and starts the tests with LD_LIBRARY_PATH pointing there. Nothing
# outside that folder changes, so other jobs on the same host never see it.
#
# Usage:  scripts/ci/e2e-no-root.sh [extra playwright args]
# Env:    CHROMIUM_LIBS_DIR   where the libraries are kept (default /tmp/tablight-chromium-libs;
#                             reused between builds, rebuilt when the OS or package list changes)
set -euo pipefail

# Chromium's runtime libraries, from Playwright's own list (playwright-core nativeDeps, debian12/ubuntu).
PACKAGES=(
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2
  libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1
  libxext6 libxfixes3 libxkbcommon0 libxrandr2
)

command -v apt-get >/dev/null || { echo "e2e-no-root: needs a Debian or Ubuntu based host (apt-get not found)" >&2; exit 1; }

. /etc/os-release
ARCH=$(dpkg --print-architecture)
BASE=${CHROMIUM_LIBS_DIR:-/tmp/tablight-chromium-libs}
W="$BASE/${ID}-${VERSION_ID:-unknown}-${ARCH}"
STAMP="$W/.ready"
WANT="${PACKAGES[*]}"

if [[ ! -f "$STAMP" || "$(cat "$STAMP")" != "$WANT" ]]; then
  echo "e2e-no-root: preparing Chromium libraries in $W"
  rm -rf "$W"
  mkdir -p "$W/lists/partial" "$W/cache/archives/partial" "$W/root"
  APT=(apt-get -q
    -o Debug::NoLocking=1
    -o Dir::State::Lists="$W/lists"
    -o Dir::Cache="$W/cache"
    -o Dir::State::status=/var/lib/dpkg/status
    -o APT::Sandbox::User="$(id -un)")
  "${APT[@]}" update >/dev/null
  # --download-only against the host's real package database: only what is missing is fetched,
  # with dependencies resolved. Nothing is installed.
  "${APT[@]}" install -y --download-only --no-install-recommends "${PACKAGES[@]}" >/dev/null
  shopt -s nullglob
  debs=("$W"/cache/archives/*.deb)
  for deb in "${debs[@]}"; do dpkg-deb -x "$deb" "$W/root"; done
  rm -rf "$W/cache" "$W/lists"
  echo "e2e-no-root: unpacked ${#debs[@]} packages"
  echo "$WANT" > "$STAMP"
fi

# Every folder in the private tree that holds shared libraries.
LIBDIRS=$(find "$W/root" -name '*.so*' \( -type f -o -type l \) -printf '%h\n' 2>/dev/null | sort -u | paste -sd: -)
export LD_LIBRARY_PATH="${LIBDIRS}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Fail early and clearly if Chromium still misses a library.
CHROME=$(node -e "console.log(require('playwright').chromium.executablePath())")
if [[ ! -x "$CHROME" ]]; then
  echo "e2e-no-root: Chromium not downloaded yet; run 'npx playwright install chromium' first" >&2
  exit 1
fi
missing=$(ldd "$CHROME" | grep 'not found' || true)
if [[ -n "$missing" ]]; then
  echo "e2e-no-root: Chromium still misses libraries:" >&2
  echo "$missing" >&2
  exit 1
fi
echo "e2e-no-root: all Chromium libraries found"

exec npm run test:e2e -- "$@"

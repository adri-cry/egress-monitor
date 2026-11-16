#!/usr/bin/env bash
# Launch Egress Monitor on Linux (Mint/Cinnamon, MATE, XFCE, GNOME).
# Double-click in the file manager, or run ./launch-egress-monitor.sh

set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm not found. Install Node.js 22+ first:"
  echo "  sudo apt install nodejs npm    # or use nvm"
  exit 1
fi

if [ ! -x node_modules/electron/dist/electron ]; then
  echo "Installing dependencies…"
  npm install
fi

# Ubuntu 24.04 / Mint 22 block unprivileged user namespaces via AppArmor, and
# chromium's setuid helper ships non-setuid in node_modules. Without either,
# Electron dies with "The SUID sandbox helper binary was found, but is not
# configured correctly". Prefer the permanent fix; fall back to --no-sandbox.
EXTRA_ARGS=()
SANDBOX_HELPER="node_modules/electron/dist/chrome-sandbox"
if [ -f "$SANDBOX_HELPER" ] && [ "$(stat -c '%a' "$SANDBOX_HELPER")" != "4755" ]; then
  if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ]; then
    echo "chrome-sandbox is not setuid and AppArmor restricts user namespaces."
    echo "Permanent fix:"
    echo "  sudo chown root:root $SANDBOX_HELPER && sudo chmod 4755 $SANDBOX_HELPER"
    echo "Launching with --no-sandbox for this run."
    EXTRA_ARGS=(--no-sandbox)
  fi
fi

if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
  exec npm run start -- "${EXTRA_ARGS[@]}"
fi
exec npm run start

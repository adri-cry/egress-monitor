#!/usr/bin/env bash
# Tray icon untuk Egress Monitor di panel Cinnamon.
# Pakai yad --notification (AppIndicator), lebih handal daripada Electron Tray
# di desktop X11/Cinnamon.
set -uo pipefail

DECK="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# yad --notification (AppIndicator) works only on X11. On a Wayland session
# (KDE Plasma here) force the X11 backend through Xwayland.
export DISPLAY=:0
export GDK_BACKEND=x11
ICON="$DECK/assets/tray.png"
STATUS="$DECK/runtime/tray-status.json"
MENU="Tampilkan UI!bash -c 'cd $DECK && ./node_modules/.bin/electron . --no-sandbox'
Rotate /64!systemctl --user restart egress-monitor.service
Status!bash -c 'curl -sS -m 8 --socks5-hostname 127.0.0.1:41987 https://api6.ipify.org?format=json | xargs -0 notify-send Egress'
Buka Log!bash -c 'konsole -e bash -c \"tail -f $DECK/logs/guard.log\"'
Keluar (Quit)!bash -c 'systemctl --user stop egress-tray.service egress-monitor.service'"

# The app writes runtime/tray-status.json (tooltip + warn flag) on every usage
# poll and hop. Feed changes into yad --listen so the tooltip shows live usage
# and the icon flips to a warning at the warn threshold.
feed() {
  local last_tooltip="" last_warn="" tooltip warn
  while :; do
    tooltip="Egress Monitor - klik kanan untuk menu"
    warn="0"
    if [[ -r "$STATUS" ]]; then
      tooltip=$(sed -n 's/.*"tooltip": *"\([^"]*\)".*/\1/p' "$STATUS" | head -n1)
      [[ -n "$tooltip" ]] || tooltip="Egress Monitor"
      if grep -q '"warn": *true' "$STATUS"; then warn="1"; fi
    fi
    if [[ "$tooltip" != "$last_tooltip" ]]; then
      printf 'tooltip:%s\n' "$tooltip"
      last_tooltip="$tooltip"
    fi
    if [[ "$warn" != "$last_warn" ]]; then
      if [[ "$warn" == "1" ]]; then
        printf 'icon:dialog-warning\n'
      else
        printf 'icon:%s\n' "$ICON"
      fi
      last_warn="$warn"
    fi
    sleep 5
  done
}

feed | yad --notification --listen \
  --image="$ICON" \
  --text='Egress Monitor' \
  --tooltip='Egress Monitor - klik kanan untuk menu' \
  --menu="$MENU" \
  --command="bash -c 'cd $DECK && ./node_modules/.bin/electron . --no-sandbox'" \
  --no-middle

#!/usr/bin/env bash
# Tray icon untuk Egress Monitor di panel Cinnamon.
# Pakai yad --notification (AppIndicator), lebih handal daripada Electron Tray
# di desktop X11/Cinnamon.
set -uo pipefail

export DISPLAY=:0
ICON="/home/rootx/Documents/egress-monitor/assets/tray.png"
MENU="Tampilkan UI!bash -c 'cd /home/rootx/Documents/egress-monitor && ./node_modules/.bin/electron . --no-sandbox'
Rotate /64!systemctl --user restart egress-monitor.service
Status!bash -c 'curl -sS -m 8 --socks5-hostname 127.0.0.1:41987 https://api6.ipify.org?format=json | xargs -0 notify-send Egress'
Buka Log!bash -c 'gnome-terminal -- bash -c \"tail -f /home/rootx/Documents/egress-monitor/logs/guard.log\"'
Keluar (Quit)!bash -c 'systemctl --user stop egress-tray.service egress-monitor.service'"

yad --notification \
  --image="$ICON" \
  --text='Egress Monitor' \
  --tooltip='Egress Monitor - klik kanan untuk menu' \
  --menu="$MENU" \
  --command="bash -c 'cd /home/rootx/Documents/egress-monitor && ./node_modules/.bin/electron . --no-sandbox'" \
  --no-middle

#!/usr/bin/env bash
# Restart opencode serve DENGAN env proxy egress-monitor.
# Jalankan dari terminal biasa (BUKAN dari dalam opencode), karena ini
# mematikan service yang menhost sesi opencode aktif.
set -uo pipefail

PROXY_URL="http://127.0.0.1:41987"
NO_PROXY_VAL="127.0.0.1,localhost,::1"
export HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL" ALL_PROXY="$PROXY_URL"
export http_proxy="$PROXY_URL" https_proxy="$PROXY_URL" all_proxy="$PROXY_URL"
export NO_PROXY="$NO_PROXY_VAL" no_proxy="$NO_PROXY_VAL"

echo "[restart-opencode] cek proxy $PROXY_URL ..."
if ! curl -sS -m 8 --socks5-hostname 127.0.0.1:41987 \
     'https://api.ipify.org?format=json' >/dev/null 2>&1; then
  echo "[restart-opencode] WARNING: proxy 41987 tidak siap."
  echo "[restart-opencode] Pastikan Egress Monitor jalan dulu, lalu ulangi."
  exit 1
fi
echo "[restart-opencode] proxy OK."

echo "[restart-opencode] menghentikan opencode serve lama ..."
pkill -TERM -f 'opencode serve --service' 2>/dev/null || true
sleep 2
# paksa kalau masih ada
pkill -KILL -f 'opencode serve --service' 2>/dev/null || true
sleep 1

echo "[restart-opencode] menjalankan opencode serve dengan env proxy ..."
nohup opencode serve --service >/tmp/opencode-serve.log 2>&1 &
NEW=$!
sleep 3

if ! kill -0 "$NEW" 2>/dev/null; then
  echo "[restart-opencode] GAGAL start serve. Log: /tmp/opencode-serve.log"
  tail -n 20 /tmp/opencode-serve.log
  exit 1
fi

echo "[restart-opencode] serve aktif (pid $NEW)."
echo "[restart-opencode] verifikasi env proxy:"
tr '\0' '\n' < "/proc/$NEW/environ" | grep -iE '^HTTP_PROXY|^HTTPS_PROXY|^ALL_PROXY' | head -3
echo "[restart-opencode] verifikasi koneksi:"
ss -tnp 2>/dev/null | grep "pid=$NEW" | grep 41987 | head -3 || echo "(belum ada koneksi proxy - kirim prompt dulu)"

echo "[restart-opencode] selesai. Buka opencode seperti biasa: opencode"

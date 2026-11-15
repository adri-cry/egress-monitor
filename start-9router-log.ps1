# Start 9router dengan log ke file (hanya ERROR/WARN, rotasi harian).
#
# Pakai biasa (aman, dipakai Startup):
#   powershell -ExecutionPolicy Bypass -File start-9router-log.ps1
#
# Paksa restart (MEMATIKAN instance 9router yang sedang jalan):
#   powershell -ExecutionPolicy Bypass -File start-9router-log.ps1 -Force
#
# Catatan: cli.js memanggil stopPreviousInstance() saat start, yang membaca
# launcher.pid dan mematikan instance lama. Karena itu tanpa -Force script ini
# langsung exit kalau port 20128 sudah dipakai.

param([switch]$Force)

$logDir  = Join-Path $env:USERPROFILE 'Documents\9router-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ('9router-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
$cli     = Join-Path $env:APPDATA 'npm\node_modules\9router\cli.js'
$port    = 20128

function Write-Log([string]$text) {
    ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text) |
        Out-File -FilePath $logFile -Append -Encoding utf8
}

# --- Guard: jangan pernah start kalau 9router sudah jalan (kecuali -Force) ---
if (-not $Force) {
    $busy = $false
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async  = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(1500, $false) -and $client.Connected) { $busy = $true }
        $client.Close()
    } catch { }

    if ($busy) {
        Write-Log "9router sudah berjalan di port $port - wrapper tidak melakukan apa-apa (pakai -Force untuk restart)."
        exit 0
    }
}

# --- Jalankan & filter ---
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:LOG_LEVEL = 'INFO'
Write-Log "Menjalankan 9router (--log) di port $port ..."

& node $cli --tray --skip-update -p $port --log 2>&1 |
    ForEach-Object {
        # Flush per baris: Tee-Object/Out-File di luar loop tidak flush pada proses daemon.
        if ($_ -match 'ERROR|WARN') { Write-Log $_ }
    }

Write-Log 'Proses 9router berhenti.'

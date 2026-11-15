# Engine

The console spawns the binary configured at `engine.command` (default `engine/sing-box.exe`) as:

```text
<command> <engine.args…> run -c runtime/sing-box.json
```

## Install

```powershell
npm run engine:fetch
```

This downloads the latest official sing-box Windows release into this folder and verifies it with
`sing-box version`. Pin a version with `SINGBOX_VERSION=1.12.4` or replace it manually from
<https://github.com/SagerNet/sing-box/releases>.

sing-box 1.11+ is preferred (WireGuard `endpoints`). On 1.10 the console detects the version and falls
back to the legacy WireGuard `outbound` format.

## Notes

- `sing-box.exe` is gitignored.
- Engine stdout/stderr is forwarded to the App Log tab.
- The engine binds a `mixed` inbound to `127.0.0.1:41987`; it does not install a Windows service or
  change system routing, so no elevation is required.
- If another proxy already owns the port, the engine exits with a bind error and the console reports
  it in the App Log.

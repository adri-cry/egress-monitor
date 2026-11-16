# Engine

The console spawns the binary configured at `engine.command` (default `engine/sing-box.exe` on Windows,
`engine/sing-box` on Linux) as:

```text
<command> <engine.args…> run -c runtime/sing-box.json
```

## Install

```bash
npm run engine:fetch
```

This downloads the latest official sing-box release for your OS and CPU architecture (windows /
linux / darwin, amd64 / arm64) into this folder and verifies it with `sing-box version`. Pin a version
with `SINGBOX_VERSION=1.12.4`, or replace it manually from
<https://github.com/SagerNet/sing-box/releases>.

If the GitHub API rate-limits you, wait an hour or export a token first:
`GITHUB_TOKEN=ghp_… npm run engine:fetch`.

sing-box 1.11+ is preferred (WireGuard `endpoints`). On 1.10 the console detects the version and falls
back to the legacy WireGuard `outbound` format.

## Notes

- `sing-box.exe` / `sing-box` is gitignored.
- Engine stdout/stderr is forwarded to the App Log tab.
- The engine binds a `mixed` inbound to `127.0.0.1:41987`; it does not install a system service or
  change system routing, so no elevation (administrator/root) is required.
- If another proxy already owns the port, the engine exits with a bind error and the console reports
  it in the App Log.

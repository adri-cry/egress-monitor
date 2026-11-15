# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Electron + React (Vite), TailwindCSS 4, sing-box as a supervised child process, chokidar for log
watching. Windows-first desktop shell with a sandboxed preload bridge.

## Users

Windows-based developers and operators who rotate WARP egress prefixes while testing network failover
and dynamic IP routing. They keep the console open beside a client session, glance at protection state
between tasks, and need the last hop and its receipt to be legible immediately.

## Product Purpose

A local control deck for a pool of WireGuard configs: start and rotate a userspace sing-box proxy on
127.0.0.1:41987, hop /64s on demand or when `client.log` reports `QuotaExceeded`, keep the engine
alive, and show the real egress prefix, adapter address, pinned Cloudflare edge, and an audit-style
log. Success means an operator can confirm protection, trigger a hop, and read the resulting log event
without leaving the surface.

## Positioning

One fail-closed cockpit for egress rotation: pool selection, engine supervision, log-triggered hops,
egress verification, and the recovery log are visible together rather than split across terminal
windows and config files.

## Operating Context

Windows desktop; a local pool of WARP `.conf` files; a client app or CLI that writes `client.log`; a
local proxy on 127.0.0.1:41987; periodic quota responses during long client sessions; frequent short
check-ins while coding.

## Capabilities and Constraints

- Manages `warp-configs\*.conf` with natural sort and round-robin rotation; malformed configs are
  rejected and reported without stopping the pool.
- Renders and runs a sing-box config per hop (WireGuard `endpoints` on 1.11+, legacy `outbound` on
  1.10), waits for the local port, and verifies egress through the proxy.
- chokidar guard tails `client.log` from EOF, matches `QuotaExceeded`, enforces a cooldown, and writes
  the exact receipt line to the Guard log.
- Proxy Keeper polls the local port and restarts or rotates after consecutive failures; the engine is
  recovered after an unexpected exit.
- Toggles: Proxy Keeper, Log Guard, Desktop App Proxy (per-process proxy env injection), Auto-Start
  (Windows login item). All are real actions, persisted across runs.
- Four actions: Launch App, Launch CLI, Rotate /64 Now, Connect/Disconnect. Launch targets come from
  `settings.json`; nothing else is spawned.
- Status cards show the proxied public /64, engine/adapter state, resolved edge AAAA, hops, retired
  prefixes, and workspace project/chat counts.
- Constraints: Windows-first; sing-box must be installed; a client executable must be configured for
  Launch App; system-wide proxy changes are intentionally not made; stats show `—` when the workspace
  folders are absent.

## Brand Commitments

- Product name: EGRESS MONITOR.
- Deep navy/near-black ground with electric blue and vivid green accents, including a glowing green
  primary rotation action and a protected status pill.
- Technical, precise, operationally calm voice; no hype copy.

## Evidence on Hand

The implementation in `electron/` and `src/` is the source of truth. `settings.example.json` documents
every runtime setting; `screenshots/ui-1480.png` is a demo-data capture of the production renderer.

## Product Principles

1. Protection state is the first thing the eye finds, and it is never communicated by color alone.
2. Every action writes a human-readable receipt into the log; cause and effect stay adjacent.
3. Fail-closed language is explicit; the interface shows what is stopped, disconnected, or unverified.
4. Density is earned by live operational detail, not by decoration.
5. Real state is never replaced by invented state; missing data renders as an em dash and a reason.

## Accessibility & Inclusion

Keyboard reachable controls with visible focus, accessible switch semantics, correctly labelled tabs,
polite live announcements for state changes, reduced-motion support, tabular numerals, and text
contrast of at least 4.5:1 for body-size content.

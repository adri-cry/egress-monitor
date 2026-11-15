---
name: Egress Monitor
description: A local WARP IPv6 /64 rotator and egress monitor
colors:
  void-black: "#050a0f"
  deep-space: "#03080b"
  instrument-panel: "#08141d"
  instrument-raised: "#0a1822"
  instrument-soft: "#07111a"
  signal-blue: "#4b97ff"
  signal-blue-bright: "#7db9ff"
  protected-mint: "#4bf0a4"
  protected-mint-bright: "#86ffca"
  protected-deep: "#2fbe82"
  ink-primary: "#e9f3f8"
  ink-strong: "#f4fbff"
  ink-secondary: "#a4b9c6"
  ink-muted: "#7e95a2"
  ink-faint: "#697f8c"
  warning-amber: "#ffc36b"
  fault-red: "#ff8585"
typography:
  display:
    fontFamily: "Archivo Variable, Segoe UI Variable, Segoe UI, sans-serif"
    fontSize: "21px"
    fontWeight: 760
    lineHeight: 1.05
    letterSpacing: "0.035em"
  title:
    fontFamily: "Archivo Variable, Segoe UI Variable, Segoe UI, sans-serif"
    fontSize: "11.2px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "0.02em"
  body:
    fontFamily: "Archivo Variable, Segoe UI Variable, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  label:
    fontFamily: "IBM Plex Mono, Cascadia Mono, Consolas, monospace"
    fontSize: "8.5px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.11em"
  data:
    fontFamily: "IBM Plex Mono, Cascadia Mono, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "-0.02em"
    fontFeature: "\"tnum\" 1, \"zero\" 1"
rounded:
  control: "8px"
  card: "9px"
  panel: "10px"
  chip: "3px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "21px"
  xl: "28px"
components:
  action-primary:
    backgroundColor: "{colors.protected-mint}"
    textColor: "#04150d"
    rounded: "{rounded.control}"
    height: "48px"
    padding: "0 13px"
  action-secondary:
    backgroundColor: "{colors.instrument-raised}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.control}"
    height: "48px"
    padding: "0 13px"
  status-card:
    backgroundColor: "{colors.instrument-panel}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.card}"
    padding: "13px 14px 12px"
    minHeight: "155px"
  control-row:
    backgroundColor: "{colors.instrument-panel}"
    textColor: "{colors.ink-primary}"
    rounded: "0px"
    minHeight: "61px"
  log-panel:
    backgroundColor: "{colors.instrument-panel}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.panel}"
  switch-on:
    backgroundColor: "{colors.protected-mint}"
    rounded: "{rounded.pill}"
    width: "40px"
    height: "22px"
---

# Design System: Egress Monitor

## Overview

**Creative North Star: "The Fail-Closed Instrument Panel"**

Egress Monitor is a desktop cockpit for a Windows operator who needs to know, in one glance, whether the protected network lane is up. The visual world is a blue-black instrument bay: layered graphite panels, hairline rails, monospaced measurements, and two signal colors with narrowly defined jobs. It is closer to a network operations console than to a SaaS dashboard.

The design is deliberately dense but quiet. Uppercase micro-labels establish the system taxonomy, while the actual proof points — IPv6 addresses, edge identity, last hop, and log receipts — are set larger in IBM Plex Mono. Electric blue identifies the application and structural actions; mint green is reserved for protection, successful hops, and the single primary action. The bright green primary bay and the protected status pill carry the strongest glows; status dots and switch thumbs use only a restrained internal glow.

**Key characteristics:** fail-closed language, address-led hierarchy, hard-edged panels, one-screen operational proof, immediate action receipts, and live engine state stated in the interface.

## Colors

The palette is a near-black navy field with cool graphite surfaces. Blue carries identity; green carries protection and the hop action; amber and red appear only for warnings and faults. No hue is used decoratively.

- **Void black `#050a0f`** is the application field, overlaid with a faint 64px coordinate grid and two very low-opacity atmospheric radials.
- **Instrument graphite `#08141d` / `#0a1822`** differentiate the panels and raised controls from the field without introducing a second surface language.
- **Signal blue `#4b97ff`** belongs to the brand mark, system icons, focus indication, and outlined actions.
- **Protected mint `#4bf0a4`** is semantically constrained: protection state, online facts, successful rotation receipts, enabled switches, and the primary rotation action.
- **Ink scale** runs from `#f4fbff` for decisive numbers through `#a4b9c6` for secondary copy to `#697f8c` for peripheral labels. Muted text is never the only carrier of state.
- **Amber `#ffc36b` and fault red `#ff8585`** are reserved for disconnection, blocked clipboard access, and sealed/unauthorized conditions.

## Typography

Archivo Variable gives the interface its compact, engineered voice. It is used for headings, labels, action names, and descriptive copy, with weight doing the hierarchy work rather than an extra accent color. IBM Plex Mono is used only where exactness matters: IP addresses, edge IDs, timestamps, log output, port numbers, counts, and policy keycaps. It is not decorative monospace.

- Display: 21px / 760 weight / 1.05 line-height / 0.035em tracking for the product name.
- Panel titles: 10px–11px uppercase mono labels with 0.11em tracking.
- Addresses: 13px–17px mono with slightly negative tracking; the /64 is the largest data point on the page.
- Supporting copy: 9.5px–11px Archivo in `ink-secondary`.
- All numeric readouts use tabular numerals and slashed-zero figures where available.
- No gradient text. Emphasis comes from size, weight, and color role.

## Layout

The intended window is 1480×1040, with a 1120×780 minimum. The UI is pinned to a single operational viewport at the intended size: a 36px title strip, the brand/protection header, a four-bay action row, a four-card status band, then a two-pane workspace with policy switches and the config pool left and the log console right.

- Content width is capped at 1600px and centered, with a fluid `clamp(18px, 2.05vw, 31px)` gutter.
- The four status cards and four action bays use equal columns separated by a 16px gap.
- The workspace is a 1.16fr / 1fr split at desktop; the log panel receives enough width for 64-character receipts without breaking the timestamp column.
- The service list is a single joined rail with 1px dividers, not four nested cards, followed by the config pool chips and timing rail.
- Responsive behavior: gutters and microtype step down at 1240px; cards and actions collapse to two columns at 980px, the workspace stacks at 980px, then everything becomes one column at 660px. The custom title bar hides its context label on narrow widths.
- At heights below the content's natural size, the content region scrolls under the fixed custom title strip.

## Elevation & Depth

Depth is tonal, not dimensional. Panels sit above the field through a slightly lighter graphite fill, a 1px cool border, and a soft black offset shadow. Inner top highlights suggest a machined edge. There are no floating glass cards, blurred backdrops, or hard sticker shadows.

- Primary rotation bay: protected mint fill with a soft green outer glow and a bright top-edge highlight. It is the deliberate focal exception.
- Protected status pill: low-opacity green well, thin green border, and a contained radial halo.
- Cards: 9px radius, 1px hairline, inset top highlight, and a 0 10px 30px black shadow.
- Focus: 2px `#8ec4ff` outline with a 2px offset, visible on every interactive element.

## Shapes

Shapes are precise and machined. Panels use 9–10px radii; controls use 8px; metadata chips use 3px; only the logo mark, status pill, signal dots, and switches are fully round. Icons are drawn from Lucide at consistent 1.8–2.1 stroke weights and 11–18px optical sizes. No emoji, geometric glyphs, or mixed icon families.

## Components

- **Title bar:** 36px custom strip with a draggable region, product/context identity, an engine-state indicator, and Windows minimize/maximize/close controls. The controls are disabled when the app is rendered outside Electron.
- **Action bays:** four equal-height controls, 48px tall. The first two are outlined blue, the hop action is filled mint with a `HOP` keycap, and the WARP connection action is a dark neutral bay. Offline state disables the hop bay and renames the connection action to Reconnect WARP.
- **Status cards:** fixed role order (public /64, proxy adapter, pinned edge, stats). Tags are compact outlined chips. The edge card pins the resolved AAAA; the stats card includes a hop telemetry rail and retired-prefix proof.
- **Service rail:** four flexible rows with a 76px minimum height, each with icon, title, subtitle, optional state tag, ON/OFF label, and a 40×22 switch. The whole row remains readable when the switch is off; the switch turns grey while the receipt records the change.
- **Pool rail:** a two-column set of config chips under the switches, the active one highlighted in mint, with Change Folder and the guard/keeper timing line.
- **Log console:** a single dark pane with three text tabs, active-tab underline, live-tail indicator, and Copy action. Log lines use a two-column timestamp/message grid, with green success, amber warning, and red fault variants. It auto-scrolls to the latest entry while the reader stays at the bottom. The footer names the active log path and entry count.
- **Toast:** bottom-right status message with semantic icon and dismiss button, announced via a polite live region.
- **States:** hover raises borders and text contrast; active depresses slightly; disabled reduces saturation and blocks pointer use; all controls expose keyboard focus. Motion is limited to 150–250ms state transitions, the refresh icon, and toast arrival, and is disabled under `prefers-reduced-motion`.

## Do's and Don'ts

- **Do** keep mint green scarce and meaningful: protection, success, and the primary hop action only.
- **Do** set addresses and log data in IBM Plex Mono with tabular numerals; use the same treatment for every measured value.
- **Do** write a human-readable receipt for every state change and keep the affected log path named.
- **Do** preserve the distinction between the field, instrument panel, and raised control; the interface should still read as a calibrated console with all content removed.
- **Don't** introduce glassmorphism, gradient text, drop-shadow-heavy floating cards, or a second accent color.
- **Don't** let stale state masquerade as live network state; the status pill, engine card, probe timestamps, and log receipts are part of the interface truth.
- **Don't** represent status with color alone; pair every signal with an icon or explicit label.

### Asset provenance

There are no external image assets or stock rasters in the shipped UI. The capture in `screenshots/` is an app-generated reference from the production renderer at 1480×1040, populated with demo data. Live runs replace every address, count, and log line with values from the engine and egress probe.

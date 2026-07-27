# Context for the Workers-panel design slice

This note exists to unblock the slice "Anchor visual style from existing
Topology canvas" (mars-21cecac4) — the previous attempt exhausted its
read budget poking at the former `design/ui.pen` without ever writing.

## TL;DR for the next attempt

Everything you need to satisfy the acceptance criteria is already
enumerated below. (`design/ui.pen` has been retired; the tokens below
are the canonical reference.)

The new draft should be a small file under `design/` (markdown is fine —
the acceptance criteria say "a working note captured inside the new
design draft"; they do not require Penpot/JSON authoring). Suggested
path: `design/workers-panel.md` (or `design/workers-panel.pen` if you
prefer to mirror the JSON format — see "Format notes" below).

Then commit and stop. Verify is a no-op for this slice; there is no
frontend/orchestrator code to touch.

## Existing canvases (the style anchor)

The shell already has a left-rail navigation listing four canvases:

- **Topology** (active, fill `$mars-flame`)
- **Runs**
- **Timeline**
- **Inspector**

Workers will be the fifth peer in that rail. Match its visual language.

## Design tokens to reuse

All tokens are referenced as `$<name>` in the .pen JSON.

### Surfaces / backgrounds
- `$bg-light`        — page background
- `$surface-light`   — card / panel surface (light)
- `$surface-dark`    — card / panel surface (dark)

### Borders
- `$border-light`
- `$border-dark`

### Foreground / text
- `$fg-light`        — primary text on light surface
- `$fg-dark`         — primary text on dark surface
- `$muted-light`     — secondary / metadata text (light)
- `$muted-dark`      — secondary / metadata text (dark)
- `$label-dark`
- `$primary-text`

### Accents (the Mars palette — pick busy/idle from these)
- `$mars-flame`   — primary accent (used for active nav item)
- `$mars-amber`
- `$mars-ochre`
- `$mars-rust`
- `$mars-dust`
- `$mars-dune`
- `$mars-ice`
- `$mars-basalt`
- `$mars-iron`
- `$mars-night`

### Neutrals
- `$neutral-50`, `$neutral-100`, `$neutral-200`, `$neutral-300`,
  `$neutral-400`, `$neutral-500`, `$neutral-600`, `$neutral-700`,
  `$neutral-800`, `$neutral-900`

## Suggested busy/idle mapping

The acceptance criterion calls for "busy/idle status colors". A
defensible mapping that stays inside the Mars palette:

- **busy / active slot**  → `$mars-flame`  (already the active-nav accent)
- **idle / empty slot**   → `$muted-light` on `$surface-light`
- **queued / waiting**    → `$mars-amber`
- **error / blocked**     → `$mars-rust`

## Required legend (acceptance criterion 3)

The new draft must visibly list at least:

| Role                 | Token            |
|----------------------|------------------|
| Background           | `$bg-light`      |
| Surface              | `$surface-light` |
| Accent               | `$mars-flame`    |
| Text                 | `$fg-light`      |
| Busy status          | `$mars-flame`    |
| Idle status          | `$muted-light`   |

## Format notes

The token list above is the complete set originally extracted from the
retired `design/ui.pen` (a Penpot-style scene graph). The .pen file has
been removed; the token names above are the canonical reference.

# 07 — Styling

Tailwind. No design system, no component library. The shell is small
enough that a flat `tailwind.config.ts` carries the whole vocabulary.

## Palette

Pulled from a single source so light/dark stay coherent.

| Token | Light | Dark | Use |
|---|---|---|---|
| `bg` | `zinc-50` | `zinc-950` | shell background |
| `surface` | `white` | `zinc-900` | cards, inspector panel |
| `border` | `zinc-200` | `zinc-800` | hairlines |
| `fg` | `zinc-900` | `zinc-100` | body text |
| `muted` | `zinc-500` | `zinc-400` | timestamps, secondary |
| `accent` | `indigo-600` | `indigo-400` | links, focus rings |
| `ok` | `emerald-600` | `emerald-400` | done, pass |
| `warn` | `amber-600` | `amber-400` | needs-changes, halted |
| `bad` | `rose-600` | `rose-400` | failed, error events |
| `live` | `emerald-500` | `emerald-400` | live indicator (pulses) |

Role colors (used in event rows + agent lanes):

| Role | Color |
|---|---|
| `planner` | `violet-500` |
| `builder` | `sky-500` |
| `reviewer` | `amber-500` |
| `orchestrator` | `zinc-500` |
| `adapter` | `zinc-400` (lighter — supporting cast) |

These five colors are the only chromatic vocabulary in the timeline.
Everything else is monochrome.

## Typography

- **UI / body** — `Inter` (or system sans) at `text-sm` (14px).
- **Monospace** — `JetBrains Mono` (or system mono) at `text-xs` for IDs,
  paths, and JSON. Falls back to `ui-monospace`.
- **Numerics** — `tabular-nums` everywhere a number changes (counters,
  durations, token counts).

No custom font scale. Three sizes total: `text-xs`, `text-sm`,
`text-base`. If a heading needs to be bigger, it's the wrong heading.

## Density

Solo dev tool, terminal-adjacent. Default density is **compact**:

- 4px / 8px spacing rhythm.
- Row height in lists ≈ 44px.
- Event rows in the timeline ≈ 28px (one line of text + 4px breathing).
- Inspector padding 12px.

There is no "comfortable" toggle. If we add density modes, we've
overshot.

## Iconography

Single icon set: `lucide-react`. Don't mix sets.

Reserved icons:

- `circle-dot` (live)
- `check` (done)
- `flag` (halted)
- `x` (failed / error)
- `pin` (kept run)
- `info` (affordance line)
- `chevron-right` / `chevron-down` (disclosure)
- `external-link` (file open in $EDITOR)

If you find yourself reaching for a tenth icon, ask whether the UI is
trying to do too much.

## Focus & motion

- Visible focus ring (`ring-2 ring-accent`) on every interactive
  element. Keyboard-first design.
- Motion is **transitional, not decorative**. 150ms ease-out for
  disclosure; `pulse` only on the live dot. No skeleton shimmer; no
  loading spinners except the indeterminate progress bar in the
  "running…" timeline row.

## Tailwind config sketch

```ts
// tailwind.config.ts
export default {
  content: ['index.html', 'src/**/*.{ts,tsx}'],
  theme: {
    fontFamily: {
      sans: ['Inter', 'system-ui', 'sans-serif'],
      mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
    },
    extend: {
      colors: {
        live: '#10b981',
        role: {
          planner: '#8b5cf6',
          builder: '#0ea5e9',
          reviewer: '#f59e0b',
          orchestrator: '#71717a',
          adapter: '#a1a1aa',
        },
      },
      fontSize: {
        xs: ['0.75rem', '1rem'],
        sm: ['0.875rem', '1.25rem'],
        base: ['1rem', '1.5rem'],
      },
    },
  },
}
```

## Component primitives (in-house)

Five components carry the entire UI. Each is < 100 LOC.

| Component | Props | Used by |
|---|---|---|
| `<Shell>` | `{ children }` | every route |
| `<Tabs>` | `{ items, active }` | top bar |
| `<List>` | `{ rows, onSelect }` | runs view, inbox disclosure |
| `<JsonView>` | `{ value, depth=2 }` | inspector |
| `<Timeline>` | `{ events, onSelect }` | run-detail view |

No `<Button>`, `<Modal>`, `<Tooltip>`, `<Form>` — they don't exist
because the UI doesn't need them.

## Accessibility

- All interactive rows are real `<button>` or `<a>`, never click-handled
  divs.
- Color is never the only signal — every status icon has a textual
  label or `aria-label`.
- Reduced motion (`prefers-reduced-motion`) disables the live pulse
  and timeline auto-scroll animation.

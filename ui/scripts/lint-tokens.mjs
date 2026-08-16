#!/usr/bin/env node
/**
 * Token gate — components speak semantic tokens only (ADR: "UI components
 * speak semantic tokens only; Mars palette confined to stylesheet").
 *
 * Gate 1 — raw Mars palette classes:
 *   Fails when any .tsx file under src/ references a raw Mars palette class
 *   (bg-iron, text-flame, border-panel/40, ...). The palette lives solely in
 *   src/styles/index.css behind the semantic aliases.
 *
 * Gate 2 — raw Tailwind numeric-scale palette classes:
 *   Fails on text-red-400, bg-green-500, border-neutral-800, … Use the
 *   semantic tokens instead:
 *     red/error states  → text-error / bg-error / border-error (+ opacity)
 *     green/success     → text-success / bg-success / border-success
 *     yellow/warn       → text-warn / bg-warn / border-warn
 *     neutral/muted     → text-muted / text-muted-dark / text-fg-dark / …
 *
 * Gate 3 — arbitrary type-scale px classes:
 *   Fails when any .tsx file under src/ uses an arbitrary pixel font-size
 *   utility (text-[10px], text-[11.5px], …). All type-scale values must use
 *   the four design tokens: text-micro / text-label / text-body / text-title.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../src', import.meta.url).pathname

const UTILITY = 'bg|text|border|fill|stroke|ring|outline|decoration|divide|shadow|from|via|to'

// Rule 1 — Mars named-palette ban (no numeric shade suffix needed).
const MARS_PALETTE = 'flame|amber|iron|ochre|basalt|rust|dune|ice|panel|dust|night'
const BANNED_MARS = new RegExp(`\\b(?:[a-z-]+:)*(?:${UTILITY})-(?:${MARS_PALETTE})(?:\\b|/)`, 'g')

// Rule 2 — Tailwind numeric-scale ban (color + shade number).
// Covers every built-in Tailwind color family including the Mars-overridden
// neutral ramp; code must use named semantic tokens (error, success, warn,
// muted-dark, fg-dark, …) not the raw scale.
const TAILWIND_COLORS =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const TAILWIND_SHADES = '50|100|150|200|250|300|350|400|450|500|550|600|650|700|750|800|850|900|950'
const BANNED_SCALE = new RegExp(
  `\\b(?:[a-z-]+:)*(?:${UTILITY})-(?:${TAILWIND_COLORS})-(?:${TAILWIND_SHADES})(?:\\b|/)`,
  'g',
)

// Rule 3 — arbitrary px font-size utilities, with or without responsive/state
// prefixes:  text-[10px]  text-[10.5px]  sm:text-[9px]  hover:text-[11px]
const BANNED_PX_TEXT = /\b(?:[a-z-]+:)*text-\[\d+(?:\.\d+)?px\]/g

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    // Exclude test files — they legitimately reference palette / old type-scale
    // class names in assertion strings (e.g.
    // expect(html).not.toContain('text-red-400')).
    if (e.name.endsWith('.test.tsx') || e.name.endsWith('.spec.tsx')) return []
    return e.name.endsWith('.tsx') ? [p] : []
  })

const violations = []
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const marsHits = line.match(BANNED_MARS)
    const scaleHits = line.match(BANNED_SCALE)
    const paletteHits = [...(marsHits ?? []), ...(scaleHits ?? [])]
    if (paletteHits.length > 0)
      violations.push(`${relative(process.cwd(), file)}:${i + 1}  [palette] ${paletteHits.join(' ')}`)
    const pxText = line.match(BANNED_PX_TEXT)
    if (pxText)
      violations.push(
        `${relative(process.cwd(), file)}:${i + 1}  [px-text] ${pxText.join(' ')} — use text-micro/label/body/title`,
      )
  })
}

if (violations.length > 0) {
  console.error(`lint:tokens — ${violations.length} violation(s) in component code:`)
  for (const v of violations) console.error(`  ${v}`)
  console.error(
    'Use semantic tokens instead — type scale: text-micro/label/body/title; colors: error, success, warn, muted-dark, fg-dark, status-*, highlight, …',
  )
  process.exit(1)
}
console.error('lint:tokens — OK (no raw palette classes or arbitrary px text sizes in src/**/*.tsx)')

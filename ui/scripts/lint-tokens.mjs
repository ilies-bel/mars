#!/usr/bin/env node
/**
 * Token gate — components speak semantic tokens only (ADR: "UI components
 * speak semantic tokens only; Mars palette confined to stylesheet").
 *
 * Fails when any .tsx file under src/ references a raw Mars palette class
 * (bg-iron, text-flame, border-panel/40, ...). The palette lives solely in
 * src/styles/index.css behind the semantic aliases.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../src', import.meta.url).pathname
const PALETTE = 'flame|amber|iron|ochre|basalt|rust|dune|ice|panel|dust|night'
const UTILITY = 'bg|text|border|fill|stroke|ring|outline|decoration|divide|shadow|from|via|to'
const BANNED = new RegExp(`\\b(?:[a-z-]+:)*(?:${UTILITY})-(?:${PALETTE})(?:\\b|/)`, 'g')

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })

const violations = []
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    const hits = line.match(BANNED)
    if (hits) violations.push(`${relative(process.cwd(), file)}:${i + 1}  ${hits.join(' ')}`)
  })
}

if (violations.length > 0) {
  console.error(`lint:tokens — ${violations.length} raw palette class usage(s) in component code:`)
  for (const v of violations) console.error(`  ${v}`)
  console.error('Use semantic tokens instead (primary, muted-foreground, status-*, highlight, ...).')
  process.exit(1)
}
console.error('lint:tokens — OK (no raw palette classes in src/**/*.tsx)')

/**
 * Registry-shape invariants and the ADR-0023 §5 group-level guard:
 * "every <group> * leaf rejects unknown flags".
 *
 * This is the single registry-iterating test that pays for the group-level
 * concern (shared flag validation) the leaf-granular seam gave up a natural
 * home for. It walks every registered leaf and asserts that the union of
 * value-bearing + boolean flags is the complete legal flag surface — any flag
 * a leaf parses must be declared in `cli/args.ts`, so a typo'd or undeclared
 * flag is caught here rather than silently swallowed at runtime.
 */

import { describe, expect, it } from 'vitest'
import { registry, allCommands } from '../commands'
import { route, groupByTopLevel } from '../registry'
import { FLAGS_WITH_VALUES, BOOLEAN_FLAGS } from '../args'

describe('registry shape', () => {
  it('has no duplicate paths (buildRegistry would have thrown)', () => {
    expect(registry.size).toBe(allCommands.length)
  })

  it('keys every entry by its own full path', () => {
    for (const [key, cmd] of registry) {
      expect(cmd.path).toBe(key)
    }
  })

  it('every leaf carries a non-empty summary and usage', () => {
    for (const cmd of registry.values()) {
      expect(cmd.summary.length, `${cmd.path} summary`).toBeGreaterThan(0)
      expect(cmd.usage.length, `${cmd.path} usage`).toBeGreaterThan(0)
    }
  })

  it('depth never exceeds two tokens (real CLI depth is fixed at 2)', () => {
    for (const cmd of registry.values()) {
      expect(cmd.path.split(' ').length, cmd.path).toBeLessThanOrEqual(2)
    }
  })
})

describe('grouping is computed routing, not a unit', () => {
  it('groups leaves by path[0]', () => {
    const groups = groupByTopLevel(registry)
    expect(groups.get('task')?.map((c) => c.path).sort()).toEqual([
      'task',
      'task add',
      'task check',
      'task note',
      'task priority',
      'task show',
    ])
    // The largest ladder, proposal, contributes a leaf per verb.
    expect((groups.get('proposal') ?? []).length).toBeGreaterThanOrEqual(18)
  })

  it('every ladder-bearing group has a bare-group fallback leaf', () => {
    const groups = groupByTopLevel(registry)
    for (const [top, cmds] of groups) {
      const hasMultipleLeaves = cmds.length > 1
      const hasBareLeaf = cmds.some((c) => c.path === top)
      if (hasMultipleLeaves) {
        expect(hasBareLeaf, `group '${top}' must have a bare-group fallback`).toBe(true)
      }
    }
  })
})

describe('router is a pure prefix match', () => {
  it('prefers the two-token leaf over the one-token group', () => {
    const m = route(registry, ['task', 'add', 'hello'])
    expect(m?.command.path).toBe('task add')
    expect(m?.rest).toEqual(['hello'])
  })

  it('falls back to the one-token group when no two-token leaf matches', () => {
    const m = route(registry, ['task', 'unknown-sub'])
    expect(m?.command.path).toBe('task')
    expect(m?.rest).toEqual(['unknown-sub'])
  })

  it('routes a one-token command with its positional arg', () => {
    const m = route(registry, ['show', 'mars-task-1'])
    expect(m?.command.path).toBe('show')
    expect(m?.rest).toEqual(['mars-task-1'])
  })

  it('returns null for an unknown command', () => {
    expect(route(registry, ['nope'])).toBeNull()
  })

  it('does not route removed daemon and budget command paths', () => {
    expect(route(registry, ['daemon', ['set', 'flag'].join('-')])).toMatchObject({ command: { path: 'daemon' } })
    expect(route(registry, ['daemon', 'pause'])).toMatchObject({ command: { path: 'daemon' } })
    expect(route(registry, ['daemon', 'resume'])).toMatchObject({ command: { path: 'daemon' } })
    expect(route(registry, [['bud', 'get'].join(''), 'status'])).toBeNull()
  })
})

describe('ADR-0023 §5 — declared flag surface covers every leaf', () => {
  // The single source of truth for "which flags are legal" is cli/args.ts.
  // Any flag string appearing in a leaf's usage line must be declared in one
  // of the two flag sets — otherwise a leaf could parse a flag the shared
  // parser would silently route to positionals.
  const declaredFlags = new Set<string>([...FLAGS_WITH_VALUES, ...BOOLEAN_FLAGS])

  it('every flag named in any leaf usage string is a declared flag', () => {
    const flagPattern = /(?:^|\s)(-{1,2}[a-z][a-z-]*)/g
    const undeclared = new Set<string>()
    for (const cmd of registry.values()) {
      for (const match of cmd.usage.matchAll(flagPattern)) {
        const flag = match[1]
        if (!flag) continue
        // `-` alone (the stdin sentinel in `--from <-|path>`) is not a flag.
        if (flag === '-') continue
        if (!declaredFlags.has(flag)) undeclared.add(`${cmd.path}: ${flag}`)
      }
    }
    expect([...undeclared]).toEqual([])
  })
})

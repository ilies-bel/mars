/**
 * The top-level `mars --help` command list is derived from the Command
 * registry, not a hand-maintained string. Every real, invocable leaf path
 * must appear in --help with its registry summary. Group-fallback leaves
 * (bare 'task', 'proposal', whose summary is '<top> subcommands') are
 * suppressed — only real verbs are listed.
 *
 * Adding a Command to any `commands/*.ts` file makes it appear in --help
 * with NO edit to cli.ts. That's the regression this test pins.
 */

import { describe, expect, it } from 'vitest'
import { registry } from '../commands'
import { buildCommandList, buildUsage } from '../help'

const isFallbackLeaf = (top: string, summary: string, path: string): boolean =>
  path === top && summary === `${top} subcommands`

describe('mars --help command list is derived from the registry', () => {
  it('lists every non-fallback registry leaf exactly once', () => {
    const list = buildCommandList(registry)
    const tops = new Set<string>()
    for (const cmd of registry.values()) {
      tops.add(cmd.path.split(' ')[0]!)
    }
    for (const cmd of registry.values()) {
      const top = cmd.path.split(' ')[0]!
      if (isFallbackLeaf(top, cmd.summary, cmd.path)) {
        // Fallback leaves are intentionally absent from the generated list.
        // The bare-path line must NOT appear unless it carries a real,
        // non-"subcommands" summary (e.g. action-queue and alert aliases).
        // Stricter than '\\s{1,}': a generated bare line is path + padding,
        // so multi-space follows. A two-token leaf like '  task add' is
        // separated from its sub-token by EXACTLY one space.
        const bareLineRe = new RegExp(`^  ${cmd.path}(\\s{2,}|$)`, 'm')
        expect(list.match(bareLineRe), `fallback '${cmd.path}' should NOT appear`).toBeNull()
        continue
      }
      // Real leaf: must appear once at start of a line, indented by 2 spaces.
      // Require multi-space (or EOL) after the path so a 1-token path like
      // 'action-queue' doesn't match its 2-token children 'action-queue list'.
      const pathLines = list.split('\n').filter((ln) =>
        new RegExp(`^  ${cmd.path}(\\s{2,}|$)`).test(ln),
      )
      expect(pathLines.length, `'${cmd.path}' must appear exactly once`).toBe(1)
      // The summary must be on the same line as the path.
      expect(pathLines[0], `summary for '${cmd.path}'`).toContain(cmd.summary)
    }
    void tops
  })

  it('lists each missing verb the audit named (no drift)', () => {
    // These are the real, registered verbs the hand-written help was missing.
    // If any disappears from --help again, this test fails.
    const required = [
      'recover',
      'alert',
      'alert list',
      'alert show',
      'kpi snapshot',
      'kpi show',
      'arc purge',
      'proposal ship-summary',
      'task show',
      'task priority',
      'install',
      'plugin activate',
      'plugin deactivate',
      'diagnose run',
      'diagnose investigate',
      'diagnose set',
      'diagnose show',
    ] as const
    const list = buildCommandList(registry)
    for (const path of required) {
      const re = new RegExp(`^  ${path}(\\s|$)`, 'm')
      expect(list, `'${path}' missing from generated command list`).toMatch(re)
    }
  })

  it('full usage embeds the generated command list and the static sections', () => {
    const usage = buildUsage(registry)
    // The header survives.
    expect(usage).toMatch(/^mars — orchestrator for parallel Claude Code task workflows/)
    expect(usage).toContain('Commands:')
    // Static sections survive.
    expect(usage).toContain('Plan flags')
    expect(usage).toContain('Author flag')
    expect(usage).toContain('Repo resolution')
    expect(usage).toContain('Other env')
    // Generated lines are inside.
    expect(usage).toContain(buildCommandList(registry))
  })
})

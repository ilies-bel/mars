/**
 * Acceptance tests for slice 12 of PRD
 * `6c93eb31-per-step-execution-mode-auto-manual-on-w`:
 *
 * - The bundled `workflow-author` skill exists at the expected path.
 * - It has the required SKILL frontmatter: `name: workflow-author` and a description.
 * - The skill body instructs the operator to run `mars workflow validate <kind>`
 *   after every edit.
 * - The skill body instructs to render with `mars workflow render <kind> --json`
 *   to confirm per-step execution modes.
 * - The skill references `runbook-workflow.js` as the starter template.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SKILL_PATH = resolve(
  __dirname,
  '..',
  'templates',
  'claude',
  'skills',
  'workflow-author',
  'SKILL.md',
)

describe('workflow-author skill: bundled SKILL.md', () => {
  it('exists at the expected bundled path', () => {
    expect(existsSync(SKILL_PATH)).toBe(true)
  })

  describe('frontmatter', () => {
    const content = readFileSync(SKILL_PATH, 'utf8')

    it('declares name: workflow-author', () => {
      expect(content).toMatch(/^name:\s+workflow-author\s*$/m)
    })

    it('has a non-empty description field', () => {
      expect(content).toMatch(/^description:\s+\S/m)
    })

    it('includes trigger phrases in the description', () => {
      // The description must tell the Claude Code harness when to invoke this
      // skill. Check for at least one of the canonical trigger phrases.
      expect(content).toMatch(
        /workflow-author|scaffold a workflow|author a pipeline|create a workflow/i,
      )
    })
  })

  describe('skill body', () => {
    const content = readFileSync(SKILL_PATH, 'utf8')

    it('instructs to run mars workflow validate after every edit', () => {
      expect(content).toContain('mars workflow validate')
    })

    it('instructs to run mars workflow render --json to confirm step modes', () => {
      expect(content).toContain('mars workflow render')
      expect(content).toContain('--json')
    })

    it('references runbook-workflow.js as the starter template', () => {
      expect(content).toContain('runbook-workflow.js')
    })

    it('asks for a kind name (step 0)', () => {
      // The skill must guide the user through providing a workflow kind name.
      expect(content.toLowerCase()).toMatch(/kind|slug/)
    })

    it('mentions both auto and manual execution modes', () => {
      expect(content).toContain('auto')
      expect(content).toContain('manual')
    })
  })
})

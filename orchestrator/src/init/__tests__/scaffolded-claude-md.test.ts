/**
 * Acceptance tests for slice 11 of PRD
 * `6c93eb31-per-step-execution-mode-auto-manual-on-w`:
 *
 * - The bundled CLAUDE.md template contains a `## Routing` section with
 *   the three-line doctrine (grill / background / live).
 * - The section names `mars workflow list` and `mars workflow render` as
 *   the enumeration commands and says to pick the workflow whose steps
 *   fit the goal.
 * - After `mars init` writes to a fixture repo, the generated CLAUDE.md
 *   contains the same section (integration test).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scaffoldClaudeConfig } from '../scaffold'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BUNDLED_TEMPLATE_PATH = resolve(
  __dirname,
  '..',
  'templates',
  'CLAUDE.md',
)

// ---------------------------------------------------------------------------
// Routing-section content checks against the bundled template
// ---------------------------------------------------------------------------

describe('scaffolded CLAUDE.md: ## Routing section', () => {
  it('contains a ## Routing heading', () => {
    const content = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    expect(content).toMatch(/^##\s+Routing/m)
  })

  it('names mars workflow list as an enumeration command', () => {
    const content = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    expect(content).toContain('mars workflow list')
  })

  it('names mars workflow render as the step-guide enumeration command', () => {
    const content = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    expect(content).toContain('mars workflow render')
  })

  it('does NOT reference mars workflow validate as the render command', () => {
    // workflow validate sanity-checks a file; workflow render prints the guide.
    // The routing doc should point operators to the readable command.
    const content = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    // The section must not instruct operators to use validate for reading the runbook.
    // (validate may appear elsewhere in the file legitimately, but the routing
    // paragraph's "renderable via" phrase must point at render.)
    expect(content).not.toContain('renderable via `mars workflow validate')
  })

  it('says to pick the pipeline whose shape fits the work', () => {
    const content = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    expect(content).toContain('shape fits')
  })

  it('contains the three routing lines (grill, background/enqueue, live)', () => {
    const content = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    // Line 1: grill for hard/cross-repo work
    expect(content).toMatch(/grill/i)
    // Line 2: background / enqueue for small tweaks
    expect(content).toContain('mars task add')
    // Line 3: live task for user-present work
    expect(content).toContain('mars task add --live')
  })

  it('snapshot: the ## Routing section matches the expected doctrine', () => {
    const content = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    // Extract the ## Routing section up to the next ## heading.
    const match = content.match(/^(##\s+Routing[\s\S]*?)(?=^##\s)/m)
    expect(match).not.toBeNull()
    const section = match![1]
    expect(section).toMatchInlineSnapshot(`
      "## Routing

      Route silently between three pipelines — never name the route, narrate
      the decision, or ask the user to pick. Reads and searches are always
      direct.

      **General rule:** run \`mars workflow list\` to see every available
      pipeline. Each is a runbook with declared execution modes and Step
      guides, renderable via \`mars workflow render <name>\`. Pick the
      pipeline whose shape fits the work and select it at enqueue with
      \`--workflow <name>\`.

      The three lines:

      1. **Hard / cross-repo / term-defining work → grill first.** While
         grilling, file \`mars proposal add\` for out-of-scope observations
         and enqueue high-confidence loose ends directly (\`mars task add\`).
      2. **Small tweaks / backend work → background task.** \`mars task add
         "..."\` — the orchestrator dispatches, codes, verifies, and merges
         headlessly.
      3. **Visual or user-present work → live task.** \`mars task add --live\`;
         the task parks in \`awaiting-human\` with the Step guide in the action
         queue. Work in the worktree, then \`mars step done <id>\`. The verify +
         merge gate is the exit condition.

      **Direct editing on the integration branch is a last resort, not a
      fourth route.** It is never silent and never implied. The bar is all of:

      - the user explicitly opts in *for this specific change* (a prior
        session-level "you can edit directly" does **not** carry over);
      - the orchestrator path is genuinely unavailable or unsuitable;
      - you state out loud that you are bypassing the orchestrator and why,
        before the first \`Edit\`/\`Write\`.

      When in doubt, enqueue. A redundant task is cheap; a silent commit on
      the integration branch is not.

      "
    `)
  })
})

// ---------------------------------------------------------------------------
// Integration: mars init writes the same section into the target repo
// ---------------------------------------------------------------------------

describe('mars init: CLAUDE.md written to fixture repo contains ## Routing section', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-scaffolded-claude-md-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a CLAUDE.md containing the ## Routing heading', () => {
    const result = scaffoldClaudeConfig({ repoRoot: root })
    expect(result.status).toBe('ok')

    const written = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')
    expect(written).toMatch(/^##\s+Routing/m)
  })

  it('written CLAUDE.md names mars workflow list', () => {
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')
    expect(written).toContain('mars workflow list')
  })

  it('written CLAUDE.md names mars workflow render as the step-guide command', () => {
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')
    expect(written).toContain('mars workflow render')
  })

  it('written CLAUDE.md contains the three routing lines', () => {
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')
    expect(written).toMatch(/grill/i)
    expect(written).toContain('mars task add')
    expect(written).toContain('mars task add --live')
  })

  it('written CLAUDE.md is byte-for-byte the bundled template', () => {
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, 'CLAUDE.md'))
    const bundled = readFileSync(BUNDLED_TEMPLATE_PATH)
    expect(written.equals(bundled)).toBe(true)
  })
})

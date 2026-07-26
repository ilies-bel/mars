/**
 * Tests for the tool-forge pipeline:
 *   1. The bundled JS template exists in the templates dir (backs `mars workflow list`)
 *   2. The bundled template has the correct id and step structure
 *   3. TOOL_FORGE_PROMPT_TEMPLATE contains the required placeholders and exact paths
 *   4. buildToolForgePrompt renders concrete values into the exact target paths
 *   5. Snapshot of the rendered prompt for a fixed input
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TOOL_FORGE_PROMPT_TEMPLATE,
  buildToolForgePrompt,
} from '../tool-forge-workflow'

// Path to the bundled template that `mars init` scaffolds into .mars/workflows/
const BUNDLED_TEMPLATE_PATH = resolve(
  __dirname,
  '../../../src/init/templates/workflows/tool-forge-workflow.js',
)

// ── 1. Bundled template presence (backs `mars workflow list`) ──────────────

describe('tool-forge bundled template', () => {
  it("exists in the templates dir so `mars workflow list` includes 'tool-forge'", () => {
    expect(existsSync(BUNDLED_TEMPLATE_PATH)).toBe(true)
  })

  it("declares id 'tool-forge' matching the filename stem", () => {
    const source = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    // The id field is load-bearing (mars workflow validate reads it)
    expect(source).toContain("id: 'tool-forge'")
  })

  it('imports from the mars/workflow surface (defineWorkflow + four primitives)', () => {
    const source = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    expect(source).toContain("from 'mars/workflow'")
    expect(source).toContain('defineWorkflow')
    expect(source).toContain('setupWorktree')
    expect(source).toContain('runAgent')
    expect(source).toContain('review')
    expect(source).toContain('merge')
  })

  it('declares the four canonical step names (load-bearing for checkpoint-resume)', () => {
    const source = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    expect(source).toContain("'setup'")
    expect(source).toContain("'code'")
    expect(source).toContain("'review'")
    expect(source).toContain("'merge'")
  })

  it('carries the template version marker (enables mars update diff logic)', () => {
    const source = readFileSync(BUNDLED_TEMPLATE_PATH, 'utf8')
    expect(source).toContain('@mars-workflow-template:v')
  })
})

// ── 2. TOOL_FORGE_PROMPT_TEMPLATE placeholders ────────────────────────────

describe('TOOL_FORGE_PROMPT_TEMPLATE', () => {
  it('contains the <helper_key> placeholder', () => {
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toContain('<helper_key>')
  })

  it('contains the <motivating_arc_ids> placeholder', () => {
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toContain('<motivating_arc_ids>')
  })

  it('references the exact helper target path (with placeholder)', () => {
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toContain(
      'orchestrator/src/tools/<helper_key>/index.ts',
    )
  })

  it('references the exact benchmark target path (with placeholder)', () => {
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toContain(
      'orchestrator/benchmarks/<helper_key>.bench.ts',
    )
  })

  it('includes the Save your work line per CLAUDE.md convention', () => {
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toMatch(/Save your work/i)
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toContain('git add')
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toContain('git commit')
  })

  it('instructs the coder to run the benchmark (verify step context)', () => {
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toMatch(/benchmark/i)
    expect(TOOL_FORGE_PROMPT_TEMPLATE).toContain('.bench.ts')
  })
})

// ── 3. buildToolForgePrompt rendering ─────────────────────────────────────

describe('buildToolForgePrompt', () => {
  const HELPER_KEY = 'extract-retry-payload'
  const ARC_IDS = ['mars-abc12345', 'mars-def67890']

  it('substitutes <helper_key> with the concrete helper key', () => {
    const prompt = buildToolForgePrompt(HELPER_KEY, ARC_IDS)
    expect(prompt).not.toContain('<helper_key>')
    expect(prompt).toContain(HELPER_KEY)
  })

  it('substitutes <motivating_arc_ids> with the comma-joined arc ids', () => {
    const prompt = buildToolForgePrompt(HELPER_KEY, ARC_IDS)
    expect(prompt).not.toContain('<motivating_arc_ids>')
    expect(prompt).toContain(ARC_IDS.join(', '))
  })

  it('renders the exact helper index.ts path', () => {
    const prompt = buildToolForgePrompt(HELPER_KEY, ARC_IDS)
    expect(prompt).toContain(
      `orchestrator/src/tools/${HELPER_KEY}/index.ts`,
    )
  })

  it('renders the exact benchmark .bench.ts path', () => {
    const prompt = buildToolForgePrompt(HELPER_KEY, ARC_IDS)
    expect(prompt).toContain(
      `orchestrator/benchmarks/${HELPER_KEY}.bench.ts`,
    )
  })

  it('renders all occurrences of <helper_key> (multiple substitutions)', () => {
    const prompt = buildToolForgePrompt(HELPER_KEY, ARC_IDS)
    // The template uses <helper_key> in multiple places (files section,
    // acceptance criteria, verify, commit message). None should survive.
    expect(prompt).not.toContain('<helper_key>')
  })

  it('handles a single arc id (no trailing comma)', () => {
    const prompt = buildToolForgePrompt(HELPER_KEY, ['mars-only-one'])
    expect(prompt).toContain('mars-only-one')
    expect(prompt).not.toContain('<motivating_arc_ids>')
  })

  it('handles an empty arc ids list', () => {
    const prompt = buildToolForgePrompt(HELPER_KEY, [])
    // Joins to an empty string — no placeholder, no crash
    expect(prompt).not.toContain('<motivating_arc_ids>')
  })

  // ── 4. Snapshot of rendered prompt for a fixed input ──────────────────
  it('snapshot: rendered prompt for a fixed helper key and arc ids', () => {
    const prompt = buildToolForgePrompt('parse-recovery-signals', [
      'mars-11111111',
      'mars-22222222',
    ])
    expect(prompt).toMatchInlineSnapshot(`
      "# Tool-forge: create helper parse-recovery-signals

      ## What to build

      Create a small helper module at orchestrator/src/tools/parse-recovery-signals/index.ts and a
      benchmark file at orchestrator/benchmarks/parse-recovery-signals.bench.ts that replays each
      motivating arc id: mars-11111111, mars-22222222.

      The benchmark must exercise the helper in a way that can also be run without it, so
      the verify step can confirm correctness in both configurations.

      ## Files

      - NEW: orchestrator/src/tools/parse-recovery-signals/index.ts
      - NEW: orchestrator/benchmarks/parse-recovery-signals.bench.ts

      ## Acceptance criteria

      - [ ] orchestrator/src/tools/parse-recovery-signals/index.ts exports the helper and is
        well-typed (no implicit \`any\`)
      - [ ] orchestrator/benchmarks/parse-recovery-signals.bench.ts imports from
        orchestrator/src/tools/parse-recovery-signals/index.ts and replays each motivating arc
        id: mars-11111111, mars-22222222
      - [ ] Benchmark passes without the helper (baseline run)
      - [ ] Benchmark passes with the helper (regression guard)

      ## Verify

      Run the benchmark twice:
        cd orchestrator && npx vitest bench benchmarks/parse-recovery-signals.bench.ts
        cd orchestrator && npx vitest bench benchmarks/parse-recovery-signals.bench.ts --reporter=verbose

      ## Save your work

      Stage and commit when done:

      \`\`\`
      git add -A
      git commit -m "feat(tools): add parse-recovery-signals helper + benchmark"
      \`\`\`
      "
    `)
  })
})

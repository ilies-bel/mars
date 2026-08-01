/**
 * Acceptance tests for slice 2 of PRD
 * `95d11715-accept-root-child-manifests-in-mars-init`:
 *
 * - The root `CLAUDE.md` `mars init` writes into a target repo is the
 *   bundled Mars-meta template, NOT a copy of the framework's own
 *   `CLAUDE.md`.
 * - The template mentions the routing rules and the orchestrator / actionQueue /
 *   glossary / ADR commands an operator of a Mars-managed repo needs.
 * - The template carries no references to framework-internal directories
 *   that only exist inside the mars-framework repo itself.
 * - The on-disk output of `mars init` matches the bundled template
 *   byte-for-byte.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planClaudeCopies, scaffoldClaudeConfig } from '../scaffold'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BUNDLED_TEMPLATE_PATH = resolve(
  __dirname,
  '..',
  'templates',
  'CLAUDE.md',
)

const FRAMEWORK_CLAUDE_MD_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'CLAUDE.md',
)

describe('mars init: root CLAUDE.md template', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-root-claude-template-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a root CLAUDE.md whose content matches the bundled template byte-for-byte', () => {
    const result = scaffoldClaudeConfig({ repoRoot: root })
    expect(result.status).toBe('ok')

    const written = readFileSync(resolve(root, 'CLAUDE.md'))
    const bundled = readFileSync(BUNDLED_TEMPLATE_PATH)
    // `Buffer.equals` performs a true byte-for-byte comparison and will
    // catch any encoding or trailing-newline drift between the bundled
    // template and what `mars init` actually drops on disk.
    expect(written.equals(bundled)).toBe(true)
  })

  it('does not write a verbatim copy of the framework\'s own CLAUDE.md', () => {
    const result = scaffoldClaudeConfig({ repoRoot: root })
    expect(result.status).toBe('ok')

    const written = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')
    const framework = readFileSync(FRAMEWORK_CLAUDE_MD_PATH, 'utf8')
    expect(written).not.toBe(framework)
  })

  it('contains the routing rules and mentions the orchestrator, actionQueue, glossary, and ADR commands', () => {
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')

    // Routing rules
    expect(written).toMatch(/##\s+Routing/)
    expect(written).toContain('enqueue')
    expect(written).toContain('grill')
    expect(written).toContain('mars task add')

    // The orchestrator
    expect(written.toLowerCase()).toContain('orchestrator')

    // Action queue commands
    expect(written).toContain('mars action-queue')

    // Glossary commands
    expect(written).toMatch(/mars glossary\s+(set|list|show|remove)/)

    // ADR commands
    expect(written).toMatch(/mars adr\s+(add|list|show)/)

    // Incident kill-switch is available through the unified operator surface.
    expect(written).toContain('mars operator set recovery')
  })

  it('contains no references to framework-internal paths that only exist inside the mars-framework repo', () => {
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, 'CLAUDE.md'), 'utf8')

    // Each of these is a path or symbol that only makes sense inside the
    // mars-framework repo itself; none of them should leak into the
    // CLAUDE.md that ships to target repos.
    const forbidden: ReadonlyArray<string> = [
      'orchestrator/',
      'orchestrator/src/core',
      'ui/',
      'design/',
      'get-mars.sh',
      'install.sh',
      'mars-framework',
      'Mastra Studio',
      'MARS_WORKER_MODEL',
    ]
    for (const needle of forbidden) {
      expect(written, `template leaks framework-internal token ${JSON.stringify(needle)}`).not.toContain(needle)
    }
  })

  it('loads the template from a bundled file alongside the compiled scaffold module', () => {
    // The bundled template MUST exist next to the scaffold module so that
    // `scaffoldClaudeConfig` can find it both when running from source and
    // from a compiled artefact. If a future refactor moves the template
    // out of `src/init/templates/`, this test fails loudly.
    expect(() => readFileSync(BUNDLED_TEMPLATE_PATH)).not.toThrow()

    // And the bundled file MUST be what `scaffoldClaudeConfig` writes.
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, 'CLAUDE.md'))
    const bundled = readFileSync(BUNDLED_TEMPLATE_PATH)
    expect(written.equals(bundled)).toBe(true)
  })

  it('does not write any .claude/ files into the consumer repo (plugin delivers those)', () => {
    // The .claude/ config tree (skills, agents, hooks, settings) is now
    // delivered via the Claude Code plugin registered at install time.
    // mars init MUST NOT write any files under .claude/ so the consumer's
    // repository config stays clean and is not overwritten on update.
    scaffoldClaudeConfig({ repoRoot: root })

    const claudeDir = resolve(root, '.claude')
    expect(existsSync(claudeDir)).toBe(false)
  })
})

const BUNDLED_MCP_JSON_PATH = resolve(
  __dirname,
  '..',
  'templates',
  '.mcp.json',
)

describe('mars init: .mcp.json scaffold', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), 'mars-mcp-scaffold-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('.mcp.json is in the planClaudeCopies candidate set', () => {
    const copies = planClaudeCopies(root)
    const rels = copies.map((c) => c.rel)
    expect(rels).toContain('.mcp.json')
  })

  it('writes .mcp.json to the target repo root with the codegraph server block intact', () => {
    const result = scaffoldClaudeConfig({ repoRoot: root })
    expect(result.status).toBe('ok')
    expect((result as { status: 'ok'; written: string[] }).written).toContain('.mcp.json')

    const written = readFileSync(resolve(root, '.mcp.json'), 'utf8')
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect(parsed).toHaveProperty('mcpServers')
    const servers = parsed['mcpServers'] as Record<string, unknown>
    expect(servers).toHaveProperty('codegraph')
  })

  it('written .mcp.json matches the bundled template byte-for-byte', () => {
    scaffoldClaudeConfig({ repoRoot: root })
    const written = readFileSync(resolve(root, '.mcp.json'))
    const bundled = readFileSync(BUNDLED_MCP_JSON_PATH)
    expect(written.equals(bundled)).toBe(true)
  })

  it('does NOT overwrite a pre-existing .mcp.json (no-clobber rule)', () => {
    const dest = resolve(root, '.mcp.json')
    const original = JSON.stringify({ mcpServers: { myServer: {} } })
    writeFileSync(dest, original, 'utf8')

    const result = scaffoldClaudeConfig({ repoRoot: root })
    // The conflict is reported; the file is left untouched.
    expect(result.status).toBe('conflict')
    expect((result as { status: 'conflict'; conflicts: string[] }).conflicts).toContain('.mcp.json')
    expect(readFileSync(dest, 'utf8')).toBe(original)
  })

  it('force:true overwrites a pre-existing .mcp.json', () => {
    const dest = resolve(root, '.mcp.json')
    writeFileSync(dest, '{"mcpServers":{}}', 'utf8')

    const result = scaffoldClaudeConfig({ repoRoot: root, force: true })
    expect(result.status).toBe('ok')

    const written = readFileSync(dest)
    const bundled = readFileSync(BUNDLED_MCP_JSON_PATH)
    expect(written.equals(bundled)).toBe(true)
  })
})

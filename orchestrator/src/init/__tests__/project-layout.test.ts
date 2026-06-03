import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateProjectLayoutBlock,
  enrichRootClaudeMd,
  type ProjectLayoutEntry,
} from '../project-layout'

const LAYOUT_START = '<!-- mars:project-layout:start -->'
const LAYOUT_END = '<!-- mars:project-layout:end -->'

const GATEWAY_ENTRY: ProjectLayoutEntry = {
  folder: 'gateway',
  techs: ['node', 'typescript'],
  supervisorName: 'node-backend-supervisor',
  persona: 'Nina',
  verifyCommands: ['npx tsc --noEmit', 'npm test --silent'],
}

const DASHBOARD_ENTRY: ProjectLayoutEntry = {
  folder: 'dashboard',
  techs: ['javascript', 'react', 'typescript'],
  supervisorName: 'react-supervisor',
  persona: 'Luna',
  verifyCommands: ['npx tsc --noEmit', 'npm test --silent'],
}

const BASELINE_ENTRY: ProjectLayoutEntry = {
  folder: '.',
  techs: [],
  supervisorName: 'baseline-supervisor',
  persona: 'Echo',
  verifyCommands: [],
}

describe('generateProjectLayoutBlock', () => {
  it('returns an empty string when entries is empty', () => {
    expect(generateProjectLayoutBlock([])).toBe('')
  })

  it('wraps the block in the expected marker comments', () => {
    const block = generateProjectLayoutBlock([GATEWAY_ENTRY])
    expect(block).toContain(LAYOUT_START)
    expect(block).toContain(LAYOUT_END)
    expect(block.indexOf(LAYOUT_START)).toBeLessThan(block.indexOf(LAYOUT_END))
  })

  it('lists each declared folder in a table row', () => {
    const block = generateProjectLayoutBlock([GATEWAY_ENTRY, DASHBOARD_ENTRY])
    expect(block).toContain('gateway')
    expect(block).toContain('dashboard')
  })

  it('lists the technology list for each entry', () => {
    const block = generateProjectLayoutBlock([GATEWAY_ENTRY, DASHBOARD_ENTRY])
    expect(block).toContain('node, typescript')
    expect(block).toContain('javascript, react, typescript')
  })

  it('lists the supervisor persona and name for each entry', () => {
    const block = generateProjectLayoutBlock([GATEWAY_ENTRY, DASHBOARD_ENTRY])
    expect(block).toContain('Nina (node-backend-supervisor)')
    expect(block).toContain('Luna (react-supervisor)')
  })

  it('lists verify commands for each entry', () => {
    const block = generateProjectLayoutBlock([GATEWAY_ENTRY])
    expect(block).toContain('npx tsc --noEmit')
    expect(block).toContain('npm test --silent')
  })

  it('renders root scope as "(root)" rather than "."', () => {
    const block = generateProjectLayoutBlock([BASELINE_ENTRY])
    expect(block).toContain('(root)')
    expect(block).not.toMatch(/\| \. \|/)
  })

  it('renders a dash for empty tech list (baseline)', () => {
    const block = generateProjectLayoutBlock([BASELINE_ENTRY])
    expect(block).toContain('—')
  })

  it('renders a dash for empty verify commands (baseline)', () => {
    const block = generateProjectLayoutBlock([BASELINE_ENTRY])
    // The verify column should show — for baseline with no commands
    const lines = block.split('\n').filter((l) => l.includes('Echo (baseline-supervisor)'))
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('—')
  })

  it('produces a valid markdown table header', () => {
    const block = generateProjectLayoutBlock([GATEWAY_ENTRY])
    expect(block).toContain('| Folder | Technology | Supervisor | Verify |')
    expect(block).toContain('|--------|')
  })
})

describe('enrichRootClaudeMd', () => {
  let tmpDir: string
  let claudeMdPath: string
  const BASE_CONTENT = '# CLAUDE.md\n\nThis repo is managed by Mars.\n'

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-project-layout-'))
    claudeMdPath = resolve(tmpDir, 'CLAUDE.md')
    writeFileSync(claudeMdPath, BASE_CONTENT, 'utf8')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appends the project layout block to an existing CLAUDE.md', () => {
    enrichRootClaudeMd(claudeMdPath, [GATEWAY_ENTRY, DASHBOARD_ENTRY])

    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain(LAYOUT_START)
    expect(content).toContain(LAYOUT_END)
    expect(content).toContain('gateway')
    expect(content).toContain('dashboard')
    expect(content).toContain(BASE_CONTENT.trimEnd())
  })

  it('re-running with the same entries is idempotent — no duplicate blocks', () => {
    enrichRootClaudeMd(claudeMdPath, [GATEWAY_ENTRY, DASHBOARD_ENTRY])
    enrichRootClaudeMd(claudeMdPath, [GATEWAY_ENTRY, DASHBOARD_ENTRY])

    const content = readFileSync(claudeMdPath, 'utf8')
    const startCount = (content.match(new RegExp(LAYOUT_START.replace(/[<>!-]/g, (c) => `\\${c}`), 'g')) ?? []).length
    const endCount = (content.match(new RegExp(LAYOUT_END.replace(/[<>!-]/g, (c) => `\\${c}`), 'g')) ?? []).length
    expect(startCount).toBe(1)
    expect(endCount).toBe(1)
  })

  it('replaces the block content on re-run with different entries', () => {
    enrichRootClaudeMd(claudeMdPath, [GATEWAY_ENTRY])
    enrichRootClaudeMd(claudeMdPath, [GATEWAY_ENTRY, DASHBOARD_ENTRY])

    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain('gateway')
    expect(content).toContain('dashboard')
    // Only one block pair
    expect(content.split(LAYOUT_START).length).toBe(2)
  })

  it('preserves all pre-existing CLAUDE.md content before the block', () => {
    enrichRootClaudeMd(claudeMdPath, [GATEWAY_ENTRY])

    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content.startsWith('# CLAUDE.md')).toBe(true)
    expect(content).toContain('This repo is managed by Mars.')
  })

  it('does nothing when entries is empty (no block appended)', () => {
    enrichRootClaudeMd(claudeMdPath, [])

    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toBe(BASE_CONTENT)
    expect(content).not.toContain(LAYOUT_START)
  })

  it('removes an existing block when re-run with empty entries', () => {
    // First run writes the block
    enrichRootClaudeMd(claudeMdPath, [GATEWAY_ENTRY])
    expect(readFileSync(claudeMdPath, 'utf8')).toContain(LAYOUT_START)

    // Second run with empty entries removes it
    enrichRootClaudeMd(claudeMdPath, [])
    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).not.toContain(LAYOUT_START)
    expect(content).not.toContain(LAYOUT_END)
  })

  it('degrades gracefully for baseline-only detection — writes a minimal block', () => {
    enrichRootClaudeMd(claudeMdPath, [BASELINE_ENTRY])

    const content = readFileSync(claudeMdPath, 'utf8')
    expect(content).toContain(LAYOUT_START)
    expect(content).toContain('Echo (baseline-supervisor)')
    expect(content).toContain('(root)')
  })
})

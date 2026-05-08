import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  acquireLock,
  runSubprocessStreaming,
  runClaudeCode,
  stripFrontmatter,
} from '../git'

describe('stripFrontmatter', () => {
  it('strips a leading YAML frontmatter block', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\nbody')).toBe('body')
  })

  it('returns text unchanged when no frontmatter is present', () => {
    expect(stripFrontmatter('no frontmatter')).toBe('no frontmatter')
  })

  it('returns text unchanged when frontmatter has no closing delimiter', () => {
    const input = '---\nname: x\nstill going'
    expect(stripFrontmatter(input)).toBe(input)
  })
})

describe('runSubprocessStreaming', () => {
  it('emits one onLine call per complete line, carrying partial chunks', async () => {
    const lines: Array<{ stream: 'stdout' | 'stderr'; line: string }> = []
    // node -e script: emits 3 stdout lines split across writes, then 1 stderr line.
    const script = `
      process.stdout.write('lin');
      setTimeout(() => process.stdout.write('e1\\nline2\\nlin'), 10);
      setTimeout(() => process.stdout.write('e3\\n'), 20);
      setTimeout(() => process.stderr.write('errline\\n'), 30);
    `
    const result = await runSubprocessStreaming(
      'node',
      ['-e', script],
      process.cwd(),
      ({ stream, line }) => {
        lines.push({ stream, line })
      },
    )
    expect(result.exitCode).toBe(0)
    expect(lines.filter((l) => l.stream === 'stdout').map((l) => l.line)).toEqual([
      'line1',
      'line2',
      'line3',
    ])
    expect(lines.filter((l) => l.stream === 'stderr').map((l) => l.line)).toEqual([
      'errline',
    ])
    expect(result.stdout).toBe('line1\nline2\nline3\n')
    expect(result.stderr).toBe('errline\n')
  })

  it('flushes a trailing partial line on close', async () => {
    const lines: string[] = []
    const result = await runSubprocessStreaming(
      'node',
      ['-e', "process.stdout.write('no-newline');"],
      process.cwd(),
      ({ stream, line }) => {
        if (stream === 'stdout') lines.push(line)
      },
    )
    expect(result.exitCode).toBe(0)
    expect(lines).toEqual(['no-newline'])
  })
})

describe('acquireLock', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(resolve(tmpdir(), 'mars-lock-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('reclaims a stale lock whose owner pid is dead', async () => {
    const lockPath = resolve(workDir, 'stale-dead.lock')
    // Pid 999999 is well above the typical PID_MAX on Linux/macOS, so
    // process.kill(pid, 0) reliably reports ESRCH.
    writeFileSync(lockPath, '999999', 'utf8')

    const start = Date.now()
    const release = await acquireLock(lockPath, 5_000)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(2_000)
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))

    await release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it('reclaims a lock file that is empty or corrupt', async () => {
    const lockPath = resolve(workDir, 'stale-empty.lock')
    writeFileSync(lockPath, '   \n', 'utf8')

    const release = await acquireLock(lockPath, 5_000)
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid))
    await release()
  })
})

describe('runClaudeCode (stubbed claude binary)', () => {
  let stubDir: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-stub-'))
    const stubPath = resolve(stubDir, 'claude')
    // Stub emits 3 fixture stream-json lines + a final result line.
    const stubScript = `#!/usr/bin/env node
const lines = [
  { type: 'system', subtype: 'init', session_id: 'stub-session-xyz' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'result', subtype: 'success', session_id: 'stub-session-xyz', total_cost_usd: 0 },
];
for (const l of lines) process.stdout.write(JSON.stringify(l) + '\\n');
`
    writeFileSync(stubPath, stubScript, 'utf8')
    chmodSync(stubPath, 0o755)
    originalPath = process.env.PATH
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('captures conversation events, session id, and invokes onEvent', async () => {
    const seen: string[] = []
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 5_000,
      onEvent: (event) => {
        seen.push(event.type)
      },
    })
    expect(r.exitCode).toBe(0)
    expect(r.sessionId).toBe('stub-session-xyz')
    expect(r.conversation).toHaveLength(4)
    expect(r.conversation.map((e) => e.type)).toEqual([
      'system',
      'assistant',
      'user',
      'result',
    ])
    expect(seen).toEqual(['system', 'assistant', 'user', 'result'])
  })
})

describe('checkMergeTargetStatus', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-target-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README'), 'hello\n')
    execFileSync('git', ['add', 'README'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports clean for an unmodified working tree', async () => {
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus()
    expect(status.kind).toBe('clean')
  })

  it('reports dirty with porcelain output when files are modified or untracked', async () => {
    writeFileSync(resolve(repo, 'README'), 'hello mutated\n')
    writeFileSync(resolve(repo, 'leftover.tmp'), 'x\n')
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus()
    expect(status.kind).toBe('dirty')
    if (status.kind === 'dirty') {
      expect(status.targetPath).toBe(repo)
      expect(status.statusOutput).toContain('README')
      expect(status.statusOutput).toContain('leftover.tmp')
    }
  })
})

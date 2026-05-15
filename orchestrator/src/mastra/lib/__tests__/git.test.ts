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
  claudeBinEnvFingerprint,
  runSubprocessStreaming,
  runClaudeCode,
  stripFrontmatter,
} from '../git'

describe('claudeBinEnvFingerprint', () => {
  it('produces identical fingerprints for identical envs', () => {
    const a = claudeBinEnvFingerprint('/opt/claude/bin/claude', '/usr/bin:/bin')
    const b = claudeBinEnvFingerprint('/opt/claude/bin/claude', '/usr/bin:/bin')
    expect(a).toBe(b)
  })

  it('produces a different fingerprint when PATH changes', () => {
    const a = claudeBinEnvFingerprint(undefined, '/usr/bin:/bin')
    const b = claudeBinEnvFingerprint(undefined, '/usr/local/bin:/usr/bin:/bin')
    expect(a).not.toBe(b)
  })

  it('produces a different fingerprint when the MARS_CLAUDE_BIN override changes', () => {
    const a = claudeBinEnvFingerprint('/opt/claude/bin/claude', '/usr/bin')
    const b = claudeBinEnvFingerprint('/opt/other/bin/claude', '/usr/bin')
    expect(a).not.toBe(b)
  })

  it('treats undefined and empty string the same so unset and "" do not collide', () => {
    // Both unset (undefined) and explicit "" normalise to '' in the key. This
    // is intentional: process.env reports unset vars as undefined and we want
    // the same cache slot for either shape.
    expect(claudeBinEnvFingerprint(undefined, '/usr/bin')).toBe(
      claudeBinEnvFingerprint('', '/usr/bin'),
    )
  })

  it('does not collide when the override/PATH boundary shifts', () => {
    // Without a separator, ('a', 'bc') and ('ab', 'c') would both produce
    // 'abc' and incorrectly hit the same cache slot. The U+0001 separator
    // keeps these distinct.
    const a = claudeBinEnvFingerprint('a', 'bc')
    const b = claudeBinEnvFingerprint('ab', 'c')
    expect(a).not.toBe(b)
  })

  it('uses a non-NUL separator so the source file stays text for ripgrep', () => {
    const fp = claudeBinEnvFingerprint('x', 'y')
    expect(fp.includes('\0')).toBe(false)
  })
})

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

  it('resolves with exit code 127 when the binary is not found instead of crashing', async () => {
    const result = await runSubprocessStreaming(
      '/this/path/does/not/exist/mars-missing-binary',
      [],
      process.cwd(),
    )
    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain('ENOENT')
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
  let stubPath: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-stub-'))
    stubPath = resolve(stubDir, 'claude')
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

  it('honours MARS_CLAUDE_BIN even when PATH does not include the stub', async () => {
    const prevBin = process.env.MARS_CLAUDE_BIN
    const prevPath = process.env.PATH
    process.env.MARS_CLAUDE_BIN = stubPath
    // Strip the stubDir from PATH so the override is the only way to find it.
    // Keep the rest of PATH so the stub's `#!/usr/bin/env node` shebang
    // still resolves `node` (this is a test-environment concern only;
    // production callers pass a real `claude` binary path).
    process.env.PATH = (prevPath ?? '')
      .split(':')
      .filter((p) => p !== stubDir)
      .join(':')
    try {
      const r = await runClaudeCode({
        cwd: process.cwd(),
        prompt: 'noop',
        timeoutMs: 5_000,
      })
      expect(r.exitCode).toBe(0)
      expect(r.sessionId).toBe('stub-session-xyz')
      expect(r.conversation).toHaveLength(4)
    } finally {
      if (prevBin === undefined) delete process.env.MARS_CLAUDE_BIN
      else process.env.MARS_CLAUDE_BIN = prevBin
      if (prevPath === undefined) delete process.env.PATH
      else process.env.PATH = prevPath
    }
  })
})

describe('runClaudeCode agent-to-user tool ban (end-to-end via stub)', () => {
  let stubDir: string
  let stubPath: string
  let argvLog: string
  let originalPath: string | undefined

  beforeAll(() => {
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-claude-deny-stub-'))
    stubPath = resolve(stubDir, 'claude')
    argvLog = resolve(stubDir, 'argv.json')
    // Stub records its argv to a file so the test can assert on the exact
    // flags the wrapper handed to the subprocess. It then completes
    // successfully without emitting an AskUserQuestion tool_use event.
    const stubScript = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'deny-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'deny-session', total_cost_usd: 0 }) + '\\n');
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

  it('hands the subprocess a --disallowedTools list that contains the agent-to-user tools', async () => {
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'If you have any clarifying questions, please ask the user.',
      timeoutMs: 5_000,
    })
    expect(r.exitCode).toBe(0)
    const argv: string[] = JSON.parse(readFileSync(argvLog, 'utf8'))
    const i = argv.indexOf('--disallowedTools')
    expect(i).toBeGreaterThanOrEqual(0)
    const denied = (argv[i + 1] ?? '').split(',')
    expect(denied).toContain('AskUserQuestion')
    expect(denied).toContain('SendUserMessage')
    // No tool_use for AskUserQuestion was emitted by the stub — the run
    // completed cleanly without an agent-to-user call.
    const askUseEvents = r.conversation.filter((e) => {
      if (e.type !== 'assistant') return false
      const content = (e as { message?: { content?: Array<{ type?: string; name?: string }> } })
        .message?.content
      return (content ?? []).some(
        (c) => c.type === 'tool_use' && c.name === 'AskUserQuestion',
      )
    })
    expect(askUseEvents).toHaveLength(0)
  })

  it('still denies the agent-to-user tools even when the caller passes its own disallowedTools', async () => {
    const r = await runClaudeCode({
      cwd: process.cwd(),
      prompt: 'noop',
      timeoutMs: 5_000,
      disallowedTools: ['Bash'],
    })
    expect(r.exitCode).toBe(0)
    const argv: string[] = JSON.parse(readFileSync(argvLog, 'utf8'))
    const i = argv.indexOf('--disallowedTools')
    const denied = (argv[i + 1] ?? '').split(',')
    expect(denied).toContain('AskUserQuestion')
    expect(denied).toContain('SendUserMessage')
    expect(denied).toContain('Bash')
  })
})

describe('checkMergeTargetStatus', () => {
  let repo: string
  const args = { integrationBranch: 'main', taskBranch: 'task/x' }

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-target-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'A'), 'a0\n')
    writeFileSync(resolve(repo, 'B'), 'b0\n')
    execFileSync('git', ['add', 'A', 'B'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    // task/x: one commit ahead of main, modifies A only.
    execFileSync('git', ['checkout', '-q', '-b', 'task/x'], { cwd: repo })
    writeFileSync(resolve(repo, 'A'), 'a1\n')
    execFileSync('git', ['commit', '-q', '-am', 'task edit on A'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports clean when ff is feasible and target is pristine', async () => {
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('clean')
  })

  it('ignores untracked files in the merge target', async () => {
    writeFileSync(resolve(repo, 'leftover.tmp'), 'x\n')
    mkdirSync(resolve(repo, '.idea'), { recursive: true })
    writeFileSync(resolve(repo, '.idea/workspace.xml'), '<x/>\n')
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('clean')
  })

  it('ignores tracked uncommitted changes on paths the ff would not touch', async () => {
    writeFileSync(resolve(repo, 'B'), 'b-mutated\n')
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('clean')
  })

  it('reports dirty when a tracked uncommitted change overlaps the ff path set', async () => {
    writeFileSync(resolve(repo, 'A'), 'a-local\n')
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('dirty')
    if (status.kind === 'dirty') {
      expect(status.targetPath).toBe(repo)
      expect(status.statusOutput).toContain('A')
      expect(status.statusOutput).toMatch(
        /tracked changes on paths the fast-forward would update/i,
      )
    }
  })

  it('reports dirty when task branch is not a fast-forward of integration', async () => {
    // Force divergence: add a main-only commit so task/x is no longer an
    // ancestor of main from main's POV.
    writeFileSync(resolve(repo, 'C'), 'c0\n')
    execFileSync('git', ['add', 'C'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'main-only commit'], { cwd: repo })
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('dirty')
    if (status.kind === 'dirty') {
      expect(status.statusOutput).toMatch(/is not a fast-forward of/i)
    }
  })
})

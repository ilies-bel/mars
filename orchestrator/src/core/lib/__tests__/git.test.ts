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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { acquireLock } from '../git/lock'
import {
  buildWorkerEnv,
  claudeBinEnvFingerprint,
  resolveClaudeBin,
  runSubprocessStreaming,
  runClaudeCode,
} from '../git/claude'
import { pathExists, resolveGitBin } from '../git/internal'
import { checkMergeTargetStatus, stripFrontmatter } from '../git/merge'
import { __resetContextCacheForTests } from '../../context'

const execAsync = promisify(execFile)

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

describe('resolveClaudeBin — Windows platform (monkey-patched)', () => {
  // These tests monkey-patch process.platform to 'win32' via Object.defineProperty
  // (process.platform is configurable in Node.js, allowing safe overrides).
  // They verify that:
  //   1. PATH is split on ';' rather than ':'
  //   2. 'claude.exe' is probed and returned when found
  //   3. POSIX fallback directories are NOT consulted

  let tempDir: string
  let originalPath: string | undefined
  let originalPlatformDescriptor: PropertyDescriptor | undefined

  beforeAll(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'mars-win-claude-'))
    // Write a shell script named claude.exe — on POSIX isExecutableFile checks
    // fs.statSync().isFile() + accessSync(X_OK), so a chmod'd script works.
    writeFileSync(resolve(tempDir, 'claude.exe'), '#!/bin/sh\n', 'utf8')
    chmodSync(resolve(tempDir, 'claude.exe'), 0o755)
    writeFileSync(resolve(tempDir, 'claude.cmd'), '@echo off\r\n', 'utf8')
    chmodSync(resolve(tempDir, 'claude.cmd'), 0o755)
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    originalPath = process.env.PATH
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    // Monkey-patch process.platform to 'win32' for the duration of each test.
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
      writable: false,
      enumerable: true,
    })
  })

  afterEach(() => {
    // Restore process.platform
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
    if (originalPath !== undefined) process.env.PATH = originalPath
    else delete process.env.PATH
  })

  it('splits PATH on ";" and returns claude.exe when it is the first probe hit', () => {
    // Semicolon-delimited Windows-style PATH: tempDir is first, then a dummy.
    // If the code were still splitting on ':', the whole string would be treated
    // as a single (non-existent) directory and 'claude' would be returned instead.
    process.env.PATH = `${tempDir};/nonexistent-dir`

    const result = resolveClaudeBin()

    expect(result).toBe(resolve(tempDir, 'claude.exe'))
  })

  it('prefers claude.exe over claude.cmd when both exist', () => {
    process.env.PATH = tempDir

    const result = resolveClaudeBin()

    expect(result).toBe(resolve(tempDir, 'claude.exe'))
  })

  it('does not probe POSIX fallback directories on Windows', () => {
    // PATH has no directories containing claude.exe/.cmd — the resolver
    // must fall back to bare 'claude' rather than searching POSIX dirs
    // like /opt/homebrew/bin, /usr/local/bin, etc.
    process.env.PATH = '/nonexistent-windows-path'

    const result = resolveClaudeBin()

    expect(result).toBe('claude')
  })
})

describe('resolveGitBin', () => {
  // We test two behaviours:
  //   1. When git is present, resolveGitBin() returns an absolute path.
  //   2. When git cannot be found, resolveGitBin() throws with a message that
  //      names the missing binary.
  //
  // Test #2 needs both PATH and the POSIX fallback dirs to lack git. We
  // monkey-patch process.platform to 'win32' to disable the POSIX fallback
  // dir probe (same technique used by the resolveClaudeBin Windows tests), then
  // set PATH to a temp dir that has no git binary.

  let tempDir: string
  let originalPath: string | undefined
  let originalPlatformDescriptor: PropertyDescriptor | undefined

  beforeAll(() => {
    tempDir = mkdtempSync(resolve(tmpdir(), 'mars-git-bin-'))
  })

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    originalPath = process.env.PATH
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  })

  afterEach(() => {
    // Restore platform
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
    // Restore PATH
    if (originalPath !== undefined) process.env.PATH = originalPath
    else delete process.env.PATH
  })

  it('returns an absolute path pointing to the git binary when git is on PATH', () => {
    // Sanity-check that the resolver works in a normal environment.
    const result = resolveGitBin()
    expect(isAbsolute(result)).toBe(true)
    expect(result).toMatch(/git(\.exe)?$/)
  })

  it('throws with a clear error message when git is not found', () => {
    // Fake Windows mode so the POSIX fallback dirs (/usr/bin, etc.) are not
    // consulted, then point PATH at a directory that has no git binary.
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
      writable: false,
      enumerable: true,
    })
    process.env.PATH = tempDir  // tempDir has no git binary

    expect(() => resolveGitBin()).toThrow('git binary not found on PATH')
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
  { type: 'result', subtype: 'success', session_id: 'stub-session-xyz' },
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
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'deny-session' }) + '\\n');
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

describe('createWorktree worktree-list timeout (dispatch stays unblocked)', () => {
  // Regression guard for the 2026-05-17 incident where ~353 corrupt
  // .git/worktrees admin entries made 'git worktree list --porcelain' hang
  // indefinitely, exhausting all implement semaphore slots and stalling
  // dispatch for ~14h. WORKTREE_GIT_TIMEOUT_MS ensures the prune/list calls
  // fail fast so createWorktree's .catch handlers recover and dispatch proceeds.
  let repo: string
  let stubDir: string
  let origPath: string | undefined

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-worktree-timeout-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README.md'), '# test\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })

    // Stub git that hangs indefinitely on worktree list/prune, simulating a
    // corrupt .git/worktrees directory. All other git commands are forwarded
    // to the real git binary found later in PATH.
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-git-stub-'))
    const stubPath = resolve(stubDir, 'git')
    const stubScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'worktree' && (args[1] === 'list' || args[1] === 'prune')) {
  // Simulate a corrupt .git/worktrees hang — the timer ensures the
  // process stays alive until the exec timeout sends SIGTERM.
  setTimeout(() => process.exit(0), 30_000);
  return;
}
// Forward all other git commands to the real binary (skip this stub dir).
const { spawnSync } = require('child_process');
const fs = require('fs');
const dirs = (process.env.PATH || '').split(':').filter(d => d !== ${JSON.stringify(stubDir)});
let realGit;
for (const dir of dirs) {
  const c = dir + '/git';
  try { fs.accessSync(c, fs.constants.X_OK); realGit = c; break; } catch {}
}
if (!realGit) { process.stderr.write('git not found\\n'); process.exit(127); }
const r = spawnSync(realGit, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
`
    writeFileSync(stubPath, stubScript, 'utf8')
    chmodSync(stubPath, 0o755)

    origPath = process.env.PATH
    process.env.PATH = `${stubDir}:${origPath ?? ''}`
    process.env.MARS_REPO = repo
    process.env.MARS_WORKTREE_GIT_TIMEOUT_MS = '300'
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_WORKTREE_GIT_TIMEOUT_MS
    if (origPath !== undefined) process.env.PATH = origPath
    rmSync(repo, { recursive: true, force: true })
    rmSync(stubDir, { recursive: true, force: true })
  })

  it('WORKTREE_GIT_TIMEOUT_MS is read from env at module load', async () => {
    const { WORKTREE_GIT_TIMEOUT_MS } = await import('../git/internal')
    expect(WORKTREE_GIT_TIMEOUT_MS).toBe(300)
  })

  it('createWorktree completes within 2× timeout even when git worktree list hangs', async () => {
    const { createWorktree } = await import('../git/worktree')
    const { WORKTREE_GIT_TIMEOUT_MS } = await import('../git/internal')
    const start = Date.now()
    // createWorktree may succeed (worktree add goes through the stub to real
    // git) or fail (other git error), but it MUST NOT hang for the duration
    // of the 30s stub timer. The prune/list timeouts ensure it fails fast and
    // the .catch handlers recover so dispatch can proceed.
    await createWorktree({
      taskId: 'timeout-test-task',
      integrationBranch: 'main',
    }).catch(() => {})
    const elapsed = Date.now() - start
    // createWorktree issues three timed-out git calls: prune + list + prune.
    // Allow 3× timeout + generous overhead for real git ops and process
    // spawn cost. The crucial assertion is that we finish far below the
    // stub's 30s hang duration — if the timeout were absent we'd take >30s.
    expect(elapsed).toBeLessThan(WORKTREE_GIT_TIMEOUT_MS * 3 + 3_000)
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
    const { checkMergeTargetStatus } = await import('../git/merge')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('clean')
  })

  it('ignores untracked files in the merge target', async () => {
    writeFileSync(resolve(repo, 'leftover.tmp'), 'x\n')
    mkdirSync(resolve(repo, '.idea'), { recursive: true })
    writeFileSync(resolve(repo, '.idea/workspace.xml'), '<x/>\n')
    const { checkMergeTargetStatus } = await import('../git/merge')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('clean')
  })

  it('reports every tracked operator edit as dirty even when the fast-forward would not touch it', async () => {
    writeFileSync(resolve(repo, 'B'), 'b-mutated\n')
    const { checkMergeTargetStatus } = await import('../git/merge')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('dirty')
    if (status.kind === 'dirty') {
      expect(status.statusOutput).toContain('B')
    }
  })

  it('reports dirty when a tracked uncommitted change overlaps the ff path set', async () => {
    writeFileSync(resolve(repo, 'A'), 'a-local\n')
    const { checkMergeTargetStatus } = await import('../git/merge')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('dirty')
    if (status.kind === 'dirty') {
      expect(status.targetPath).toBe(repo)
      expect(status.statusOutput).toContain('A')
      expect(status.statusOutput).toMatch(/tracked operator changes in the integration checkout/i)
    }
  })

  it('reports needs-rebase when task branch is not a fast-forward of integration', async () => {
    // Force divergence: add a main-only commit so task/x is no longer an
    // ancestor of main from main's POV. This is recoverable (mergeBranch
    // rebases before the ff), so it must NOT be classified as a blocking
    // 'dirty' — that conflation dead-looped lapped branches.
    writeFileSync(resolve(repo, 'C'), 'c0\n')
    execFileSync('git', ['add', 'C'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'main-only commit'], { cwd: repo })
    const { checkMergeTargetStatus } = await import('../git/merge')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('needs-rebase')
    if (status.kind === 'needs-rebase') {
      expect(status.targetPath).toBe(repo)
      expect(status.statusOutput).toMatch(/is not a fast-forward of/i)
    }
  })
})

describe('mergeBranch — working-tree-free fast-forward (update-ref)', () => {
  let repo: string
  let worktreeDir: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-branch-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    // Both README.md and src.ts committed on main
    writeFileSync(resolve(repo, 'README.md'), '# original\n')
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    // Create task branch with one commit ahead of main (changes src.ts only)
    execFileSync('git', ['checkout', '-q', '-b', 'task/ff-test'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 2\n')
    execFileSync('git', ['commit', '-q', '-am', 'task commit'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })

    // Create a developer branch that modifies README.md (so checkout back to
    // main from this branch would need to update README.md). Leave working tree
    // on this branch with a dirty README.md so that 'git checkout main' would
    // be blocked by the local modification.
    execFileSync('git', ['checkout', '-q', '-b', 'developer/wip'], { cwd: repo })
    writeFileSync(resolve(repo, 'README.md'), '# developer branch\n')
    execFileSync('git', ['commit', '-q', '-am', 'developer commit'], { cwd: repo })
    // Leave an uncommitted dirty change to README.md while on developer/wip.
    // README.md now differs between developer/wip and main. A 'git checkout main'
    // would refuse because local changes would be overwritten.
    writeFileSync(resolve(repo, 'README.md'), '# dirty developer change\n')
    // Working tree stays on developer/wip (no checkout back to main)

    // Create linked worktree for task branch
    worktreeDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-worktree-'))
    rmSync(worktreeDir, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', worktreeDir, 'task/ff-test'], { cwd: repo })

    // Ensure .mars dir exists for the lock file
    mkdirSync(resolve(repo, '.mars'), { recursive: true })

    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repo })
    } catch {}
    rmSync(worktreeDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('merges successfully even when the main working tree is on a dirty non-integration branch', async () => {
    // Precondition: git checkout main from this state WOULD fail with old code
    // because README.md has local changes that would be overwritten on checkout.
    let checkoutWouldFail = false
    try {
      execFileSync('git', ['checkout', '--dry-run', 'main'], { cwd: repo })
    } catch {
      checkoutWouldFail = true
    }
    // If the git version doesn't support --dry-run, skip this precondition check
    // and proceed — the test itself is the real guard.

    const { mergeBranch } = await import('../git/merge')
    const result = await mergeBranch({
      branch: 'task/ff-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
    })

    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)
    // The dirty working-tree change on the developer branch must be preserved
    expect(readFileSync(resolve(repo, 'README.md'), 'utf8')).toBe('# dirty developer change\n')
    // We remain on the developer/wip branch (no checkout happened)
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()
    expect(currentBranch).toBe('developer/wip')
  })

  it('never fires onVegaStart on a clean fast-forward (task stays in plain merging)', async () => {
    const { mergeBranch } = await import('../git/merge')
    let vegaStarts = 0
    const result = await mergeBranch({
      branch: 'task/ff-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVegaStart: () => {
        vegaStarts += 1
      },
    })
    expect(result.merged).toBe(true)
    expect(result.conflictResolved).toBe(false)
    // A deterministic fast-forward must never spawn Vega, so the task is never
    // flipped out of the idempotent `merging` phase.
    expect(vegaStarts).toBe(0)
  })

  it('advances the integration branch ref to the rebased task branch tip', async () => {
    const { execFile: execFileCb } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execP = promisify(execFileCb)
    const { mergeBranch } = await import('../git/merge')

    const taskTip = (await execP('git', ['rev-parse', 'task/ff-test'], { cwd: repo })).stdout.trim()

    const result = await mergeBranch({
      branch: 'task/ff-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
    })
    expect(result.merged).toBe(true)

    const mainTipAfter = (await execP('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim()
    expect(mainTipAfter).toBe(taskTip)
  })

  it('leaves the integration checkout CLEAN when the main repo is on the integration branch', async () => {
    // Regression: update-ref advances refs/heads/main without touching the
    // checkout's index. When the main repo IS on main, the merged files then
    // show as phantom staged changes, tripping the dispatch-time
    // `verify:main-dirty` guard and mass-parking the queue behind a
    // `main-commiter` recovery. mergeBranch's post-merge `git reset --keep`
    // must re-sync the checkout so `git status` is clean.
    const { execFile: execFileCb } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execP = promisify(execFileCb)

    // Put the main repo's checkout ON main with a clean tree (the developer/wip
    // setup from beforeEach leaves us elsewhere; switch to main cleanly).
    await execP('git', ['checkout', '-q', '-f', 'main'], { cwd: repo })

    const { mergeBranch } = await import('../git/merge')
    const result = await mergeBranch({
      branch: 'task/ff-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
    })
    expect(result.merged).toBe(true)

    // The checkout must be clean — no phantom staged/unstaged changes.
    const status = (
      await execP('git', ['status', '--porcelain'], { cwd: repo })
    ).stdout.trim()
    expect(status).toBe('')

    // And the merged content is actually present on disk.
    expect(readFileSync(resolve(repo, 'src.ts'), 'utf8')).toBe('const x = 2\n')
  })

  it('retries and succeeds when integration advances by one non-overlapping commit (transient race)', async () => {
    // Test (a): a single concurrent advance of main between the ancestry check
    // and the CAS causes the CAS to fail. The retry loop re-rebases the task
    // branch onto the new main tip and the CAS succeeds on the second attempt.
    //
    // We use the onBeforeFastForward seam to advance main in a deterministic
    // window (after the ancestry check, before the CAS) on the first iteration
    // only, then no-op on subsequent iterations.

    // Create a linked worktree for main so we can commit to it cleanly while
    // the main repo is checked out on developer/wip with a dirty README.md.
    const mainWt = mkdtempSync(resolve(tmpdir(), 'mars-main-advance-'))
    rmSync(mainWt, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', mainWt, 'main'], { cwd: repo })

    let callCount = 0
    const onBeforeFastForward = async () => {
      if (callCount++ > 0) return
      // Advance main by one commit that touches only concurrent.txt — no overlap
      // with the task branch's src.ts change, so the re-rebase is conflict-free.
      writeFileSync(resolve(mainWt, 'concurrent.txt'), 'concurrent change\n')
      execFileSync('git', ['add', 'concurrent.txt'], { cwd: mainWt })
      execFileSync('git', ['commit', '-q', '-m', 'concurrent advance'], { cwd: mainWt })
    }

    try {
      const { mergeBranch } = await import('../git/merge')
      const result = await mergeBranch({
        branch: 'task/ff-test',
        worktreePath: worktreeDir,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        onBeforeFastForward,
      })

      expect(result.merged).toBe(true)
      expect(result.aborted).toBe(false)
      expect(result.retriesAttempted).toBeGreaterThanOrEqual(1)

      // After a successful retry, main must equal the final rebased task tip.
      const { execFile: execFileCb } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execP = promisify(execFileCb)
      const mainTip = (await execP('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim()
      const taskTip = (await execP('git', ['rev-parse', 'task/ff-test'], { cwd: repo })).stdout.trim()
      expect(mainTip).toBe(taskTip)
    } finally {
      try { execFileSync('git', ['worktree', 'remove', '--force', mainWt], { cwd: repo }) } catch {}
      rmSync(mainWt, { recursive: true, force: true })
    }
  })

  it('aborts after exhausting retry budget when integration persistently advances', async () => {
    // Test (b): main advances on EVERY call to onBeforeFastForward, so every
    // CAS fails. After MAX_MERGE_ATTEMPTS (3) the loop returns aborted:true
    // with the "integration moved during merge" lead line, and retriesAttempted
    // equals MAX_MERGE_ATTEMPTS-1 (2).
    //
    // We also assert computeFailureSignature maps the output to the existing
    // merge:vcs-supervisor-aborted/not-fast-forward recipe so the routing is
    // stable.

    const mainWt = mkdtempSync(resolve(tmpdir(), 'mars-main-persist-'))
    rmSync(mainWt, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', mainWt, 'main'], { cwd: repo })

    let advanceCount = 0
    const onBeforeFastForward = async () => {
      // Advance main on every invocation — guarantees every CAS fails.
      const i = advanceCount++
      writeFileSync(resolve(mainWt, `advance-${i}.txt`), `advance ${i}\n`)
      execFileSync('git', ['add', '.'], { cwd: mainWt })
      execFileSync('git', ['commit', '-q', '-m', `advance ${i}`], { cwd: mainWt })
    }

    try {
      const { mergeBranch } = await import('../git/merge')
      const { computeFailureSignature } = await import('../failure-signature')
      const result = await mergeBranch({
        branch: 'task/ff-test',
        worktreePath: worktreeDir,
        integrationBranch: 'main',
        lockTimeoutMs: 5_000,
        onBeforeFastForward,
      })

      expect(result.merged).toBe(false)
      expect(result.aborted).toBe(true)
      // retriesAttempted = MAX_MERGE_ATTEMPTS - 1 (the last attempt fails
      // without incrementing the counter since it returns directly).
      expect(result.retriesAttempted).toBe(2)
      expect(result.output).toMatch(/integration moved during merge/)

      // Routing invariant: the output must still classify to not-fast-forward
      // so the vcsAbortedNotFastForwardRecipe handles it — not a new recovery.
      const sig = computeFailureSignature('merge:vcs-supervisor-aborted', result.output)
      expect(sig).toBe('merge:vcs-supervisor-aborted/not-fast-forward')
    } finally {
      try { execFileSync('git', ['worktree', 'remove', '--force', mainWt], { cwd: repo }) } catch {}
      rmSync(mainWt, { recursive: true, force: true })
    }
  })

  it('aborts immediately with retriesAttempted=0 on a divergent (non-retryable) advance', async () => {
    // Test (c): onBeforeFastForward points main at a DIVERGENT orphan SHA
    // (not a descendant of the rebase base). The CAS failure handler detects
    // the non-retryable advance and returns aborted:true without burning any
    // retry budget, so retriesAttempted stays 0.
    //
    // Also validates the raw CAS primitive: git update-ref with a wrong
    // expected-old-value always returns non-zero.

    const { execFile: execFileCb } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execP = promisify(execFileCb)

    // Build an orphan commit using git plumbing — no checkout required.
    // The empty-tree SHA is a git constant (SHA of an empty tree object).
    const orphanSha = (
      await execP(
        'git',
        ['commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'orphan'],
        { cwd: repo },
      )
    ).stdout.trim()

    // Validate the raw CAS primitive independently: update-ref with a wrong
    // expected-old-value must fail (orphanSha !== current main).
    const mainSha = (await execP('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim()
    let casError: unknown
    try {
      await execP('git', ['update-ref', 'refs/heads/main', orphanSha, orphanSha], { cwd: repo })
    } catch (e) {
      casError = e
    }
    expect(casError).toBeDefined()
    expect((await execP('git', ['rev-parse', 'main'], { cwd: repo })).stdout.trim()).toBe(mainSha)

    // Now test mergeBranch: onBeforeFastForward points main to the divergent
    // orphan SHA on its first call. The CAS fails, the handler checks ancestry
    // of the orphan from the rebase base (false), and aborts immediately.
    let called = false
    const onBeforeFastForward = async () => {
      if (called) return
      called = true
      execFileSync('git', ['update-ref', 'refs/heads/main', orphanSha], { cwd: repo })
    }

    const { mergeBranch } = await import('../git/merge')
    const result = await mergeBranch({
      branch: 'task/ff-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onBeforeFastForward,
    })

    expect(result.merged).toBe(false)
    expect(result.aborted).toBe(true)
    // Non-retryable: no retry budget consumed.
    expect(result.retriesAttempted).toBe(0)
  })
})

describe('mergeBranch — onVegaStart fires when fast-forward fails (conflict)', () => {
  let repo: string
  let worktreeDir: string
  let stubDir: string
  let prevClaudeBin: string | undefined

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-vega-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    // Task branch and main diverge on the SAME line of src.ts so a rebase of
    // the task branch onto main is guaranteed to conflict, forcing mergeBranch
    // past the deterministic fast-forward and into the Vega path.
    execFileSync('git', ['checkout', '-q', '-b', 'task/conflict'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 2\n')
    execFileSync('git', ['commit', '-q', '-am', 'task edit'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 999\n')
    execFileSync('git', ['commit', '-q', '-am', 'main edit'], { cwd: repo })

    worktreeDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-vega-wt-'))
    rmSync(worktreeDir, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', worktreeDir, 'task/conflict'], { cwd: repo })

    mkdirSync(resolve(repo, '.mars'), { recursive: true })

    // Stub Vega: a `claude` binary that emits one success result line and exits
    // 0 WITHOUT touching the in-progress rebase. The conflict therefore remains
    // unresolved, so mergeBranch aborts — but onVegaStart must already have
    // fired the moment the supervisor was spawned.
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-vega-stub-'))
    const stubPath = resolve(stubDir, 'claude')
    writeFileSync(
      stubPath,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'vega-stub' }) + '\\n');\n`,
      'utf8',
    )
    chmodSync(stubPath, 0o755)
    prevClaudeBin = process.env.MARS_CLAUDE_BIN
    process.env.MARS_CLAUDE_BIN = stubPath

    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    if (prevClaudeBin === undefined) delete process.env.MARS_CLAUDE_BIN
    else process.env.MARS_CLAUDE_BIN = prevClaudeBin
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repo })
    } catch {}
    rmSync(worktreeDir, { recursive: true, force: true })
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('fires onVegaStart exactly once when the rebase conflicts and Vega is spawned', async () => {
    const { mergeBranch } = await import('../git/merge')
    let vegaStarts = 0
    const result = await mergeBranch({
      branch: 'task/conflict',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVegaStart: () => {
        vegaStarts += 1
      },
    })
    // The fast-forward path failed and Vega was spawned: the task must be
    // flipped to vega-reconciling exactly once for the duration of the session.
    expect(vegaStarts).toBe(1)
    // The stub did not resolve the conflict, so the merge aborts.
    expect(result.merged).toBe(false)
    expect(result.aborted).toBe(true)
  })
})

describe('mergeBranch — tree-truth: aborted:false when Vega resolves rebase despite supervisor exit 1', () => {
  let repo: string
  let worktreeDir: string
  let stubDir: string
  let prevClaudeBin: string | undefined

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-tree-truth-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    // Diverge: task changes x to 2, main changes x to 999 — guaranteed conflict
    execFileSync('git', ['checkout', '-q', '-b', 'task/tree-truth'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 2\n')
    execFileSync('git', ['commit', '-q', '-am', 'task edit'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 999\n')
    execFileSync('git', ['commit', '-q', '-am', 'main edit'], { cwd: repo })

    worktreeDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-tree-truth-wt-'))
    rmSync(worktreeDir, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', worktreeDir, 'task/tree-truth'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })

    // Stub Vega: resolves the conflict by writing the task-side content, stages
    // it, runs `git rebase --continue` to completion, then exits 1 (simulates a
    // rate-limit or tool error that hits after the rebase finishes). The
    // orchestrator must use git-tree truth — preSha != postSha, rebase dir gone,
    // tree clean — and return merged:true despite the non-zero exit code.
    stubDir = mkdtempSync(resolve(tmpdir(), 'mars-vega-tree-truth-stub-'))
    const stubPath = resolve(stubDir, 'claude')
    const stubScript = `#!/usr/bin/env node
const { execFileSync } = require('child_process');
const { writeFileSync } = require('fs');
// Resolve the conflict: accept the task version of the file
writeFileSync('src.ts', 'const x = 2\\n');
// Stage the resolved file
execFileSync('git', ['add', 'src.ts'], { stdio: 'pipe' });
// Complete the rebase — GIT_EDITOR=true accepts the commit message without prompting
execFileSync('git', ['rebase', '--continue'], {
  env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
  stdio: 'pipe',
});
// Emit the Claude stream result event (stdout is parsed as JSON by the orchestrator)
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'tree-truth-stub' }) + '\\n');
// Exit non-zero — simulates a rate-limit or CLI crash that lands AFTER the rebase finishes
process.exit(1);
`
    writeFileSync(stubPath, stubScript, 'utf8')
    chmodSync(stubPath, 0o755)
    prevClaudeBin = process.env.MARS_CLAUDE_BIN
    process.env.MARS_CLAUDE_BIN = stubPath
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    if (prevClaudeBin === undefined) delete process.env.MARS_CLAUDE_BIN
    else process.env.MARS_CLAUDE_BIN = prevClaudeBin
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repo })
    } catch {}
    rmSync(worktreeDir, { recursive: true, force: true })
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns merged:true when Vega resolves the rebase despite supervisor exiting with code 1', async () => {
    const { mergeBranch } = await import('../git/merge')
    const result = await mergeBranch({
      branch: 'task/tree-truth',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
    })
    // Tree-truth: preSha !== postSha, rebase dir gone, tree clean → success,
    // even though the supervisor CLI exited with code 1.
    expect(result.merged).toBe(true)
    expect(result.aborted).toBe(false)
    // The resolved content (task version) must be present
    expect(readFileSync(resolve(repo, 'src.ts'), 'utf8')).toBe('const x = 2\n')
  })
})

// Real-boundary verification: PATH must survive every subprocess spawn path
// so that git (and other binaries) are findable in the child process.
//
// Acceptance criteria:
//   - every spawn/exec call either passes no env (inherits process.env) or
//     passes an env that spreads process.env first — both patterns are tested.
//   - no call site sets env to an object that omits PATH.
describe('subprocess PATH preservation', () => {
  it('runSubprocessStreaming with no explicit env can find git via PATH', async () => {
    // No env argument → spawn receives process.env → git is resolvable.
    const result = await runSubprocessStreaming('git', ['--version'], process.cwd())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^git version/)
  })

  it('runSubprocessStreaming with buildWorkerEnv() can find git via PATH', async () => {
    // buildWorkerEnv() spreads process.env first (preserving PATH) then
    // strips CLAUDE* session vars.  Passing it to runSubprocessStreaming must
    // not break PATH resolution.
    const result = await runSubprocessStreaming(
      'git',
      ['--version'],
      process.cwd(),
      undefined,
      undefined,
      buildWorkerEnv(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^git version/)
  })

  it('buildWorkerEnv() includes PATH from process.env', () => {
    // Guard: if PATH were absent from buildWorkerEnv() the real-boundary
    // test above would pass only because spawn falls back to its own lookup.
    // This assertion confirms the env object itself carries PATH.
    const env = buildWorkerEnv()
    expect(env.PATH).toBe(process.env.PATH)
  })
})

describe('attachToOriginWorktree (recovery attaches to origin worktree)', () => {
  // A recovery (kind=fix) task does not carve its own worktree — it attaches
  // to the origin task's existing worktree + branch so it can stack its fix
  // commit on the origin's in-progress work. These tests provision a real
  // origin worktree via createWorktree, then assert attach returns that ref
  // when present and throws OriginWorktreeMissingError when it is gone.
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-attach-origin-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README.md'), '# test\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the origin worktree ref when the origin worktree is present', async () => {
    const { createWorktree, attachToOriginWorktree } = await import('../git/worktree')
    // Provision the origin task's worktree exactly as setup-worktree would.
    const origin = await createWorktree({
      taskId: 'mars-origin01',
      integrationBranch: 'main',
    })

    const ref = await attachToOriginWorktree({
      originTaskId: 'mars-origin01',
      originBranch: origin.branch,
      originWorktreePath: origin.path,
    })
    // Attach is a validate-and-return: same path + branch, no new worktree.
    expect(ref.path).toBe(origin.path)
    expect(ref.branch).toBe(origin.branch)
    expect(ref.branch).toBe('task/mars-origin01')
  })

  it('throws OriginWorktreeMissingError when the origin worktree is gone', async () => {
    const { createWorktree, removeWorktree, attachToOriginWorktree, OriginWorktreeMissingError } =
      await import('../git/worktree')
    const origin = await createWorktree({
      taskId: 'mars-origin02',
      integrationBranch: 'main',
    })
    // Simulate the cleaned-up-after-merge case: the origin worktree is removed.
    await removeWorktree({ path: origin.path, branch: origin.branch }, true, false)

    await expect(
      attachToOriginWorktree({
        originTaskId: 'mars-origin02',
        originBranch: origin.branch,
        originWorktreePath: origin.path,
      }),
    ).rejects.toBeInstanceOf(OriginWorktreeMissingError)
  })

  it('throws OriginWorktreeMissingError when the path exists but is on a different branch', async () => {
    const { createWorktree, attachToOriginWorktree, OriginWorktreeMissingError } =
      await import('../git/worktree')
    const origin = await createWorktree({
      taskId: 'mars-origin03',
      integrationBranch: 'main',
    })
    // Ask attach for a branch that does not match the worktree's registration.
    await expect(
      attachToOriginWorktree({
        originTaskId: 'mars-origin03',
        originBranch: 'task/some-other-branch',
        originWorktreePath: origin.path,
      }),
    ).rejects.toBeInstanceOf(OriginWorktreeMissingError)
  })

  // Integration test B: manually delete the worktree directory but leave the
  // branch intact, then assert the recovery pipeline reaches its code step
  // without error and the worktree directory now exists on disk.
  it('rebuilds the worktree when the directory is pruned from disk but the branch still exists (integration B)', async () => {
    const { createWorktree, attachToOriginWorktree } = await import('../git/worktree')
    const origin = await createWorktree({
      taskId: 'mars-origin04',
      integrationBranch: 'main',
    })

    // Simulate the directory being pruned (crash / disk cleanup) without the
    // branch being deleted — the branch's commits are still reachable.
    rmSync(origin.path, { recursive: true, force: true })
    expect(existsSync(origin.path)).toBe(false)

    // Recovery: attachToOriginWorktree should rebuild the worktree in-place.
    const ref = await attachToOriginWorktree({
      originTaskId: 'mars-origin04',
      originBranch: origin.branch,
      originWorktreePath: origin.path,
    })

    // The recovery proceeds without error and returns the same path + branch.
    expect(ref.path).toBe(origin.path)
    expect(ref.branch).toBe(origin.branch)
    // The worktree directory now exists — the rebuild ran exactly once.
    expect(existsSync(origin.path)).toBe(true)
  })

  // Unit test: when both the directory AND the branch are gone (fully cleaned
  // up), the helper must throw RecoveryNeedsOriginRestart — which extends
  // OriginWorktreeMissingError so the existing action-queue escalation path
  // in the setup primitive still fires.
  it('throws RecoveryNeedsOriginRestart when both the directory and the branch are gone', async () => {
    const {
      createWorktree,
      removeWorktree,
      attachToOriginWorktree,
      RecoveryNeedsOriginRestart,
      OriginWorktreeMissingError,
    } = await import('../git/worktree')
    const origin = await createWorktree({
      taskId: 'mars-origin05',
      integrationBranch: 'main',
    })
    // removeWorktree with keepBranch=false deletes both the directory and the branch.
    await removeWorktree({ path: origin.path, branch: origin.branch }, true, false)

    await expect(
      attachToOriginWorktree({
        originTaskId: 'mars-origin05',
        originBranch: origin.branch,
        originWorktreePath: origin.path,
      }),
    ).rejects.toBeInstanceOf(RecoveryNeedsOriginRestart)

    // Also verify it is still an OriginWorktreeMissingError so the existing
    // catch handler in the setup primitive escalates it to the action queue.
    await expect(
      attachToOriginWorktree({
        originTaskId: 'mars-origin05',
        originBranch: origin.branch,
        originWorktreePath: origin.path,
      }),
    ).rejects.toBeInstanceOf(OriginWorktreeMissingError)
  })
})

describe('mergeBranch — no-rebase-state guard: does not spawn Vega when git rebase exits non-zero without creating state', () => {
  // Acceptance criterion: when git rebase exits non-zero but leaves NO
  // rebase-merge/ or rebase-apply/ directory (i.e. the rebase was blocked
  // before it could conflict — e.g. uncommitted changes in the worktree),
  // mergeBranch must:
  //   1. NOT call onVegaStart (Vega is not spawned)
  //   2. Return merged:false, aborted:true
  //   3. Set output to a first-line that begins "rebase produced no in-progress state"
  //   4. Produce a classifiable failure signature (not /unclassified)

  let repo: string
  let worktreeDir: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-merge-nostate-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 1\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

    // Task branch: changes src.ts to x = 2
    execFileSync('git', ['checkout', '-q', '-b', 'task/no-state-test'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 2\n')
    execFileSync('git', ['commit', '-q', '-am', 'task commit'], { cwd: repo })

    // Main: changes src.ts to x = 999 (would conflict on rebase)
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })
    writeFileSync(resolve(repo, 'src.ts'), 'const x = 999\n')
    execFileSync('git', ['commit', '-q', '-am', 'main commit'], { cwd: repo })

    // Create linked worktree for task branch
    worktreeDir = mkdtempSync(resolve(tmpdir(), 'mars-merge-nostate-wt-'))
    rmSync(worktreeDir, { recursive: true, force: true })
    execFileSync('git', ['worktree', 'add', worktreeDir, 'task/no-state-test'], { cwd: repo })

    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreeDir], { cwd: repo })
    } catch {}
    rmSync(worktreeDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('aborts without spawning Vega when git rebase fails before creating rebase-merge/ state', async () => {
    // Inject an unstaged change in the worktree. `git rebase` refuses to
    // start when there are unstaged changes — it exits non-zero with
    // "cannot rebase: You have unstaged changes." and does NOT create a
    // rebase-merge/ or rebase-apply/ directory. The guard must detect
    // isRebaseInProgress()=false and abort with a classifiable message
    // instead of dispatching Vega with a false-premise prompt.
    writeFileSync(resolve(worktreeDir, 'src.ts'), 'const x = dirty\n')

    const { mergeBranch } = await import('../git/merge')
    const { computeFailureSignature } = await import('../failure-signature')

    let vegaStarts = 0
    const result = await mergeBranch({
      branch: 'task/no-state-test',
      worktreePath: worktreeDir,
      integrationBranch: 'main',
      lockTimeoutMs: 5_000,
      onVegaStart: () => {
        vegaStarts += 1
      },
    })

    // Guard fires: Vega must NOT be spawned
    expect(vegaStarts).toBe(0)
    // Merge must abort (not succeed)
    expect(result.merged).toBe(false)
    expect(result.aborted).toBe(true)
    // First-line of output must name the real cause
    expect(result.output).toMatch(/rebase produced no in-progress state/)
    // The output must classify to the named slug, NOT /unclassified, so it
    // routes to the Investigator rather than first-principles recovery.
    const sig = computeFailureSignature('merge:vcs-supervisor-aborted', result.output)
    expect(sig).toBe('merge:vcs-supervisor-aborted/rebase-no-in-progress-state')
  })
})

describe('co-located git coverage', () => {
  describe('pathExists', () => {
    let scratch: string

    beforeAll(async () => {
      scratch = await mkdtemp(join(tmpdir(), 'mars-git-pathexists-'))
    })

    afterAll(async () => {
      await rm(scratch, { recursive: true, force: true })
    })

    it('returns true for an existing file', async () => {
      const file = join(scratch, 'file.txt')
      await writeFile(file, 'hi', 'utf8')
      await expect(pathExists(file)).resolves.toBe(true)
    })

    it('returns true for an existing directory', async () => {
      const dir = join(scratch, 'dir')
      await mkdir(dir)
      await expect(pathExists(dir)).resolves.toBe(true)
    })

    it('returns false for a path that does not exist', async () => {
      const ghost = join(scratch, 'does-not-exist')
      await expect(pathExists(ghost)).resolves.toBe(false)
    })

    it('returns false for an empty string', async () => {
      await expect(pathExists('')).resolves.toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Helpers shared by checkMergeTargetStatus tests
  // ---------------------------------------------------------------------------

  /** Initialise a bare-minimum git repo in `dir` with one initial commit. */
  async function initRepo(dir: string): Promise<void> {
    await execAsync('git', ['init', '-b', 'main'], { cwd: dir })
    await execAsync('git', ['config', 'user.email', 'test@mars.local'], { cwd: dir })
    await execAsync('git', ['config', 'user.name', 'Mars Test'], { cwd: dir })
    // An initial commit is required so branch names resolve to commits.
    await writeFile(join(dir, 'README.md'), 'init')
    await execAsync('git', ['add', 'README.md'], { cwd: dir })
    await execAsync('git', ['commit', '-m', 'initial'], { cwd: dir })
  }

  /** Create a branch and add one commit that writes `fileName` with `content`. */
  async function addBranchCommit(
    dir: string,
    branch: string,
    fileName: string,
    content: string,
  ): Promise<void> {
    await execAsync('git', ['checkout', '-b', branch], { cwd: dir })
    await writeFile(join(dir, fileName), content)
    await execAsync('git', ['add', fileName], { cwd: dir })
    await execAsync('git', ['commit', '-m', `add ${fileName}`], { cwd: dir })
  }

  // ---------------------------------------------------------------------------
  // checkMergeTargetStatus
  // ---------------------------------------------------------------------------

  describe('checkMergeTargetStatus', () => {
    let repoDir: string
    const origMarsRepo = process.env.MARS_REPO

    beforeEach(async () => {
      repoDir = await mkdtemp(join(tmpdir(), 'mars-check-merge-'))
      await initRepo(repoDir)

      // Point the orchestrator context at the tmp repo so repoRoot() resolves
      // to repoDir instead of the real project root.
      process.env.MARS_REPO = repoDir
      __resetContextCacheForTests()
    })

    afterEach(async () => {
      if (origMarsRepo === undefined) {
        delete process.env.MARS_REPO
      } else {
        process.env.MARS_REPO = origMarsRepo
      }
      __resetContextCacheForTests()
      await rm(repoDir, { recursive: true, force: true })
    })

    it('returns kind:needs-rebase when integration branch has moved past the task branch base', async () => {
      // task/abc is created from main, adds one commit, then main advances
      // → main is no longer an ancestor of task/abc (diverged)
      await addBranchCommit(repoDir, 'task/abc', 'task-work.txt', 'task')
      // Back on main, advance it
      await execAsync('git', ['checkout', 'main'], { cwd: repoDir })
      await writeFile(join(repoDir, 'main-extra.txt'), 'extra')
      await execAsync('git', ['add', 'main-extra.txt'], { cwd: repoDir })
      await execAsync('git', ['commit', '-m', 'advance main'], { cwd: repoDir })

      const result = await checkMergeTargetStatus({
        integrationBranch: 'main',
        taskBranch: 'task/abc',
      })

      expect(result.kind).toBe('needs-rebase')
      if (result.kind === 'needs-rebase') {
        expect(result.statusOutput).toMatch(/not a fast-forward/)
      }
    })

    it('returns kind:dirty when tracked files on ff paths have uncommitted changes on integration', async () => {
      // shared.txt exists on main; task/abc modifies it; main has an
      // uncommitted modification of the same file → tracked-dirty
      await writeFile(join(repoDir, 'shared.txt'), 'original')
      await execAsync('git', ['add', 'shared.txt'], { cwd: repoDir })
      await execAsync('git', ['commit', '-m', 'add shared'], { cwd: repoDir })

      // task/abc modifies shared.txt (main IS an ancestor of task/abc)
      await addBranchCommit(repoDir, 'task/abc', 'shared.txt', 'modified by task')

      // Back on main: dirty (tracked) modification, NOT committed
      await execAsync('git', ['checkout', 'main'], { cwd: repoDir })
      await writeFile(join(repoDir, 'shared.txt'), 'dirty on main')

      const result = await checkMergeTargetStatus({
        integrationBranch: 'main',
        taskBranch: 'task/abc',
      })

      expect(result.kind).toBe('dirty')
      if (result.kind === 'dirty') {
        expect(result.statusOutput).toContain('tracked operator changes in the integration checkout')
      }
    })

    it('returns kind:clean when integration is an ancestor of task branch and working tree is clean', async () => {
      // task/abc adds a new file that doesn't exist on main → the diff path is
      // untracked on integration → status is empty → clean
      await addBranchCommit(repoDir, 'task/abc', 'new-feature.txt', 'feature work')
      await execAsync('git', ['checkout', 'main'], { cwd: repoDir })

      const result = await checkMergeTargetStatus({
        integrationBranch: 'main',
        taskBranch: 'task/abc',
      })

      expect(result.kind).toBe('clean')
    })
  })
})

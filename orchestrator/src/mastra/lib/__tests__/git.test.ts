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
  detectTemplatePaths,
  TEMPLATE_LEAKAGE_PREFIX,
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
    const { WORKTREE_GIT_TIMEOUT_MS } = await import('../git')
    expect(WORKTREE_GIT_TIMEOUT_MS).toBe(300)
  })

  it('createWorktree completes within 2× timeout even when git worktree list hangs', async () => {
    const { createWorktree, WORKTREE_GIT_TIMEOUT_MS } = await import('../git')
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

  it('reports needs-rebase when task branch is not a fast-forward of integration', async () => {
    // Force divergence: add a main-only commit so task/x is no longer an
    // ancestor of main from main's POV. This is recoverable (mergeBranch
    // rebases before the ff), so it must NOT be classified as a blocking
    // 'dirty' — that conflation dead-looped lapped branches.
    writeFileSync(resolve(repo, 'C'), 'c0\n')
    execFileSync('git', ['add', 'C'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'main-only commit'], { cwd: repo })
    const { checkMergeTargetStatus } = await import('../git')
    const status = await checkMergeTargetStatus(args)
    expect(status.kind).toBe('needs-rebase')
    if (status.kind === 'needs-rebase') {
      expect(status.targetPath).toBe(repo)
      expect(status.statusOutput).toMatch(/is not a fast-forward of/i)
    }
  })
})

describe('detectTemplatePaths (unit)', () => {
  it('returns an empty array when no paths are under the template prefix', () => {
    expect(detectTemplatePaths(['src/foo.ts', 'README.md', 'orchestrator/src/init/scaffold.ts'])).toEqual([])
  })

  it('returns template paths that are directly under the prefix', () => {
    const result = detectTemplatePaths([
      'orchestrator/src/init/templates/CLAUDE.md',
      'src/index.ts',
    ])
    expect(result).toEqual(['orchestrator/src/init/templates/CLAUDE.md'])
  })

  it('returns nested template paths', () => {
    const result = detectTemplatePaths([
      'orchestrator/src/init/templates/claude/skills/mars:deep-reflect/SKILL.md',
      'orchestrator/src/init/scaffold.ts',
    ])
    expect(result).toEqual([
      'orchestrator/src/init/templates/claude/skills/mars:deep-reflect/SKILL.md',
    ])
  })

  it('returns all template paths when multiple are present', () => {
    const result = detectTemplatePaths([
      'orchestrator/src/init/templates/CLAUDE.md',
      'orchestrator/src/init/templates/claude/skills/mars:deep-reflect/SKILL.md',
      'src/unrelated.ts',
    ])
    expect(result).toHaveLength(2)
    expect(result).toContain('orchestrator/src/init/templates/CLAUDE.md')
    expect(result).toContain('orchestrator/src/init/templates/claude/skills/mars:deep-reflect/SKILL.md')
  })

  it('does not match a path that merely contains "templates" elsewhere', () => {
    expect(detectTemplatePaths(['src/templates/foo.ts', 'lib/email-templates/bar.ts'])).toEqual([])
  })

  it('TEMPLATE_LEAKAGE_PREFIX is the expected sentinel string', () => {
    expect(TEMPLATE_LEAKAGE_PREFIX).toBe('orchestrator/src/init/templates/')
  })
})

describe('detectTemplatePaths with getChangedFiles (integration)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(resolve(tmpdir(), 'mars-tmpl-leak-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
    writeFileSync(resolve(repo, 'README.md'), 'init\n')
    execFileSync('git', ['add', '.'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('detects template leakage when branch diff contains orchestrator/src/init/templates/ paths', async () => {
    // Simulate a coder run that "reconciled" the inlined CLAUDE.md back to
    // the template file — the exact systematic leak from the incident.
    execFileSync('git', ['checkout', '-q', '-b', 'task/leak-test'], { cwd: repo })
    const templatesDir = resolve(repo, 'orchestrator/src/init/templates')
    mkdirSync(templatesDir, { recursive: true })
    writeFileSync(resolve(templatesDir, 'CLAUDE.md'), '# leaked\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'leaked template edit'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })

    const { getChangedFiles, detectTemplatePaths: detect } = await import('../git')
    const changed = await getChangedFiles(repo, 'main', 'task/leak-test')
    expect(detect(changed)).toEqual(['orchestrator/src/init/templates/CLAUDE.md'])
  })

  it('passes when branch diff contains no template paths', async () => {
    execFileSync('git', ['checkout', '-q', '-b', 'task/clean'], { cwd: repo })
    mkdirSync(resolve(repo, 'orchestrator/src'), { recursive: true })
    writeFileSync(resolve(repo, 'orchestrator/src/index.ts'), 'export const x = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['commit', '-q', '-m', 'legit change'], { cwd: repo })
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo })

    const { getChangedFiles, detectTemplatePaths: detect } = await import('../git')
    const changed = await getChangedFiles(repo, 'main', 'task/clean')
    expect(detect(changed)).toEqual([])
  })
})

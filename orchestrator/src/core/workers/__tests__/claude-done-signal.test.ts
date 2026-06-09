import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { installClaudeStopHook, waitForClaudeDone } from '../claude-done-signal'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mars-done-signal-test-'))
}

function statusFile(cwd: string, sessionId: string): string {
  return path.join(cwd, '.mars', 'pty-status', `${sessionId}.json`)
}

// ---------------------------------------------------------------------------
// installClaudeStopHook
// ---------------------------------------------------------------------------

describe('installClaudeStopHook', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates .claude/settings.json with a Stop hook entry', () => {
    installClaudeStopHook(tmpDir, 'session-abc')

    const settingsPath = path.join(tmpDir, '.claude', 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(settings).toHaveProperty('hooks')
    const hooks = settings.hooks as Record<string, unknown>
    expect(hooks).toHaveProperty('Stop')
    expect(Array.isArray(hooks.Stop)).toBe(true)
  })

  it('hook command is a shell command of type "command"', () => {
    installClaudeStopHook(tmpDir, 'session-abc')

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> } }

    const hookEntry = settings.hooks.Stop[0].hooks[0]
    expect(hookEntry.type).toBe('command')
    expect(typeof hookEntry.command).toBe('string')
  })

  it('hook command references the sessionId-namespaced status file path', () => {
    installClaudeStopHook(tmpDir, 'session-xyz')

    const settings = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ type: string; command: string }> }> } }

    const { command } = settings.hooks.Stop[0].hooks[0]
    expect(command).toContain('session-xyz')
    expect(command).toContain(path.join('.mars', 'pty-status', 'session-xyz.json'))
  })

  it('different sessionIds produce different status file paths', () => {
    installClaudeStopHook(tmpDir, 'session-A')
    const settingsA = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }
    const commandA = settingsA.hooks.Stop[0].hooks[0].command

    installClaudeStopHook(tmpDir, 'session-B')
    const settingsB = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }
    const commandB = settingsB.hooks.Stop[0].hooks[0].command

    expect(commandA).not.toBe(commandB)
    expect(commandA).toContain('session-A')
    expect(commandB).toContain('session-B')
  })

  it('merges Stop hook into existing settings.json without discarding other keys', () => {
    const settingsDir = path.join(tmpDir, '.claude')
    fs.mkdirSync(settingsDir, { recursive: true })
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'mars statusline' } }),
      'utf8',
    )

    installClaudeStopHook(tmpDir, 'session-abc')

    const settings = JSON.parse(
      fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(settings).toHaveProperty('statusLine')  // preserved
    expect((settings.hooks as Record<string, unknown>)).toHaveProperty('Stop')  // added
  })
})

// ---------------------------------------------------------------------------
// waitForClaudeDone
// ---------------------------------------------------------------------------

describe('waitForClaudeDone', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resolves when the status file is written mid-test (simulating the hook firing)', async () => {
    const sessionId = 'sess-123'
    const controller = new AbortController()

    const promise = waitForClaudeDone(tmpDir, sessionId, controller.signal)

    // Simulate the Stop hook writing the status file
    const sf = statusFile(tmpDir, sessionId)
    fs.writeFileSync(sf, JSON.stringify({ ts: Date.now() }), 'utf8')

    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves immediately if the status file already exists before watching', async () => {
    const sessionId = 'sess-existing'
    const sf = statusFile(tmpDir, sessionId)
    fs.mkdirSync(path.dirname(sf), { recursive: true })
    fs.writeFileSync(sf, JSON.stringify({ ts: Date.now() }), 'utf8')

    const controller = new AbortController()
    await expect(waitForClaudeDone(tmpDir, sessionId, controller.signal)).resolves.toBeUndefined()
  })

  it('rejects with AbortError when the signal fires before the file appears', async () => {
    const sessionId = 'sess-abort'
    const controller = new AbortController()

    const promise = waitForClaudeDone(tmpDir, sessionId, controller.signal)
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately when passed an already-aborted signal', async () => {
    const sessionId = 'sess-pre-abort'
    const controller = new AbortController()
    controller.abort()

    await expect(
      waitForClaudeDone(tmpDir, sessionId, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('writing a different session file does not resolve the watcher for another session', async () => {
    const sessionA = 'sess-a'
    const sessionB = 'sess-b'
    const controllerB = new AbortController()

    // Watch only session B
    const promiseB = waitForClaudeDone(tmpDir, sessionB, controllerB.signal)

    // Write session A's file — directory was created by waitForClaudeDone above
    const fileA = statusFile(tmpDir, sessionA)
    fs.writeFileSync(fileA, JSON.stringify({ ts: Date.now() }), 'utf8')

    // Session B's watcher must NOT resolve because sess-a.json !== sess-b.json
    const raceResult = await Promise.race([
      promiseB.then((): string => 'resolved'),
      new Promise<string>((r) => setTimeout(() => r('not-resolved'), 120)),
    ])
    expect(raceResult).toBe('not-resolved')

    controllerB.abort()
    await expect(promiseB).rejects.toMatchObject({ name: 'AbortError' })
  })
})

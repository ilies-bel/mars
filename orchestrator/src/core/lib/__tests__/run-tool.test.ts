import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  nullTraceStore,
  runTool,
  truncateForTrace,
} from '../run-tool'
import { openTraceEventStore } from '../trace-events-store'

const tmpDbPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-run-tool-'))
  return join(dir, 'mars.db')
}

describe('runTool — capture, severity, truncation, timeout', () => {
  it('captures stdout and writes a tool_invoked trace event (severity=info on exit 0)', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const r = await runTool(
        {
          tool: 'node',
          argv: ['-e', 'process.stdout.write("hello-mars")'],
          cwd: process.cwd(),
          taskId: 'task-1',
          originId: 'task-1',
          phase: 'setup',
        },
        store,
      )
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toBe('hello-mars')
      expect(r.stderr).toBe('')
      expect(typeof r.traceEventId).toBe('string')
      expect(r.traceEventId.length).toBeGreaterThan(0)

      const events = await store.query({ taskId: 'task-1' })
      expect(events).toHaveLength(1)
      const e = events[0]
      expect(e.kind).toBe('tool_invoked')
      expect(e.severity).toBe('info')
      expect(e.phase).toBe('setup')
      expect(e.payload.tool).toBe('node')
      expect(e.payload.argv).toEqual(['-e', 'process.stdout.write("hello-mars")'])
      expect(e.payload.exitCode).toBe(0)
      expect(e.payload.stdout).toBe('hello-mars')
      expect(e.payload.expectsFailure).toBe(false)
      expect(typeof e.payload.durationMs).toBe('number')
    } finally {
      await store.close()
    }
  })

  it('non-zero exit is severity=warn by default and severity=info with expectsFailure', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // Default (no expectsFailure): unexpected failure → warn.
      const a = await runTool(
        {
          tool: 'node',
          argv: ['-e', 'process.exit(7)'],
          cwd: process.cwd(),
          taskId: 't-warn',
        },
        store,
      )
      expect(a.exitCode).toBe(7)

      // expectsFailure=true: probe designed to exit nonzero → info, not warn.
      const b = await runTool(
        {
          tool: 'node',
          argv: ['-e', 'process.exit(3)'],
          cwd: process.cwd(),
          taskId: 't-info',
          expectsFailure: true,
        },
        store,
      )
      expect(b.exitCode).toBe(3)

      const warns = await store.query({ taskId: 't-warn' })
      expect(warns).toHaveLength(1)
      expect(warns[0].severity).toBe('warn')
      expect(warns[0].payload.exitCode).toBe(7)

      const infos = await store.query({ taskId: 't-info' })
      expect(infos).toHaveLength(1)
      expect(infos[0].severity).toBe('info')
      expect(infos[0].payload.exitCode).toBe(3)
      expect(infos[0].payload.expectsFailure).toBe(true)
    } finally {
      await store.close()
    }
  })

  it('truncates stdout > 8 KB in the trace payload but keeps result.stdout intact', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      // Emit 20 KB of stdout in a deterministic head/tail pattern so we can
      // assert the marker line lands between them.
      const script = `
        const head = 'A'.repeat(10000);
        const tail = 'Z'.repeat(10000);
        process.stdout.write(head + tail);
      `
      const r = await runTool(
        {
          tool: 'node',
          argv: ['-e', script],
          cwd: process.cwd(),
          taskId: 'trunc',
        },
        store,
      )
      expect(r.exitCode).toBe(0)
      expect(r.stdout.length).toBe(20_000)
      expect(r.stdout.startsWith('A'.repeat(100))).toBe(true)
      expect(r.stdout.endsWith('Z'.repeat(100))).toBe(true)

      const events = await store.query({ taskId: 'trunc' })
      expect(events).toHaveLength(1)
      const tracedStdout = events[0].payload.stdout
      expect(typeof tracedStdout).toBe('string')
      const traced = tracedStdout as string
      expect(traced.length).toBeLessThan(20_000)
      expect(traced).toMatch(/\n\.\.\.truncated \d+ bytes\.\.\.\n/)
      // The head and tail must both survive truncation.
      expect(traced.startsWith('A')).toBe(true)
      expect(traced.endsWith('Z')).toBe(true)
    } finally {
      await store.close()
    }
  })

  it('SIGTERMs a process that exceeds timeoutMs and marks stderr', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      const r = await runTool(
        {
          tool: 'node',
          argv: [
            '-e',
            // Sleep for ~10s. The timeoutMs of 200 should SIGTERM well before this resolves.
            'setTimeout(() => process.exit(0), 10000)',
          ],
          cwd: process.cwd(),
          taskId: 'timeout',
          timeoutMs: 200,
        },
        store,
      )
      // 143 (128+15, SIGTERM) is what Node maps a SIGTERM exit to; SIGKILL
      // grace can promote it to 137 on slower hosts.
      expect([137, 143]).toContain(r.exitCode)
      expect(r.stderr).toContain('[runTool: killed after 200ms]')
      // Wall-clock budget: 200ms timeout + 2s SIGKILL grace + jitter.
      expect(r.durationMs).toBeLessThan(5_000)
      expect(r.durationMs).toBeGreaterThanOrEqual(150)

      const events = await store.query({ taskId: 'timeout' })
      expect(events).toHaveLength(1)
      const e = events[0]
      expect(e.severity).toBe('warn') // expectsFailure not set → unexpected nonzero → warn
      const tracedStderr = e.payload.stderr as string
      expect(tracedStderr).toContain('[runTool: killed after 200ms]')
    } finally {
      await store.close()
    }
  })

  it('throws cleanly for a non-existent binary and does NOT write a trace', async () => {
    const store = await openTraceEventStore(tmpDbPath())
    try {
      await expect(
        runTool(
          {
            tool: 'mars-this-binary-does-not-exist',
            argv: ['--version'],
            cwd: process.cwd(),
            taskId: 'enoent',
          },
          store,
        ),
      ).rejects.toThrow(/spawn .*mars-this-binary-does-not-exist/)
      const events = await store.query({ taskId: 'enoent' })
      expect(events).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it('null trace store accepts the call without writing anywhere', async () => {
    // Lib callers outside a workflow (CLI admin paths) pass `nullTraceStore`
    // so the API stays uniform. The call still works; nothing is persisted.
    const r = await runTool(
      {
        tool: 'node',
        argv: ['-e', 'process.stdout.write("noop")'],
        cwd: process.cwd(),
      },
      nullTraceStore,
    )
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('noop')
  })
})

describe('truncateForTrace', () => {
  it('passes short strings through unchanged', () => {
    expect(truncateForTrace('short')).toBe('short')
    expect(truncateForTrace('')).toBe('')
  })

  it('keeps head + tail + marker for oversized inputs', () => {
    const big = `${'H'.repeat(5000)}${'T'.repeat(5000)}`
    const out = truncateForTrace(big)
    expect(out.length).toBeLessThan(big.length)
    expect(out).toMatch(/\n\.\.\.truncated \d+ bytes\.\.\.\n/)
    expect(out.startsWith('H')).toBe(true)
    expect(out.endsWith('T')).toBe(true)
  })
})

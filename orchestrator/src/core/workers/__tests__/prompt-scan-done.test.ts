import { describe, it, expect, vi } from 'vitest'
import type { PtyHandle } from '../../lib/pty/spawn'
import { watchPromptScan } from '../prompt-scan-done'

// ---------------------------------------------------------------------------
// Fake PtyHandle — simulates a pty whose data we control in tests.
// ---------------------------------------------------------------------------

function makeFakeHandle(): {
  handle: PtyHandle
  emit: (chunk: string) => void
} {
  let buffer = ''
  const dataListeners: Array<(chunk: string) => void> = []

  const emit = (chunk: string): void => {
    buffer += chunk
    for (const cb of dataListeners) {
      cb(chunk)
    }
  }

  const handle: PtyHandle = {
    write: vi.fn(),
    kill: vi.fn(),
    onData(cb: (chunk: string) => void): void {
      dataListeners.push(cb)
    },
    onExit: vi.fn(),
    buffer: (): string => buffer,
  }

  return { handle, emit }
}

// ---------------------------------------------------------------------------
// watchPromptScan — behaviour tests
// ---------------------------------------------------------------------------

describe('watchPromptScan', () => {
  it('resolves when spinnerOverride then promptPrefix appear in the buffer', async () => {
    const { handle, emit } = makeFakeHandle()
    const spec = { promptPrefix: '$ ', spinnerOverride: /\[spinner done\]/ }
    const promise = watchPromptScan(handle, spec, new AbortController().signal)

    emit('Running task...\n')
    emit('[spinner done]\n')
    emit('$ ')  // prompt returns — completion condition met

    await expect(promise).resolves.toBeUndefined()
  })

  it('resolves when spinnerOverride and promptPrefix arrive in a single chunk', async () => {
    const { handle, emit } = makeFakeHandle()
    const spec = { promptPrefix: '>>> ', spinnerOverride: /✓ done/ }
    const promise = watchPromptScan(handle, spec, new AbortController().signal)

    emit('output\n✓ done\n>>> ')

    await expect(promise).resolves.toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Negative: promptPrefix before spinnerOverride must NOT trigger resolution
  // -------------------------------------------------------------------------
  it('does not resolve when promptPrefix appears before spinnerOverride', async () => {
    const { handle, emit } = makeFakeHandle()
    const spec = { promptPrefix: '$ ', spinnerOverride: /\[spinner\]/ }
    const controller = new AbortController()
    const promise = watchPromptScan(handle, spec, controller.signal)

    emit('$ ')            // prompt appears first — no spinner yet
    emit('some output\n')

    const result = await Promise.race([
      promise.then((): string => 'resolved'),
      new Promise<string>((r) => setTimeout(() => r('not-resolved'), 50)),
    ])

    expect(result).toBe('not-resolved')
    controller.abort()
  })

  // -------------------------------------------------------------------------
  // Negative: long silence after spinner with no promptPrefix must NOT resolve
  // (this is the "no quiescence shortcut" requirement — no idle timer)
  // -------------------------------------------------------------------------
  it('does not resolve on long silent gaps with no promptPrefix (no quiescence shortcut)', async () => {
    const { handle, emit } = makeFakeHandle()
    const spec = { promptPrefix: '$ ', spinnerOverride: /\[spinner\]/ }
    const controller = new AbortController()
    const promise = watchPromptScan(handle, spec, controller.signal)

    // Spinner is seen, then silence — prompt never arrives
    emit('[spinner]\n')
    emit('still processing...\n')
    emit('more output...\n')
    // No more data events after this point (simulates a long silent gap)

    const result = await Promise.race([
      promise.then((): string => 'resolved'),
      new Promise<string>((r) => setTimeout(() => r('not-resolved'), 80)),
    ])

    expect(result).toBe('not-resolved')
    controller.abort()
  })

  // -------------------------------------------------------------------------
  // AbortSignal handling
  // -------------------------------------------------------------------------
  it('rejects when the AbortSignal fires before the completion condition is met', async () => {
    const { handle } = makeFakeHandle()
    const spec = { promptPrefix: '$ ', spinnerOverride: /\[spinner\]/ }
    const controller = new AbortController()
    const promise = watchPromptScan(handle, spec, controller.signal)

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects immediately when passed an already-aborted signal', async () => {
    const { handle } = makeFakeHandle()
    const spec = { promptPrefix: '$ ', spinnerOverride: /\[spinner\]/ }
    const controller = new AbortController()
    controller.abort()

    await expect(
      watchPromptScan(handle, spec, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  // -------------------------------------------------------------------------
  // Only fires via onData — no polling
  // -------------------------------------------------------------------------
  it('only registers via onData and never uses setInterval', async () => {
    const { handle, emit } = makeFakeHandle()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const spec = { promptPrefix: '$ ', spinnerOverride: /done/ }
    const controller = new AbortController()

    const promise = watchPromptScan(handle, spec, controller.signal)
    emit('done\n$ ')

    await promise
    expect(setIntervalSpy).not.toHaveBeenCalled()
    setIntervalSpy.mockRestore()
  })
})

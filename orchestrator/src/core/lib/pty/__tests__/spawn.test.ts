import { describe, expect, it } from 'vitest'
import { spawnPty } from '../spawn'

describe('spawnPty', () => {
  it('captures stdout output and reports exit code 0', () =>
    new Promise<void>((resolve, reject) => {
      const handle = spawnPty(
        process.execPath,
        ['-e', "process.stdout.write('hi'); process.exit(0)"],
        { cwd: process.cwd() },
      )

      handle.onExit((code) => {
        try {
          expect(handle.buffer()).toBe('hi')
          expect(code).toBe(0)
          resolve()
        } catch (err) {
          reject(err)
        }
      })
    }))

  it('exposes write and kill APIs without attach or stdio passthrough', () => {
    const handle = spawnPty(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      { cwd: process.cwd() },
    )

    expect(typeof handle.write).toBe('function')
    expect(typeof handle.kill).toBe('function')
    expect(typeof handle.onData).toBe('function')
    expect(typeof handle.onExit).toBe('function')
    expect(typeof handle.buffer).toBe('function')
    // non-attachable: no attach() or stdio passthrough on the handle
    expect((handle as unknown as Record<string, unknown>)['attach']).toBeUndefined()
    expect((handle as unknown as Record<string, unknown>)['stdin']).toBeUndefined()
    expect((handle as unknown as Record<string, unknown>)['stdout']).toBeUndefined()

    handle.kill()
  })
})

/**
 * Behavioural coverage for the verify admission lane.
 *
 * A verify is deliberately modelled with a real child process: production
 * verifies run commands such as `npm test`, not an in-memory callback.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { acquire, makeSem, release } from '../semaphore'

const execFileAsync = promisify(execFile)

describe('verify admission', () => {
  it('runs no more test commands than the configured verify cap', async () => {
    const verify = makeSem(2)
    let running = 0
    let peak = 0

    const runVerify = async (): Promise<void> => {
      await acquire(verify)
      running += 1
      peak = Math.max(peak, running)
      try {
        await execFileAsync(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20)'])
      } finally {
        running -= 1
        release(verify)
      }
    }

    await Promise.all(Array.from({ length: 5 }, runVerify))

    expect(peak).toBe(2)
  })

  it('lets another task continue coding while a verify waits for its slot', async () => {
    const implement = makeSem(2)
    const verify = makeSem(1)
    let releaseFirstVerify!: () => void
    const firstVerifyFinished = new Promise<void>((resolve) => {
      releaseFirstVerify = resolve
    })

    const reachVerify = async (hold: boolean): Promise<void> => {
      await acquire(implement)
      // This is the daemon's verify handoff: a task stops consuming its
      // implement permit before it queues behind the verify admission lane.
      release(implement)
      await acquire(verify)
      try {
        if (hold) await firstVerifyFinished
      } finally {
        release(verify)
      }
    }

    const first = reachVerify(true)
    await Promise.resolve()
    const blocked = reachVerify(false)
    await Promise.resolve()

    let codingStarted = false
    const coding = (async () => {
      await acquire(implement)
      codingStarted = true
      release(implement)
    })()

    await coding
    expect(codingStarted).toBe(true)

    releaseFirstVerify()
    await Promise.all([first, blocked])
  })
})

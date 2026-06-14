import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { log, setBusLogSink, type BusLogEntry } from '../log'

describe('bus/log', () => {
  // Silence stderr during tests so noise doesn't pollute output.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    // Clear any sink from a previous test.
    setBusLogSink(null)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    setBusLogSink(null)
  })

  describe('with no sink registered', () => {
    it('writes to stderr and does not throw', () => {
      expect(() => log('warn', 'hello world')).not.toThrow()
      expect(stderrSpy).toHaveBeenCalledOnce()
      const written = stderrSpy.mock.calls[0][0] as string
      expect(written).toContain('[bus warn]')
      expect(written).toContain('hello world')
    })

    it('includes serialised meta in the stderr line when present', () => {
      log('error', 'something failed', { code: 42 })
      const written = stderrSpy.mock.calls[0][0] as string
      expect(written).toContain('{"code":42}')
    })

    it('omits the meta segment when meta is undefined', () => {
      log('info', 'clean line')
      const written = stderrSpy.mock.calls[0][0] as string
      expect(written).not.toContain('{')
    })
  })

  describe('with a sink registered', () => {
    it('calls the sink with level, msg, and fields when meta is present', () => {
      const received: BusLogEntry[] = []
      setBusLogSink((entry) => received.push(entry))

      log('warn', 'x', { a: 1 })

      expect(received).toHaveLength(1)
      expect(received[0]).toEqual({ level: 'warn', msg: 'x', fields: { a: 1 } })
    })

    it('calls the sink without fields when meta is absent', () => {
      const received: BusLogEntry[] = []
      setBusLogSink((entry) => received.push(entry))

      log('info', 'no meta')

      expect(received).toHaveLength(1)
      expect(received[0]).toEqual({ level: 'info', msg: 'no meta' })
      expect(Object.prototype.hasOwnProperty.call(received[0], 'fields')).toBe(false)
    })

    it('still writes to stderr in addition to the sink (tee behaviour)', () => {
      setBusLogSink(() => {})
      log('error', 'tee me')
      expect(stderrSpy).toHaveBeenCalledOnce()
    })

    it('swallows a synchronous sink error without throwing', () => {
      setBusLogSink(() => {
        throw new Error('sink exploded')
      })
      expect(() => log('warn', 'should not throw')).not.toThrow()
    })

    it('clears the sink when setBusLogSink(null) is called', () => {
      const received: BusLogEntry[] = []
      setBusLogSink((entry) => received.push(entry))
      setBusLogSink(null)

      log('warn', 'after clear')

      expect(received).toHaveLength(0)
    })

    it('supports fire-and-forget async sinks (trace-store pattern)', async () => {
      // Simulates the daemon wiring: the sink internally fires an async
      // record() and swallows errors.
      const recorded: Array<{ level: string; msg: string; source: string }> = []

      setBusLogSink(({ level, msg, fields }) => {
        // Fire-and-forget, exactly as the daemon does.
        Promise.resolve()
          .then(() => {
            recorded.push({ level, msg, source: 'bus' })
            void fields // acknowledge fields without using them in this stub
          })
          .catch(() => {})
      })

      log('warn', 'async sink test', { extra: true })

      // Yield so the microtask queue flushes.
      await Promise.resolve()

      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toEqual({ level: 'warn', msg: 'async sink test', source: 'bus' })
    })
  })
})

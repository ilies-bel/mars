import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import { loadDaemonConfig } from '../config'

describe('daemon concurrency caps', () => {
  beforeEach(() => {
    delete process.env.MARS_MAX_VERIFY
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env.MARS_MAX_VERIFY
    __resetContextCacheForTests()
  })

  it('reads the documented MARS_MAX_VERIFY environment cap', () => {
    process.env.MARS_MAX_VERIFY = '1'

    expect(loadDaemonConfig().caps.verify).toBe(1)
  })
})
